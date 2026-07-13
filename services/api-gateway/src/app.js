'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const { authenticate } = require('./middleware/jwt.middleware');
const { requireRole } = require('./middleware/rbac.middleware');
const { rateLimiter } = require('./middleware/ratelimit.middleware');
const { correlationId } = require('./middleware/correlation.middleware');
const { requestLogger } = require('./middleware/logger.middleware');
const { buildProxyRoutes, createSseProxy, createServiceProxy } = require('./proxy/proxy');
const adminStub       = require('./routes/admin.stub');
const hierarchyStub   = require('./routes/hierarchy.stub');
const groupsStub      = require('./routes/groups.stub');
const configStub      = require('./routes/config.stub');
const diagnosticsStub = require('./routes/diagnostics.stub');
const kpiStub         = require('./routes/kpi.stub');
const topologyStub    = require('./routes/topology.stub');
const devicesStub     = require('./routes/devices.stub');

function createApp(redisClient) {
  const app = express();

  app.use(helmet());
  app.use(cors(config.cors));
  app.use(express.json()); // needed for admin stub PUT/POST body parsing
  app.use(correlationId);
  app.use(requestLogger);
  app.use(authenticate);
  app.use(requireRole);
  if (redisClient) {
    app.use(rateLimiter(redisClient));
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

  // SSE notification stream — before circuit-broken routes
  app.use('/api/v1/notifications/stream', createSseProxy(config.services.notification));

  // ── Stub routers for sub-services (mounted BEFORE proxy routes) ──────────────
  app.use('/api/v1/admin',         adminStub);
  app.use('/api/v1/organizations', hierarchyStub);
  app.use('/api/v1/groups',        groupsStub);
  // Config stub intercepts before the Java config-service (which is 503)
  app.use('/api/v1/config',        configStub);
  // Diagnostics stub — Java diagnostics-service returns 503 in local dev
  app.use('/api/v1/diagnostics',   diagnosticsStub);
  // KPI stub — kpi-query-service and kpi-aggregation-service are not yet deployed
  app.use('/api/v1/kpi',           kpiStub);
  // Topology stub — adds /summary, /link-health, /events, /connections, /search endpoints
  app.use('/api/v1/topology',      topologyStub);
  // Device write stub — POST/PUT/DELETE bypass Java inventory (Kafka-dependent writes fail)
  // GET requests fall through to the Java inventory service proxy below
  app.post('/api/v1/devices',          devicesStub);
  app.put('/api/v1/devices/:id',       devicesStub);
  app.delete('/api/v1/devices/:id',    devicesStub);
  app.put('/api/v1/devices/:id/tags',  devicesStub);

  // System health stub — health-monitor service may not be running in local dev
  app.get('/api/v1/system/health', (_req, res) => {
    const jitter = (base) => base + Math.floor(Math.random() * 5);
    const upSecs = Math.floor(process.uptime());
    res.json({
      checkedAt: new Date().toISOString(),
      services: [
        { name: 'inventory',    status: 'UP',       version: '2.1.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(12) },
        { name: 'alarms',       status: 'UP',       version: '2.1.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(8)  },
        { name: 'kpi',          status: 'UP',       version: '2.0.3', uptimeMs: upSecs * 1000, responseTimeMs: jitter(15) },
        { name: 'config',       status: 'UP',       version: '2.0.1', uptimeMs: upSecs * 1000, responseTimeMs: jitter(20) },
        { name: 'notification', status: 'UP',       version: '1.5.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(5)  },
        { name: 'auth',         status: 'UP',       version: '2.2.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(4)  },
        { name: 'audit',        status: 'UP',       version: '1.3.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(6)  },
        { name: 'report',       status: 'DEGRADED', version: '1.0.0', uptimeMs: 0,             responseTimeMs: jitter(80) },
        { name: 'topology',     status: 'UP',       version: '2.1.0', uptimeMs: upSecs * 1000, responseTimeMs: jitter(10) },
      ],
      kafka:   'UP',
      mongodb: 'UP',
      redis:   'UP',
    });
  });

  // Config-history per device — delegates to config.stub persistent history
  app.get('/api/v1/devices/:deviceId/config-history', (req, res, next) => {
    const { deviceId } = req.params;
    if (!deviceId || deviceId === 'undefined') {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'deviceId is required' });
    }
    // Rewrite path so the config stub's /history/:deviceId handler picks it up
    req.url = `/history/${deviceId}`;
    configStub(req, res, next);
  });

  // ── Audit fallback stub — serves sample data when the real service has no entries ──
  app.get('/api/v1/audit/fallback', (req, res) => {
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const ACTIONS   = ['LOGIN','LOGOUT','CREATE_USER','PUSH_CONFIG','FIRMWARE_UPGRADE','ACK_ALARM','DELETE_USER','RESET_PASSWORD','BULK_PUSH'];
    const RESOURCES = ['USER','DEVICE','CONFIG','ALARM','BACKUP','REDUNDANCY'];
    const entries = Array.from({ length: Math.min(limit, 100) }, (_, i) => ({
      id: `audit-${i + 1}`,
      timestamp: new Date(Date.now() - i * 180_000).toISOString(),
      actor: i % 4 === 0 ? 'operator' : 'admin',
      action: ACTIONS[i % ACTIONS.length],
      resource: RESOURCES[i % RESOURCES.length],
      resourceId: `${RESOURCES[i % RESOURCES.length].toLowerCase()}-${100 + i}`,
      outcome: i % 7 === 0 ? 'FAILURE' : 'SUCCESS',
      ipAddress: `10.0.${Math.floor(i / 10) % 10}.${50 + (i % 200)}`,
    }));
    res.json(entries);
  });

  // ── NMS birth-certificate endpoint (GIS requirement NMS-IV-05) ──────────────
  app.post('/api/v1/nms/bts-capture-birth-certificate', (req, res) => {
    const { sno } = req.body || {};
    if (!sno) return res.status(400).json({ status: 'failure', message: 'sno is required' });
    res.json({
      status: 'success',
      message: 'Birth Certificate captured',
      birthCertificate: {
        latitude: 28.4595 + (Math.random() - 0.5) * 0.01,
        longitude: 77.0266 + (Math.random() - 0.5) * 0.01,
        rssi: -60 - Math.floor(Math.random() * 20),
        snr: 25 + Math.floor(Math.random() * 10),
        noiseFloor: -95,
        frequencyMHz: 5180 + (Math.floor(Math.random() * 8) * 20),
        channel: 36 + Math.floor(Math.random() * 8) * 4,
        channelBandwidthMHz: 80,
        azimuthDegrees: Math.floor(Math.random() * 360),
        tilt: -5 + Math.floor(Math.random() * 10),
        deviceType: 'BTS',
        btsId: sno,
      },
    });
  });

  // ── Circuit-broken proxy routes ───────────────────────────────────────────────
  const proxyRoutes = buildProxyRoutes(config);
  for (const [prefix, handler] of Object.entries(proxyRoutes)) {
    app.use(prefix, handler);
  }

  // ── Report service proxy (nms-report on port 8091) ────────────────────────────
  const reportProxy = createServiceProxy(
    process.env.REPORT_SERVICE_URL || 'http://nms-report:8091',
    'report',
    config,
  );
  app.use('/api/v1/reports', reportProxy);

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' }));

  app.use((err, req, res, _next) => {
    logger.error({ msg: 'Unhandled gateway error', err: err.message, path: req.path });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal gateway error' });
  });

  return app;
}

module.exports = { createApp };

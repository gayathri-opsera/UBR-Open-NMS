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
const dashboardsStub  = require('./routes/dashboards.stub');
const { createProvisionHandler } = require('./routes/provision.stub');
const { listIgnored, addIgnored, removeIgnored } = require('./routes/ignore.stub');
const frameworkProductDefinitions = require('./routes/frameworkProductDefinitions');
const frameworkSecurity           = require('./routes/frameworkSecurity.routes');
const frameworkParameters         = require('./routes/frameworkParameters.routes');
const framework                   = require('./routes/framework.routes');
// Alarms router — proxies to local alarm-service when ALARM_SERVICE_URL is local,
// otherwise serves stub data to avoid CORS/auth issues with the external Opsera dev env.
const alarmsRoutes    = require('./routes/alarms.routes');

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
  // Alarms — proxies to local alarm-service (with stub fallback for external envs).
  app.use('/api/v1/alarms',        alarmsRoutes);
  app.use('/api/v1/admin',         adminStub);
  app.use('/api/v1/organizations', hierarchyStub);
  app.use('/api/v1/groups',        groupsStub);
  // Custom dashboards — persisted to MongoDB so they survive browser/device changes
  app.use('/api/v1/dashboards',    dashboardsStub);
  // Framework Product Definitions — proxied to product-definition-service with RBAC.
  // Mounted at both the legacy v1 path and the canonical framework path (WO-004).
  // The WO-004 path (/api/framework/v1/product-definitions) is the authoritative
  // endpoint for all northbound consumers; the v1 path remains for backward compat.
  app.use('/api/v1/framework/product-definitions', frameworkProductDefinitions);
  app.use('/api/framework/v1/product-definitions', frameworkProductDefinitions);

  // WO-005: Framework Security — Credential Reference API
  // Exposes northbound-safe credential reference CRUD under the protected framework route group.
  // All routes require SuperAdmin capability; secrets are write-only and stored AES-256-GCM encrypted.
  app.use('/api/framework/v1/security/credential-references', frameworkSecurity);
  app.use('/api/v1/framework/security/credential-references', frameworkSecurity); // legacy alias

  // WO-006: Framework Parameter Visibility — Device Parameter Routes
  // Server-side role filtering of parameter groups and parameters based on uiVisibleTo metadata.
  app.use('/api/framework/v1/devices', frameworkParameters);
  app.use('/api/v1/framework/devices', frameworkParameters); // legacy alias

  // WO-007: Read-Only Framework API Routes
  // Device framework identity, discovery run results, guided failures, security status.
  // Mounted under the same protected path group — JWT + framework RBAC is enforced per-route.
  app.use('/api/framework/v1', framework);
  app.use('/api/v1/framework', framework); // legacy alias

  // Config stub intercepts before the Java config-service (which is 503)
  app.use('/api/v1/config',        configStub);
  // Diagnostics stub — Java diagnostics-service returns 503 in local dev
  app.use('/api/v1/diagnostics',   diagnosticsStub);
  // KPI stub — kpi-query-service and kpi-aggregation-service are not yet deployed
  app.use('/api/v1/kpi',           kpiStub);
  // Topology stub — adds /summary, /link-health, /events, /connections, /search endpoints
  app.use('/api/v1/topology',      topologyStub);
  // Device stub — GET merges Java inventory (BTS/CPE) with MongoDB IDU devices;
  // POST/PUT/DELETE bypass Java inventory (Kafka-dependent writes fail there).
  app.get('/api/v1/devices',           devicesStub);
  app.post('/api/v1/devices',          devicesStub);
  app.put('/api/v1/devices/:id',       devicesStub);
  app.delete('/api/v1/devices/:id',    devicesStub);
  app.put('/api/v1/devices/:id/tags',  devicesStub);

  // Discovery provision stub — intercepts POST /api/v1/discovery/runs/:runId/provision
  // before the discovery-service proxy so SNMP-discovered devices are written to MongoDB
  // (same store as the devices stub) and immediately appear in inventory + topology.
  app.post('/api/v1/discovery/runs/:runId/provision', createProvisionHandler(config));

  // Discovery ignore stub — persists admin-suppressed IPs to MongoDB so ignored devices
  // are filtered out of discovery results and never surfaced in inventory/topology.
  app.get('/api/v1/discovery/ignore',        listIgnored);
  app.post('/api/v1/discovery/ignore',       addIgnored);
  app.delete('/api/v1/discovery/ignore/:ip', removeIgnored);

  // ── Dev-only: deduplicate devices collection by IP address ───────────────────
  // POST /api/v1/admin/devices/dedup-by-ip
  // Removes all but the most-recently-updated document per IP from ubrnms.devices.
  // Safe to call repeatedly (idempotent). Primarily needed after the admin
  // provisioned the same SNMP device multiple times before the "already provisioned"
  // guard was in place.
  app.post('/api/v1/admin/devices/dedup-by-ip', async (req, res) => {
    const mongoose = require('mongoose');
    try {
      const col = mongoose.connection.readyState === 1
        ? mongoose.connection.db.collection('devices')
        : null;
      if (!col) return res.status(503).json({ code: 'DB_UNAVAILABLE', message: 'MongoDB not connected' });

      const all = await col.find({}).toArray();

      // Group docs by ipAddress; keep the one with the latest updatedAt.
      const byIp = new Map();
      const noIp = [];
      for (const d of all) {
        if (!d.ipAddress) { noIp.push(d); continue; }
        const prev = byIp.get(d.ipAddress);
        const dTime   = new Date(d.updatedAt || d.createdAt || 0).getTime();
        const prevTime = prev ? new Date(prev.updatedAt || prev.createdAt || 0).getTime() : -1;
        if (!prev || dTime >= prevTime) byIp.set(d.ipAddress, d);
      }

      // Collect _ids to DELETE (everything NOT in the keeper set).
      const keepIds = new Set([
        ...byIp.values(),
        ...noIp,
      ].map((d) => String(d._id)));
      const toDelete = all.filter((d) => !keepIds.has(String(d._id))).map((d) => d._id);

      let removed = 0;
      if (toDelete.length > 0) {
        const result = await col.deleteMany({ _id: { $in: toDelete } });
        removed = result.deletedCount;
      }

      logger.info(`[dedup] Removed ${removed} duplicate device records (${byIp.size} unique IPs kept)`);
      return res.json({ removed, kept: keepIds.size, message: `Removed ${removed} duplicate records` });
    } catch (err) {
      logger.error('[dedup] Failed:', err.message);
      return res.status(500).json({ code: 'ERROR', message: err.message });
    }
  });

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

  // ── Test Harness proxy (nms-test-harness on port 3009) ────────────────────────
  const testHarnessProxy = createServiceProxy(
    process.env.TEST_HARNESS_URL || 'http://nms-test-harness:3009',
    'test-harness',
    config,
  );
  app.use('/api/test-harness', testHarnessProxy);

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' }));

  app.use((err, req, res, _next) => {
    logger.error({ msg: 'Unhandled gateway error', err: err.message, path: req.path });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal gateway error' });
  });

  return app;
}

module.exports = { createApp };

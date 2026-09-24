'use strict';
/**
 * Alarms router — proxies to the local alarm-service when ALARM_SERVICE_URL
 * resolves to a local host, otherwise falls back to stub data.
 *
 * The frontend fetchAlarms() expects a plain JSON array for GET /api/v1/alarms.
 * The Java alarm-service returns List<Alarm> which serializes as a JSON array
 * matching that expectation exactly.
 *
 * Query-param mapping (frontend → backend):
 *   state     → state  (ACTIVE | ACKNOWLEDGED | CLEARED)
 *   severity  → severity (may be repeated or comma-separated)
 *   deviceId  → deviceId
 *   networkId → networkId
 *   from / to → Instant filters for time-range queries
 */

const http   = require('http');
const https  = require('https');
const router = require('express').Router();
const logger = require('../utils/logger');

const ALARM_SERVICE_URL = process.env.ALARM_SERVICE_URL || 'http://localhost:8083';
const IS_LOCAL = /localhost|127\.0\.0\.1|0\.0\.0\.0|nms-alarm|alarm-service/.test(ALARM_SERVICE_URL);

// ── Stub data (fallback when alarm service is unreachable) ────────────────────
const STUB_ALARMS = [
  {
    id: 'ALM-001', alarmId: 'ALM-001',
    deviceId: 'SN-cisco-sw-core-01', deviceType: 'SWITCH',
    alarmType: 'CPU_THRESHOLD', alarmName: 'CPU Utilisation Threshold Exceeded',
    severity: 'MAJOR', state: 'ACTIVE', source: 'THRESHOLD',
    description: 'CPU utilisation at 87% for more than 5 minutes.',
    metricValue: 87, threshold: 85,
    raisedAt: new Date(Date.now() - 23 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  },
  {
    id: 'ALM-002', alarmId: 'ALM-002',
    deviceId: 'SN-cisco-sw-core-01', deviceType: 'SWITCH',
    alarmType: 'RSSI_LOW', alarmName: 'RSSI Below Warning Threshold',
    severity: 'WARNING', state: 'ACTIVE', source: 'SNMP',
    description: 'Received signal strength −82 dBm is below WARNING threshold.',
    metricValue: -82, threshold: -80,
    raisedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'ALM-003', alarmId: 'ALM-003',
    deviceId: 'SN-bts-north-01', deviceType: 'BTS',
    alarmType: 'DEVICE_UNREACHABLE', alarmName: 'Device Unreachable',
    severity: 'CRITICAL', state: 'ACTIVE', source: 'SNMP',
    description: 'ICMP probe failed 5 consecutive times.',
    raisedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  },
];

// ── Proxy helper: forward request to alarm service ────────────────────────────
function proxyToAlarmService(req, res, path, method = 'GET', body = null) {
  const url = new URL(ALARM_SERVICE_URL);
  const isHttps = url.protocol === 'https:';
  const port = url.port || (isHttps ? 443 : 80);

  // Translate frontend query params to alarm-service params.
  // Frontend sends: state, severity (array), deviceId, networkId, from, to
  const qs = new URLSearchParams();
  const { state, severity, deviceId, networkId, from, to } = req.query;
  if (state)     qs.set('state',     String(state));
  if (deviceId)  qs.set('deviceId',  String(deviceId));
  if (networkId) qs.set('networkId', String(networkId));
  if (from)      qs.set('from',      String(from));
  if (to)        qs.set('to',        String(to));
  // severity can be a single string or an array
  if (severity) {
    const sevList = Array.isArray(severity) ? severity : String(severity).split(',');
    // The alarm service GET /alarms accepts a single ?severity= param
    if (sevList.length === 1) qs.set('severity', sevList[0]);
    // If multiple severities are requested, send the first one;
    // full multi-value filter is a future enhancement.
    else qs.set('severity', sevList[0]);
  }

  const fullPath = `${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const opts = {
    hostname: url.hostname,
    port:     parseInt(port, 10),
    path:     fullPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': req.correlationId || '',
      ...(req.user && { 'X-User-Id': req.user.sub || '', 'X-User-Role': req.user.role || '' }),
    },
    timeout: 8000,
  };

  const transport = isHttps ? https : http;
  const proxyReq = transport.request(opts, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      res.status(proxyRes.statusCode).json(parsed);
    });
  });

  proxyReq.on('error', (err) => {
    logger.warn(`alarm-service proxy error — falling back to stub: ${err.message}`);
    res.json(STUB_ALARMS);
  });

  proxyReq.on('timeout', () => {
    logger.warn('alarm-service proxy timeout — falling back to stub');
    proxyReq.destroy();
    res.json(STUB_ALARMS);
  });

  if (body) proxyReq.write(JSON.stringify(body));
  proxyReq.end();
}

// ── GET /api/v1/alarms ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms');
  } else {
    // External Opsera dev environment — serve stub to avoid CORS/auth issues
    const { state, severity, deviceId } = req.query;
    let alarms = [...STUB_ALARMS];
    if (state)     alarms = alarms.filter((a) => a.state    === String(state).toUpperCase());
    if (severity)  alarms = alarms.filter((a) => a.severity === String(severity).toUpperCase());
    if (deviceId)  alarms = alarms.filter((a) => a.deviceId === deviceId);
    res.json(alarms);
  }
});

// ── GET /api/v1/alarms/summary ────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms/summary');
  } else {
    res.json({
      totalActive: STUB_ALARMS.filter((a) => a.state === 'ACTIVE').length,
      bySeverity: { CRITICAL: 1, MAJOR: 1, MINOR: 0, WARNING: 1, CLEAR: 0 },
      lastUpdated: new Date().toISOString(),
    });
  }
});

// ── GET /api/v1/alarms/top-reported ──────────────────────────────────────────
router.get('/top-reported', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms/top-reported', 'GET');
  } else {
    res.json([{ alarmType: 'CPU_THRESHOLD', count: 14 }, { alarmType: 'DEVICE_UNREACHABLE', count: 3 }]);
  }
});

// ── GET /api/v1/alarms/type-counts ───────────────────────────────────────────
router.get('/type-counts', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms/type-counts', 'GET');
  } else {
    res.json({ CPU_THRESHOLD: 1, DEVICE_UNREACHABLE: 1, RSSI_LOW: 1 });
  }
});

// ── GET /api/v1/alarms/thresholds ────────────────────────────────────────────
router.get('/thresholds', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms/thresholds');
  } else {
    res.json([]);
  }
});

// ── POST /api/v1/alarms/thresholds ───────────────────────────────────────────
router.post('/thresholds', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, '/api/v1/alarms/thresholds', 'POST', req.body);
  } else {
    res.status(503).json({ error: 'Threshold creation requires local alarm-service' });
  }
});

// ── GET /api/v1/alarms/export ─────────────────────────────────────────────────
router.get('/export', (req, res) => {
  if (IS_LOCAL) {
    // Stream the export directly from alarm service
    const url = new URL(ALARM_SERVICE_URL);
    const qs  = new URLSearchParams(req.query).toString();
    const opts = {
      hostname: url.hostname,
      port:     parseInt(url.port || 80, 10),
      path:     `/api/v1/alarms/export${qs ? '?' + qs : ''}`,
      method:   'GET',
      headers:  { 'X-Correlation-Id': req.correlationId || '' },
    };
    http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }).on('error', () => res.status(503).send('Export unavailable')).end();
  } else {
    res.status(503).send('Export requires local alarm-service');
  }
});

// ── GET /api/v1/alarms/stream — SSE stream ────────────────────────────────────
router.get('/stream', (_req, res) => res.status(204).send());

// ── PUT /api/v1/alarms/:id/acknowledge ───────────────────────────────────────
router.put('/:id/acknowledge', (req, res) => {
  if (IS_LOCAL) {
    const qs = req.query.actor ? `?actor=${encodeURIComponent(req.query.actor)}` : '';
    proxyToAlarmService(req, res, `/api/v1/alarms/${req.params.id}/acknowledge${qs}`, 'PUT', null);
  } else {
    res.json({ id: req.params.id, state: 'ACKNOWLEDGED', acknowledgedBy: req.query.actor || 'admin' });
  }
});

// ── GET /api/v1/alarms/:id ────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  if (IS_LOCAL) {
    proxyToAlarmService(req, res, `/api/v1/alarms/${req.params.id}`);
  } else {
    const alarm = STUB_ALARMS.find((a) => a.id === req.params.id);
    if (!alarm) return res.status(404).json({ code: 'NOT_FOUND', message: `Alarm '${req.params.id}' not found` });
    res.json(alarm);
  }
});

module.exports = router;

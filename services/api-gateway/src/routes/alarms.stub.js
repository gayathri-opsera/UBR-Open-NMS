'use strict';
/**
 * Alarms stub router — returns realistic alarm data when the alarm-service is
 * not reachable locally (or ALARM_SERVICE_URL points to the Opsera dev environment).
 *
 * Without this stub, the gateway proxies /api/v1/alarms to the configured
 * ALARM_SERVICE_URL.  In Opsera-hosted environments that URL is an external
 * domain (ubr-nms-frontend-dev.agent.opsera.dev) that:
 *   1. Requires Opsera-specific auth — local JWTs return 401.
 *   2. Does not allow localhost CORS origins — browser gets a CORS error.
 *
 * This stub is mounted BEFORE the proxy routes so local dev always gets clean data.
 *
 * Endpoints mirrored from the Java alarm-service:
 *   GET  /api/v1/alarms          — paginated alarm list
 *   GET  /api/v1/alarms/:id      — single alarm
 *   PUT  /api/v1/alarms/:id/ack  — acknowledge alarm
 *   GET  /api/v1/alarms/summary  — severity counts
 *   GET  /api/v1/alarms/stream   — SSE stream (returns 204 — use real SSE proxy for this)
 */

const router = require('express').Router();

// ── Realistic stub alarms ─────────────────────────────────────────────────────
const BASE_ALARMS = [
  {
    id: 'ALM-001',
    deviceId: 'SN-cisco-sw-core-01',
    deviceIp: '192.168.65.254',
    hostname: 'cisco-sw-core-01',
    severity: 'MAJOR',
    category: 'PERFORMANCE',
    title: 'CPU Utilisation Threshold Exceeded',
    description: 'CPU utilisation at 87% for more than 5 minutes — exceeds MAJOR threshold of 85%.',
    metric: 'cpuUtilization',
    value: 87,
    threshold: 85,
    status: 'ACTIVE',
    acknowledgedBy: null,
    acknowledgedAt: null,
    raisedAt: new Date(Date.now() - 23 * 60_000).toISOString(),
    clearedAt: null,
    lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    eventCount: 14,
  },
  {
    id: 'ALM-002',
    deviceId: 'SN-cisco-sw-core-01',
    deviceIp: '192.168.65.254',
    hostname: 'cisco-sw-core-01',
    severity: 'WARNING',
    category: 'CONNECTIVITY',
    title: 'RSSI Below Warning Threshold',
    description: 'Received signal strength −82 dBm is below WARNING threshold of −80 dBm.',
    metric: 'rssi',
    value: -82,
    threshold: -80,
    status: 'ACTIVE',
    acknowledgedBy: null,
    acknowledgedAt: null,
    raisedAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
    clearedAt: null,
    lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    eventCount: 3,
  },
  {
    id: 'ALM-003',
    deviceId: 'SN-bts-north-01',
    deviceIp: '10.0.1.10',
    hostname: 'bts-north-01',
    severity: 'CRITICAL',
    category: 'AVAILABILITY',
    title: 'Device Unreachable',
    description: 'ICMP probe failed 5 consecutive times. Device may be powered off.',
    metric: 'availability',
    value: 0,
    threshold: 1,
    status: 'ACTIVE',
    acknowledgedBy: null,
    acknowledgedAt: null,
    raisedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    clearedAt: null,
    lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    eventCount: 52,
  },
  {
    id: 'ALM-004',
    deviceId: 'SN-cisco-sw-core-01',
    deviceIp: '192.168.65.254',
    hostname: 'cisco-sw-core-01',
    severity: 'MINOR',
    category: 'PERFORMANCE',
    title: 'High Memory Utilisation',
    description: 'Memory utilisation at 91% — above WARNING threshold of 90%.',
    metric: 'memoryUtilization',
    value: 91,
    threshold: 90,
    status: 'ACKNOWLEDGED',
    acknowledgedBy: 'admin',
    acknowledgedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    raisedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    clearedAt: null,
    lastSeenAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    eventCount: 7,
  },
];

// Local ack state (in-memory for dev — resets on gateway restart)
const ackState = new Map(); // id → { acknowledgedBy, acknowledgedAt }

function buildAlarm(base) {
  const ack = ackState.get(base.id);
  return ack ? { ...base, status: 'ACKNOWLEDGED', ...ack } : base;
}

// ── GET /api/v1/alarms ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { severity, status, deviceId, page = '1', size = '50' } = req.query;

  let alarms = BASE_ALARMS.map(buildAlarm);

  if (severity) alarms = alarms.filter((a) => a.severity === String(severity).toUpperCase());
  if (status)   alarms = alarms.filter((a) => a.status   === String(status).toUpperCase());
  if (deviceId) alarms = alarms.filter((a) => a.deviceId === deviceId || a.deviceIp === deviceId);

  const pageNum = Math.max(1, parseInt(String(page), 10));
  const sizeNum = Math.min(500, Math.max(1, parseInt(String(size), 10)));
  const start   = (pageNum - 1) * sizeNum;

  res.json({
    items:      alarms.slice(start, start + sizeNum),
    totalItems: alarms.length,
    page:       pageNum,
    size:       sizeNum,
    totalPages: Math.ceil(alarms.length / sizeNum),
  });
});

// ── GET /api/v1/alarms/summary ────────────────────────────────────────────────
router.get('/summary', (_req, res) => {
  const alarms = BASE_ALARMS.map(buildAlarm);
  const active = alarms.filter((a) => a.status === 'ACTIVE' || a.status === 'ACKNOWLEDGED');
  const counts = { CRITICAL: 0, MAJOR: 0, MINOR: 0, WARNING: 0, CLEAR: 0 };
  for (const a of active) {
    if (a.severity in counts) counts[a.severity]++;
  }
  res.json({
    totalActive: active.length,
    bySeverity:  counts,
    lastUpdated: new Date().toISOString(),
  });
});

// ── GET /api/v1/alarms/:id ────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const alarm = BASE_ALARMS.find((a) => a.id === req.params.id);
  if (!alarm) return res.status(404).json({ code: 'NOT_FOUND', message: `Alarm '${req.params.id}' not found` });
  res.json(buildAlarm(alarm));
});

// ── PUT /api/v1/alarms/:id/ack ────────────────────────────────────────────────
router.put('/:id/ack', (req, res) => {
  const alarm = BASE_ALARMS.find((a) => a.id === req.params.id);
  if (!alarm) return res.status(404).json({ code: 'NOT_FOUND', message: `Alarm '${req.params.id}' not found` });
  const ack = {
    acknowledgedBy:  req.user?.sub || req.body?.acknowledgedBy || 'admin',
    acknowledgedAt:  new Date().toISOString(),
  };
  ackState.set(alarm.id, ack);
  res.json(buildAlarm(alarm));
});

// ── GET /api/v1/alarms/stream — SSE stub (returns 204 No Content) ────────────
// The real SSE stream is proxied separately via createSseProxy in app.js.
// Return 204 here so the browser stops retrying and no CORS error appears.
router.get('/stream', (_req, res) => res.status(204).send());

module.exports = router;

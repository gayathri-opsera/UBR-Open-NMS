'use strict';

/**
 * KPI stub router — provides realistic time-series KPI data when
 * kpi-query-service and kpi-aggregation-service are not reachable.
 *
 * Endpoints mirrored from the Java KPI query service:
 *   GET  /devices/:deviceId/metrics  – time-bucketed metric series
 *   GET  /thresholds                 – list thresholds
 *   POST /thresholds                 – create threshold
 *   PUT  /thresholds/:id             – update threshold
 *   DELETE /thresholds/:id           – delete threshold
 *   GET  /export                     – CSV/XLS download
 */

const router = require('express').Router();

// ── In-memory threshold store (shared across requests) ──────────────────────
let thresholds = [
  { id: 'th-001', deviceId: null, metric: 'cpuUtilization',    severity: 'MAJOR',    direction: 'ABOVE', raiseThreshold: 85,  clearThreshold: 75  },
  { id: 'th-002', deviceId: null, metric: 'memoryUtilization', severity: 'MAJOR',    direction: 'ABOVE', raiseThreshold: 90,  clearThreshold: 80  },
  { id: 'th-003', deviceId: null, metric: 'rssi',              severity: 'WARNING',  direction: 'BELOW', raiseThreshold: -80, clearThreshold: -75 },
  { id: 'th-004', deviceId: null, metric: 'throughputDL',      severity: 'CRITICAL', direction: 'BELOW', raiseThreshold: 5,   clearThreshold: 10  },
];

// Metric baseline values and variance for realistic mock data
const METRIC_CONFIG = {
  cpuUtilization:     { base: 45, variance: 20, unit: '%'     },
  memoryUtilization:  { base: 62, variance: 15, unit: '%'     },
  throughputUL:       { base: 48, variance: 25, unit: 'Mbps'  },
  throughputDL:       { base: 82, variance: 35, unit: 'Mbps'  },
  channelUtilization: { base: 38, variance: 18, unit: '%'     },
  connectedClients:   { base: 14, variance: 6,  unit: ''      },
  txPower:            { base: 20, variance: 3,  unit: 'dBm'   },
  retryRate:          { base: 2,  variance: 3,  unit: '%'     },
  temperature:        { base: 44, variance: 8,  unit: '°C'    },
  rssi:               { base: -65, variance: 10, unit: 'dBm'  },
  snr:                { base: 22,  variance: 5,  unit: 'dB'   },
};

function seededRand(seed) {
  // Simple deterministic pseudo-random for stable per-device values
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function generateBuckets(deviceId, metrics, granularity, from, to) {
  const fromMs  = new Date(from).getTime();
  const toMs    = new Date(to).getTime();
  const range   = toMs - fromMs;

  // Determine bucket interval in ms
  const INTERVALS = { MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 };
  const intervalMs = INTERVALS[granularity] || INTERVALS.HOUR;

  // Cap to reasonable bucket count to avoid huge payloads
  const maxBuckets = Math.min(Math.ceil(range / intervalMs), 168);
  const actualInterval = range / maxBuckets;

  // Stable seed per device so same device always gets same trend shape
  const deviceSeed = deviceId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

  return Array.from({ length: maxBuckets }, (_, i) => {
    const bucketStart = new Date(fromMs + i * actualInterval).toISOString();
    const metricsObj = {};

    for (const m of metrics) {
      const cfg = METRIC_CONFIG[m];
      if (!cfg) continue;
      // Blend device seed + bucket index for smooth variation
      const rand1 = seededRand(deviceSeed + i * 7.3);
      const rand2 = seededRand(deviceSeed + i * 13.7);
      const avg   = cfg.base + (rand1 - 0.5) * 2 * cfg.variance;
      const spread = Math.abs(rand2 * cfg.variance * 0.3);
      metricsObj[m] = {
        avg:   parseFloat(avg.toFixed(2)),
        min:   parseFloat((avg - spread).toFixed(2)),
        max:   parseFloat((avg + spread).toFixed(2)),
      };
    }

    return { bucketStart, metrics: metricsObj, sampleCount: 6 };
  });
}

// ── GET /devices/:deviceId/metrics ───────────────────────────────────────────
router.get('/devices/:deviceId/metrics', (req, res) => {
  const { deviceId } = req.params;
  const {
    metrics    = 'cpuUtilization,memoryUtilization',
    granularity = 'HOUR',
    from = new Date(Date.now() - 86_400_000).toISOString(),
    to   = new Date().toISOString(),
  } = req.query;

  const metricList = String(metrics).split(',').map(m => m.trim()).filter(Boolean);
  const buckets = generateBuckets(deviceId, metricList, String(granularity), String(from), String(to));
  res.json(buckets);
});

// ── GET /thresholds ───────────────────────────────────────────────────────────
router.get('/thresholds', (req, res) => {
  const { deviceId } = req.query;
  const result = deviceId
    ? thresholds.filter(t => t.deviceId === null || t.deviceId === deviceId)
    : thresholds;
  res.json(result);
});

// ── POST /thresholds ──────────────────────────────────────────────────────────
router.post('/thresholds', (req, res) => {
  const newTh = {
    id: `th-${Date.now()}`,
    deviceId: null,
    ...req.body,
  };
  thresholds.push(newTh);
  res.status(201).json(newTh);
});

// ── PUT /thresholds/:id ───────────────────────────────────────────────────────
router.put('/thresholds/:id', (req, res) => {
  const idx = thresholds.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'NOT_FOUND', message: 'Threshold not found' });
  thresholds[idx] = { ...thresholds[idx], ...req.body, id: req.params.id };
  res.json(thresholds[idx]);
});

// ── DELETE /thresholds/:id ────────────────────────────────────────────────────
router.delete('/thresholds/:id', (req, res) => {
  const before = thresholds.length;
  thresholds = thresholds.filter(t => t.id !== req.params.id);
  if (thresholds.length === before) return res.status(404).json({ code: 'NOT_FOUND', message: 'Threshold not found' });
  res.status(204).end();
});

// ── GET /export ───────────────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const {
    deviceId = 'unknown',
    metrics   = 'cpuUtilization,memoryUtilization',
    granularity = 'HOUR',
    from = new Date(Date.now() - 86_400_000).toISOString(),
    to   = new Date().toISOString(),
    format = 'csv',
  } = req.query;

  const metricList = String(metrics).split(',').map(m => m.trim()).filter(Boolean);
  const buckets = generateBuckets(String(deviceId), metricList, String(granularity), String(from), String(to));

  const header = ['bucketStart', ...metricList.flatMap(m => [`${m}_avg`, `${m}_min`, `${m}_max`])].join(',');
  const rows = buckets.map(b => [
    b.bucketStart,
    ...metricList.flatMap(m => [b.metrics[m]?.avg ?? '', b.metrics[m]?.min ?? '', b.metrics[m]?.max ?? '']),
  ].join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="kpi-${deviceId}.csv"`);
  res.send([header, ...rows].join('\n'));
});

module.exports = router;

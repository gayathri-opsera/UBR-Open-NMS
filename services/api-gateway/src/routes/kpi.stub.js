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
 *
 * ⚠️  ARCHITECTURE GAP (real Java path):
 *   This stub gates /devices/:deviceId/metrics behind a MongoDB existence check
 *   (returns 404 for deprovisioned devices).  The production kpi-query-service
 *   MUST implement the same gate via a gRPC call to inventory-service before
 *   synthesising any metric series.  Testing only against this Node stub will NOT
 *   catch a regression in the Java path.
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
// Returns time-bucketed metric series for a device.
// Existence check searches across both ubrnms.devices (gateway-provisioned) and
// ubrnms_inventory.devices (inventory-service-provisioned) so all device sources
// are covered — the kpi-query-service production equivalent does this via gRPC.
router.get('/devices/:deviceId/metrics', async (req, res) => {
  const { deviceId } = req.params;

  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      // Build candidate _id values: try both string and ObjectId (inventory uses ObjectId).
      const { ObjectId } = require('mongodb');
      const idCandidates = [deviceId];
      if (/^[a-f\d]{24}$/i.test(deviceId)) {
        try { idCandidates.push(new ObjectId(deviceId)); } catch (_) { /* not a valid OID */ }
      }

      const orConditions = [
        ...idCandidates.map((id) => ({ _id: id })),
        { serialNumber: deviceId },
        { ipAddress: deviceId },
      ];

      // Search gateway-managed devices first, then inventory service DB.
      const collectionsToSearch = [
        mongoose.connection.db.collection('devices'),
        mongoose.connection.client.db('ubrnms_inventory').collection('devices'),
      ];
      let found = false;
      for (const col of collectionsToSearch) {
        try {
          // a soft-deleted (deprovisioned) device no longer exists as far as KPI is concerned
          const doc = await col.findOne({ $or: orConditions, isDeprovisioned: { $ne: true } });
          if (doc) { found = true; break; }
        } catch (_) { /* skip unreachable collection */ }
      }
      if (!found) {
        return res.status(404).json({
          code: 'DEVICE_NOT_FOUND',
          message: 'Device not found or has been deprovisioned.',
        });
      }
    }
    // If MongoDB is not reachable fall through to stub data so local dev
    // without Docker still works.
  } catch (err) {
    console.warn('[kpi-stub] Device existence check failed, returning stub data:', err.message);
  }

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

// ── GET /drilldown (WO-040) ───────────────────────────────────────────────────
// Returns per-device time-series drilldown for a specified metric, time range,
// and granularity. Respects deviceId, serialNumber, deviceType, metricName,
// metricGroup, discoveryParadigm, from, to, and granularity query parameters.
router.get('/drilldown', (req, res) => {
  const {
    deviceId        = '',
    serialNumber    = '',
    deviceType      = '',
    metricName      = '',
    metricGroup     = '',
    discoveryParadigm = '',
    from            = new Date(Date.now() - 86_400_000).toISOString(),
    to              = new Date().toISOString(),
    granularity     = '1HOUR',
  } = req.query;

  const fromMs = new Date(String(from)).getTime();
  const toMs   = new Date(String(to)).getTime();

  // Validate time range — return 400 when start is after end
  if (isNaN(fromMs) || isNaN(toMs)) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'INVALID_FILTERS', field: 'from', message: 'from and to must be valid ISO timestamps' },
    });
  }
  if (fromMs >= toMs) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'INVALID_TIME_RANGE', field: 'from', message: 'start time must be before end time' },
    });
  }

  // Supported granularities per device type — IDU and GENERIC don't support RAW
  const granularityMap = {
    RAW: 60_000,
    '15MIN': 900_000,
    '1HOUR': 3_600_000,
    DAILY: 86_400_000,
  };
  const effectiveGran = String(granularity).toUpperCase();
  if (!granularityMap[effectiveGran]) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'UNSUPPORTED_GRANULARITY', field: 'granularity', message: `Granularity '${granularity}' is not supported. Use: RAW, 15MIN, 1HOUR, DAILY` },
    });
  }

  const intervalMs = granularityMap[effectiveGran];
  const range = toMs - fromMs;
  const bucketCount = Math.min(Math.ceil(range / intervalMs), 200);

  // Determine which metrics to return
  const groupMetrics = {
    radio: ['rssi', 'snr', 'txPower'],
    system: ['cpuUtilization', 'memoryUtilization', 'temperature'],
    traffic: ['throughputUL', 'throughputDL', 'connectedClients', 'channelUtilization', 'retryRate'],
    all: Object.keys(METRIC_CONFIG),
  };
  const selectedGroup = metricGroup ? groupMetrics[String(metricGroup)] : null;
  const metrics = metricName
    ? [String(metricName)]
    : (selectedGroup || Object.keys(METRIC_CONFIG));

  // Resolve target device — default stub device when no filter given
  const targetDeviceId     = String(deviceId     || 'dev-drilldown-001');
  const targetSerialNumber = String(serialNumber || 'SN-DRILL-001');
  const targetDeviceType   = String(deviceType   || 'BTS').toUpperCase();

  // IDU devices don't support radio metrics — mark as unsupported
  const iduUnsupported = new Set(['rssi', 'snr', 'txPower']);

  const series = metrics.map((m) => {
    const cfg = METRIC_CONFIG[m];
    if (!cfg) {
      return {
        metricName: m,
        deviceId: targetDeviceId,
        serialNumber: targetSerialNumber,
        unit: '',
        supported: false,
        unsupportedReason: `Unknown metric: ${m}`,
        data: [],
      };
    }

    const isUnsupported = targetDeviceType === 'IDU' && iduUnsupported.has(m);
    if (isUnsupported) {
      return {
        metricName: m,
        deviceId: targetDeviceId,
        serialNumber: targetSerialNumber,
        unit: cfg.unit,
        supported: false,
        unsupportedReason: `IDU devices do not report ${m}`,
        data: [],
      };
    }

    const deviceSeed = targetDeviceId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = Array.from({ length: bucketCount }, (_, i) => {
      const r1 = seededRand(deviceSeed + i * 7.3);
      const r2 = seededRand(deviceSeed + i * 13.7);
      const avg = cfg.base + (r1 - 0.5) * 2 * cfg.variance;
      const spread = Math.abs(r2 * cfg.variance * 0.3);
      return {
        bucketStart: new Date(fromMs + i * intervalMs).toISOString(),
        avg: parseFloat(avg.toFixed(2)),
        min: parseFloat((avg - spread).toFixed(2)),
        max: parseFloat((avg + spread).toFixed(2)),
        sampleCount: 4,
        stale: false,
      };
    });

    return {
      metricName: m,
      deviceId: targetDeviceId,
      serialNumber: targetSerialNumber,
      unit: cfg.unit,
      supported: true,
      data,
    };
  });

  // Flatten series into table rows
  const tableRows = series
    .filter((s) => s.supported && s.data.length > 0)
    .flatMap((s) =>
      s.data.map((p) => ({
        timestamp: p.bucketStart,
        metricName: s.metricName,
        deviceId: s.deviceId,
        serialNumber: s.serialNumber,
        avg: p.avg,
        min: p.min,
        max: p.max,
        unit: METRIC_CONFIG[s.metricName]?.unit || '',
        sampleCount: p.sampleCount,
      }))
    )
    .slice(0, 500); // cap for performance

  res.json({
    query: {
      deviceId: deviceId || null,
      serialNumber: serialNumber || null,
      deviceType: deviceType || null,
      metricName: metricName || null,
      metricGroup: metricGroup || null,
      discoveryParadigm: discoveryParadigm || null,
      from,
      to,
      granularity: effectiveGran,
    },
    series,
    tableRows,
    supportedGranularities: ['RAW', '15MIN', '1HOUR', 'DAILY'],
    units: Object.fromEntries(Object.entries(METRIC_CONFIG).map(([k, v]) => [k, v.unit])),
    generatedAt: new Date().toISOString(),
    staleData: false,
  });
});

// ── GET /availability-summary/v2 (WO-041) ────────────────────────────────────
// Returns per-device availability health states derived from KPI and alarm signals.
router.get('/availability-summary/v2', (req, res) => {
  const {
    deviceId     = '',
    serialNumber = '',
    networkId    = '',
    deviceType   = '',
  } = req.query;

  const now = Date.now();

  // Deterministic device fixtures covering all health states
  const DEVICES = [
    {
      deviceId: 'dev-bts-001', serialNumber: 'SN-BTS-001', deviceType: 'BTS',
      healthState: 'UP', primaryReason: 'All KPI metrics within normal thresholds',
      secondaryReasons: [], source: 'KPI', confidence: 0.97, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(now - 90_000).toISOString(),
    },
    {
      deviceId: 'dev-bts-degraded-001', serialNumber: 'SN-BTS-002', deviceType: 'BTS',
      healthState: 'DEGRADED', primaryReason: 'CPU utilization elevated (68%)',
      secondaryReasons: ['UL throughput trending down'], source: 'KPI', confidence: 0.82, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(now - 120_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-critical-001', serialNumber: 'SN-CPE-001', deviceType: 'CPE',
      healthState: 'DOWN', primaryReason: 'Critical alarm: packet loss 4.2%',
      secondaryReasons: ['Latency 88ms above threshold', 'Availability below 90%'], source: 'ALARM', confidence: 0.99, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(now - 300_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-001', serialNumber: 'SN-CPE-002', deviceType: 'CPE',
      healthState: 'UP', primaryReason: 'Device reporting regularly via call-home',
      secondaryReasons: [], source: 'CALL_HOME', confidence: 0.95, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(now - 60_000).toISOString(),
    },
    {
      deviceId: 'dev-idu-001', serialNumber: 'SN-IDU-001', deviceType: 'IDU',
      healthState: 'DEGRADED', primaryReason: 'Memory utilization near threshold (71%)',
      secondaryReasons: [], source: 'KPI', confidence: 0.76, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(now - 600_000).toISOString(),
    },
    {
      deviceId: 'dev-generic-001', serialNumber: 'GENERIC-IP-10.0.1.1', deviceType: 'GENERIC',
      healthState: 'UNKNOWN', primaryReason: 'No KPI data received in last 15 minutes',
      secondaryReasons: ['SNMP poll may be failing'], source: 'UNKNOWN', confidence: 0.3, stale: true, dampenedUntil: null,
      lastObservedAt: new Date(now - 20 * 60_000).toISOString(),
    },
    {
      deviceId: 'dev-bts-flapping-001', serialNumber: 'SN-BTS-FLAP-001', deviceType: 'BTS',
      healthState: 'DEGRADED',
      primaryReason: 'Flap dampening active: device alternating UP/DOWN faster than dampening window',
      secondaryReasons: ['Last DOWN event: 2 minutes ago'], source: 'KPI', confidence: 0.6, stale: false,
      dampenedUntil: new Date(now + 5 * 60_000).toISOString(),
      lastObservedAt: new Date(now - 30_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-new-001', serialNumber: 'SN-CPE-NEW-001', deviceType: 'CPE',
      healthState: 'UNKNOWN', primaryReason: 'Newly onboarded device — no KPI history yet',
      secondaryReasons: [], source: 'UNKNOWN', confidence: 0.0, stale: false, dampenedUntil: null,
      lastObservedAt: null,
    },
  ];

  let filtered = DEVICES;
  if (deviceId)     filtered = filtered.filter((d) => d.deviceId === String(deviceId));
  if (serialNumber) filtered = filtered.filter((d) => d.serialNumber === String(serialNumber));
  if (deviceType)   filtered = filtered.filter((d) => d.deviceType.toUpperCase() === String(deviceType).toUpperCase());

  // When a specific device is requested but not in the fixture list, synthesize
  // a deterministic health record based on its identifier.  This handles real
  // provisioned devices (inventory-service or gateway-managed) whose IDs are
  // not hard-coded in the stub fixtures above.
  if ((deviceId || serialNumber) && filtered.length === 0) {
    const seed = String(deviceId || serialNumber).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const states = ['UP', 'UP', 'UP', 'DEGRADED', 'UNKNOWN'];
    const syntheticState = states[seed % states.length];
    const reasons = {
      UP:       'All monitored parameters within normal thresholds',
      DEGRADED: 'One or more parameters elevated — monitoring in progress',
      UNKNOWN:  'Insufficient polling data — SNMP collection initialising',
    };
    filtered = [{
      deviceId:        deviceId || '',
      serialNumber:    serialNumber || '',
      deviceType:      deviceType || 'GENERIC',
      healthState:     syntheticState,
      primaryReason:   reasons[syntheticState] || reasons.UNKNOWN,
      secondaryReasons: [],
      source:          'KPI',
      confidence:      syntheticState === 'UP' ? 0.90 : 0.55,
      stale:           false,
      dampenedUntil:   null,
      lastObservedAt:  new Date(now - 120_000).toISOString(),
    }];
  }

  res.json({
    generatedAt: new Date().toISOString(),
    devices: filtered,
  });
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

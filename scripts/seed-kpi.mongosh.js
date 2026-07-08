// Mongosh-compatible KPI seed script — no require(), runs directly in mongosh
// Usage: mongosh ubr_nms --file /tmp/seed-kpi.mongosh.js

const col = db.getSiblingDB('ubr_nms').getCollection('kpi_warm');
col.deleteMany({});
print('Cleared kpi_warm collection');

const DEVICES = [
  { id: 'dev-bts-dn-001', type: 'BTS',  netId: 'net-dn-001',  orgId: 'org-delhi-001'  },
  { id: 'dev-cpe-dn-001', type: 'CPE',  netId: 'net-dn-001',  orgId: 'org-delhi-001'  },
  { id: 'dev-cpe-dn-002', type: 'CPE',  netId: 'net-dn-001',  orgId: 'org-delhi-001'  },
  { id: 'dev-cpe-dn-003', type: 'CPE',  netId: 'net-dn-001',  orgId: 'org-delhi-001'  },
  { id: 'dev-idu-dn-001', type: 'IDU',  netId: 'net-dn-001',  orgId: 'org-delhi-001'  },
  { id: 'dev-bts-mb-001', type: 'BTS',  netId: 'net-mb-001',  orgId: 'org-mumbai-001' },
  { id: 'dev-cpe-mb-001', type: 'CPE',  netId: 'net-mb-001',  orgId: 'org-mumbai-001' },
  { id: 'dev-cpe-mb-002', type: 'CPE',  netId: 'net-mb-001',  orgId: 'org-mumbai-001' },
];

const METRIC_RANGES = {
  BTS: {
    rssi:               [-55, 5,  -75, -40],
    snr:                [32,  4,  20,  45 ],
    cpuUtilization:     [35,  15, 5,   90 ],
    memoryUtilization:  [55,  10, 20,  85 ],
    throughputUL:       [120, 40, 10,  300],
    throughputDL:       [250, 60, 20,  600],
    channelUtilization: [45,  15, 5,   90 ],
    connectedClients:   [25,  10, 0,   64 ],
    txPower:            [20,  1,  15,  23 ],
    retryRate:          [3,   2,  0,   15 ],
  },
  CPE: {
    rssi:               [-65, 8,  -85, -45],
    snr:                [25,  6,  10,  40 ],
    cpuUtilization:     [25,  10, 5,   70 ],
    memoryUtilization:  [45,  8,  15,  75 ],
    throughputUL:       [15,  8,  1,   50 ],
    throughputDL:       [35,  15, 2,   100],
    channelUtilization: [30,  12, 5,   75 ],
    connectedClients:   [4,   2,  0,   16 ],
    txPower:            [17,  1,  10,  20 ],
    retryRate:          [5,   3,  0,   20 ],
  },
  IDU: {
    rssi:               [-50, 3,  -65, -35],
    snr:                [38,  4,  25,  50 ],
    cpuUtilization:     [20,  8,  5,   60 ],
    memoryUtilization:  [40,  8,  15,  65 ],
    throughputUL:       [300, 80, 50,  700],
    throughputDL:       [350, 80, 50,  800],
    channelUtilization: [55,  15, 10,  90 ],
    connectedClients:   [1,   0,  0,   2  ],
    txPower:            [23,  0,  20,  23 ],
    retryRate:          [1,   1,  0,   5  ],
  },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeMetrics(deviceType, offsetHours) {
  const ranges = METRIC_RANGES[deviceType] || METRIC_RANGES.CPE;
  const hour = ((new Date().getUTCHours() - Math.floor(offsetHours)) + 24) % 24;
  const lf = (hour >= 8 && hour <= 20) ? 1.2 : 0.8;
  const m = {};
  for (const [key, r] of Object.entries(ranges)) {
    const [base, noise, lo, hi] = r;
    const a = clamp(base * lf + (Math.random() - 0.5) * 2 * noise, lo, hi);
    const sp = noise * 0.4;
    m[key] = {
      avg: parseFloat(a.toFixed(2)),
      min: parseFloat(clamp(a - sp, lo, a).toFixed(2)),
      max: parseFloat(clamp(a + sp, a, hi).toFixed(2)),
      count: 4,
      sum: parseFloat((a * 4).toFixed(2)),
    };
  }
  return m;
}

const now = new Date();
const ttlExpiry = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
let total = 0;

for (const dev of DEVICES) {
  const batch = [];

  // 1HOUR — 48h
  for (let h = 47; h >= 0; h--) {
    const bs = new Date(now.getTime() - h * 3600000);
    bs.setMinutes(0, 0, 0);
    batch.push({
      deviceId: dev.id, deviceType: dev.type, networkId: dev.netId, organizationId: dev.orgId,
      granularity: '1HOUR', bucketStart: bs, bucketEnd: new Date(bs.getTime() + 3600000),
      sampleCount: 4, metrics: makeMetrics(dev.type, h), ttlExpiry,
    });
  }

  // DAILY — 7d
  for (let d = 6; d >= 0; d--) {
    const bs = new Date(now.getTime() - d * 86400000);
    bs.setHours(0, 0, 0, 0);
    batch.push({
      deviceId: dev.id, deviceType: dev.type, networkId: dev.netId, organizationId: dev.orgId,
      granularity: 'DAILY', bucketStart: bs, bucketEnd: new Date(bs.getTime() + 86400000),
      sampleCount: 96, metrics: makeMetrics(dev.type, d * 24), ttlExpiry,
    });
  }

  // 15MIN — 24h
  for (let q = 95; q >= 0; q--) {
    const bs = new Date(now.getTime() - q * 15 * 60000);
    bs.setSeconds(0, 0);
    bs.setMinutes(bs.getMinutes() - (bs.getMinutes() % 15));
    batch.push({
      deviceId: dev.id, deviceType: dev.type, networkId: dev.netId, organizationId: dev.orgId,
      granularity: '15MIN', bucketStart: bs, bucketEnd: new Date(bs.getTime() + 900000),
      sampleCount: 1, metrics: makeMetrics(dev.type, q / 4), ttlExpiry,
    });
  }

  col.insertMany(batch);
  total += batch.length;
  print('  Seeded ' + dev.id + ' (' + batch.length + ' docs)');
}

col.createIndex({ deviceId: 1, bucketStart: -1, granularity: 1 });
print('✓ kpi_warm: ' + total + ' total documents inserted');
print('✓ Index created');

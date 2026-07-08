'use strict';
/**
 * Seed synthetic KPI data into kpi_warm collection.
 * Generates 48h of 1HOUR buckets + 7d of DAILY buckets for all devices.
 */
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URI || 'mongodb://localhost:27017/ubr_nms';

// Devices from the inventory seed
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

// Expanded device list from seed-devices-expanded.js
const SITE_DEVICES = [];
for (let i = 1; i <= 8; i++) {
  const pfx = `SITE${String(i).padStart(2,'0')}`;
  SITE_DEVICES.push({ id: `dev-bts-${pfx.toLowerCase()}-001`, type: 'BTS', netId: `net-${pfx.toLowerCase()}-001`, orgId: 'org-delhi-001' });
  for (let j = 1; j <= 8; j++) {
    SITE_DEVICES.push({ id: `dev-cpe-${pfx.toLowerCase()}-${String(j).padStart(3,'0')}`, type: 'CPE', netId: `net-${pfx.toLowerCase()}-001`, orgId: 'org-delhi-001' });
  }
}

const ALL_DEVICES = [...DEVICES, ...SITE_DEVICES];

// Metric ranges per device type
const METRIC_RANGES = {
  BTS: {
    rssi:               { base: -55, noise: 5,  min: -75, max: -40 },
    snr:                { base: 32,  noise: 4,  min: 20,  max: 45  },
    cpuUtilization:     { base: 35,  noise: 15, min: 5,   max: 90  },
    memoryUtilization:  { base: 55,  noise: 10, min: 20,  max: 85  },
    throughputUL:       { base: 120, noise: 40, min: 10,  max: 300 },
    throughputDL:       { base: 250, noise: 60, min: 20,  max: 600 },
    channelUtilization: { base: 45,  noise: 15, min: 5,   max: 90  },
    connectedClients:   { base: 25,  noise: 10, min: 0,   max: 64  },
    txPower:            { base: 20,  noise: 1,  min: 15,  max: 23  },
    retryRate:          { base: 3,   noise: 2,  min: 0,   max: 15  },
  },
  CPE: {
    rssi:               { base: -65, noise: 8,  min: -85, max: -45 },
    snr:                { base: 25,  noise: 6,  min: 10,  max: 40  },
    cpuUtilization:     { base: 25,  noise: 10, min: 5,   max: 70  },
    memoryUtilization:  { base: 45,  noise: 8,  min: 15,  max: 75  },
    throughputUL:       { base: 15,  noise: 8,  min: 1,   max: 50  },
    throughputDL:       { base: 35,  noise: 15, min: 2,   max: 100 },
    channelUtilization: { base: 30,  noise: 12, min: 5,   max: 75  },
    connectedClients:   { base: 4,   noise: 2,  min: 0,   max: 16  },
    txPower:            { base: 17,  noise: 1,  min: 10,  max: 20  },
    retryRate:          { base: 5,   noise: 3,  min: 0,   max: 20  },
  },
  IDU: {
    rssi:               { base: -50, noise: 3,  min: -65, max: -35 },
    snr:                { base: 38,  noise: 4,  min: 25,  max: 50  },
    cpuUtilization:     { base: 20,  noise: 8,  min: 5,   max: 60  },
    memoryUtilization:  { base: 40,  noise: 8,  min: 15,  max: 65  },
    throughputUL:       { base: 300, noise: 80, min: 50,  max: 700 },
    throughputDL:       { base: 350, noise: 80, min: 50,  max: 800 },
    channelUtilization: { base: 55,  noise: 15, min: 10,  max: 90  },
    connectedClients:   { base: 1,   noise: 0,  min: 0,   max: 2   },
    txPower:            { base: 23,  noise: 0,  min: 20,  max: 23  },
    retryRate:          { base: 1,   noise: 1,  min: 0,   max: 5   },
  },
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rnd(base, noise) { return base + (Math.random() - 0.5) * 2 * noise; }

function makeMetrics(deviceType, hourOffset) {
  const ranges = METRIC_RANGES[deviceType] || METRIC_RANGES.CPE;
  // Add time-of-day variation (busier 8am-8pm)
  const hour = ((new Date().getUTCHours() - hourOffset) + 24) % 24;
  const loadFactor = hour >= 8 && hour <= 20 ? 1.2 : 0.8;
  const metrics = {};
  for (const [key, r] of Object.entries(ranges)) {
    const avg = clamp(rnd(r.base * loadFactor, r.noise), r.min, r.max);
    const spread = r.noise * 0.5;
    metrics[key] = {
      avg: parseFloat(avg.toFixed(2)),
      min: parseFloat(clamp(avg - spread, r.min, avg).toFixed(2)),
      max: parseFloat(clamp(avg + spread, avg, r.max).toFixed(2)),
      count: 4,
      sum: parseFloat((avg * 4).toFixed(2)),
    };
  }
  return metrics;
}

async function main() {
  const client = new MongoClient(MONGO_URL.replace(/\/[^/]+$/, '/ubr_nms'));
  await client.connect();
  const db = client.db('ubr_nms');
  const col = db.collection('kpi_warm');

  // Clear existing synthetic data
  await col.deleteMany({});
  console.log('Cleared kpi_warm collection');

  const docs = [];
  const now = new Date();
  const ttlExpiry = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

  // Use only first 20 devices to keep data manageable
  const seedDevices = ALL_DEVICES.slice(0, 20);

  for (const dev of seedDevices) {
    // 1HOUR buckets — last 48 hours
    for (let h = 47; h >= 0; h--) {
      const bucketStart = new Date(now.getTime() - h * 3600 * 1000);
      bucketStart.setMinutes(0, 0, 0);
      const bucketEnd = new Date(bucketStart.getTime() + 3600 * 1000);
      docs.push({
        deviceId: dev.id,
        deviceType: dev.type,
        networkId: dev.netId,
        organizationId: dev.orgId,
        granularity: '1HOUR',
        bucketStart,
        bucketEnd,
        sampleCount: 4,
        metrics: makeMetrics(dev.type, h),
        ttlExpiry,
      });
    }

    // DAILY buckets — last 7 days
    for (let d = 6; d >= 0; d--) {
      const bucketStart = new Date(now.getTime() - d * 86400 * 1000);
      bucketStart.setHours(0, 0, 0, 0);
      const bucketEnd = new Date(bucketStart.getTime() + 86400 * 1000);
      docs.push({
        deviceId: dev.id,
        deviceType: dev.type,
        networkId: dev.netId,
        organizationId: dev.orgId,
        granularity: 'DAILY',
        bucketStart,
        bucketEnd,
        sampleCount: 96,
        metrics: makeMetrics(dev.type, d * 24),
        ttlExpiry,
      });
    }

    // 15MIN buckets — last 24 hours
    for (let m = 95; m >= 0; m--) {
      const bucketStart = new Date(now.getTime() - m * 15 * 60 * 1000);
      bucketStart.setSeconds(0, 0);
      const rem = bucketStart.getMinutes() % 15;
      bucketStart.setMinutes(bucketStart.getMinutes() - rem);
      const bucketEnd = new Date(bucketStart.getTime() + 15 * 60 * 1000);
      docs.push({
        deviceId: dev.id,
        deviceType: dev.type,
        networkId: dev.netId,
        organizationId: dev.orgId,
        granularity: '15MIN',
        bucketStart,
        bucketEnd,
        sampleCount: 1,
        metrics: makeMetrics(dev.type, m / 4),
        ttlExpiry,
      });
    }
  }

  // Bulk insert in batches
  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    await col.insertMany(docs.slice(i, i + BATCH));
  }

  console.log(`✓ kpi_warm: ${docs.length} buckets inserted for ${seedDevices.length} devices`);
  console.log('  Granularities: 1HOUR (48h), DAILY (7d), 15MIN (24h)');
  console.log('  Devices:', seedDevices.map(d => d.id).slice(0, 5).join(', '), '...');

  // Create compound index
  await col.createIndex({ deviceId: 1, bucketStart: -1, granularity: 1 });
  console.log('✓ Index created on deviceId + bucketStart + granularity');

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });

'use strict';

/**
 * Config stub — template CRUD persisted to MongoDB (config_templates collection).
 * Push jobs are simulated in-memory (real delivery handled by config-push-worker).
 * Mounted at /api/v1/config in app.js.
 */
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

// ── MongoDB connection (eager, at module load) ────────────────────────────────
// Use MONGO_URI_CONFIG if available (points to ubrnms_config DB);
// fall back to MONGO_URI (which may point to ubr_nms for the devices stub).
const MONGO_URI = process.env.MONGO_URI_CONFIG
  || process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubrnms_config';
const COLLECTION = 'config_templates';

let _col = null; // resolved once DB is ready

async function getCol() {
  if (_col) return _col;
  // reuse existing mongoose connection if already open
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection(COLLECTION);
    await seedIfEmpty(_col);
    return _col;
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  _col = mongoose.connection.db.collection(COLLECTION);
  await seedIfEmpty(_col);
  return _col;
}

// Connect eagerly so seeding happens before the first HTTP request
getCol().catch((err) => console.error('[config-stub] MongoDB connect failed:', err.message));

const SEED_TEMPLATES = [
  {
    _id: 'tpl-bts-standard', name: 'BTS-Standard-5GHz', deviceType: 'BTS', isDefault: true,
    ssid5: 'Airtel_UBR_5G', wpaKey5: 'Airtel@1234', ssid24: 'Airtel_UBR_2G', wpaKey24: 'Airtel@1234',
    txPowerDbm: 23, operatingChannel: '36', channelBandwidthMHz: '80',
    beaconInterval: 100, dtimPeriod: 1, shortGuardInterval: true, bandSteering: false,
    ethernetSpeed: '1000Mbps Full', ethernetPort0: true,
    ipMode: 'DHCP', dnsServer1: '8.8.8.8', dnsServer2: '8.8.4.4',
    vlanMode: 'Single', vlanId: 100, vlanPriority: 0,
    qosProfile: 'BEST_EFFORT', ulBandwidthLimit: 100, dlBandwidthLimit: 200,
    snmpCommunity: 'public', ntpServer: 'pool.ntp.org', timezone: 'Asia/Kolkata', logLevel: 'INFO',
    customFields: [], hiddenFields: [],
    createdAt: new Date(),
  },
  {
    _id: 'tpl-cpe-home', name: 'CPE-Home-Basic', deviceType: 'CPE', isDefault: false,
    ssid5: 'CPE_UBR_5G', wpaKey5: 'Airtel@5678', ssid24: 'CPE_UBR_2G', wpaKey24: 'Airtel@5678',
    ethernetSpeed: 'Auto', ethernetPort0: true,
    ipMode: 'DHCP', dnsServer: '8.8.8.8',
    vlanMode: 'Single', vlanId: 200, vlanPriority: 0,
    qosProfile: 'BEST_EFFORT', ulBandwidthLimit: 50, dlBandwidthLimit: 100,
    snmpCommunity: 'public', ntpServer: 'pool.ntp.org', timezone: 'Asia/Kolkata', logLevel: 'WARN',
    customFields: [], hiddenFields: [],
    createdAt: new Date(),
  },
  {
    _id: 'tpl-cpe-enterprise', name: 'CPE-Enterprise-200', deviceType: 'CPE', isDefault: false,
    ipMode: 'Static', ipAddress: '10.30.1.100', subnetMask: '255.255.255.0', gateway: '10.30.1.254', dnsServer: '10.0.0.1',
    vlanMode: 'Double', vlanId: 300, outerVlanId: 400, vlanPriority: 5,
    qosProfile: 'EF', ulBandwidthLimit: 200, dlBandwidthLimit: 200,
    snmpCommunity: 'corp-rw', ntpServer: '10.0.0.5', timezone: 'Asia/Kolkata', logLevel: 'WARN',
    customFields: [], hiddenFields: [],
    createdAt: new Date(),
  },
  {
    _id: 'tpl-idu-p2p', name: 'IDU-P2P-Backhaul', deviceType: 'IDU', isDefault: false,
    ipMode: 'Static', ipAddress: '192.168.100.1', subnetMask: '255.255.255.252', gateway: '192.168.100.2',
    vlanMode: 'Single', vlanId: 400, vlanPriority: 7,
    snmpCommunity: 'backhaul', ntpServer: 'pool.ntp.org', logLevel: 'INFO',
    customFields: [], hiddenFields: [],
    createdAt: new Date(),
  },
];

/** Seed default templates if the collection is empty */
async function seedIfEmpty(col) {
  const count = await col.countDocuments();
  if (count === 0) {
    await col.insertMany(SEED_TEMPLATES);
  }
}

/** Map MongoDB doc → API response shape */
function toApi(doc) {
  const { _id, __v, ...rest } = doc;
  return { id: String(_id), ...rest };
}

// ── In-memory push jobs ───────────────────────────────────────────────────────
const jobs      = {};
let   nextJobId = 1;

// ── Helper: build ConfigJob response shape ────────────────────────────────────
function buildJobResponse(job) {
  const devices        = job.devices || [];
  const total          = devices.length;
  const success        = devices.filter((d) => d.status === 'SUCCESS').length;
  const failed         = devices.filter((d) => d.status === 'FAILED').length;
  const pending        = devices.filter((d) => d.status === 'QUEUED').length;
  const progressPercent = total === 0 ? 0 : Math.round(((success + failed) / total) * 100);
  const perDeviceStatus = {};
  devices.forEach((d) => { perDeviceStatus[d.deviceId] = d.status; });
  return {
    jobId: job.jobId,
    status: job.status,
    totalDevices: total,
    successCount: success,
    failureCount: failed,
    pendingCount: pending,
    progressPercent,
    perDeviceStatus,
    startedAt: job.startedAt,
    completedAt: job.completedAt || null,
  };
}

// ── Templates (MongoDB-backed, in-memory fallback if DB unreachable) ──────────
router.get('/templates', async (_req, res) => {
  try {
    const col = await getCol();
    const docs = await col.find({}).toArray();
    res.json(docs.map(toApi));
  } catch (e) {
    console.error('[config-stub] /templates DB error — returning seed data:', e.message);
    // Fallback: return the seed templates so the UI never shows a blank/error state
    res.json(SEED_TEMPLATES.map(toApi));
  }
});

router.post('/templates', async (req, res) => {
  try {
    const col = await getCol();
    const { name, deviceType, description, isDefault, customFields, hiddenFields, ...params } = req.body || {};
    if (!name) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
    const doc = {
      _id: `tpl-${Date.now()}`,
      name, description: description || '', deviceType: deviceType || 'BTS',
      isDefault: Boolean(isDefault),
      customFields: customFields || [],
      hiddenFields: hiddenFields || [],
      ...params,
      createdAt: new Date(), updatedAt: new Date(),
    };
    await col.insertOne(doc);
    res.status(201).json(toApi(doc));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ code: 'DUPLICATE', message: 'Template name already exists' });
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const col = await getCol();
    const { _id, id, ...update } = req.body || {};
    update.updatedAt = new Date();
    const result = await col.findOneAndUpdate(
      { _id: req.params.id },
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: 'Template not found' });
    res.json(toApi(result));
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const col = await getCol();
    await col.deleteOne({ _id: req.params.id });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── Push (single device) ─────────────────────────────────────────────────────
router.post('/push/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const { templateId, firmware, firmwareVersion } = req.body || req.query || {};
  const jobId = `job-${nextJobId++}`;
  jobs[jobId] = {
    jobId, deviceId, templateId, firmwareVersion,
    status: 'RUNNING', startedAt: new Date().toISOString(), completedAt: null,
    devices: [{ deviceId, status: 'QUEUED' }],
  };
  setTimeout(() => {
    jobs[jobId].status = 'COMPLETED';
    jobs[jobId].completedAt = new Date().toISOString();
    jobs[jobId].devices[0].status = 'SUCCESS';
  }, 2000);
  res.json({
    status: 'PUSHED',
    message: firmware ? 'Firmware upgrade queued' : 'Config push accepted — applying to device',
    commandId: jobId,
  });
});

// ── Bulk push ─────────────────────────────────────────────────────────────────
router.post('/bulk-push', (req, res) => {
  const { templateId, filter, deviceIds } = req.body || {};
  const jobId = `job-${nextJobId++}`;

  let deviceCount = 0;
  if (Array.isArray(deviceIds) && deviceIds.length > 0) {
    deviceCount = deviceIds.length;
  } else if (filter && filter.deviceType) {
    const counts = { BTS: 120, CPE: 350, IDU: 40 };
    deviceCount = counts[filter.deviceType] || 120;
  } else {
    deviceCount = 510;
  }

  const devices = Array.from({ length: deviceCount }, (_, i) => ({
    deviceId: `dev-${String(i + 1).padStart(4, '0')}`,
    status: 'QUEUED',
  }));

  jobs[jobId] = {
    jobId, templateId, filter, status: 'RUNNING',
    startedAt: new Date().toISOString(), completedAt: null, devices,
  };

  let completed = 0;
  const interval = setInterval(() => {
    const batch = Math.min(Math.ceil(deviceCount / 8), deviceCount - completed);
    for (let i = completed; i < completed + batch; i++) {
      if (jobs[jobId] && jobs[jobId].devices[i]) {
        jobs[jobId].devices[i].status = Math.random() > 0.05 ? 'SUCCESS' : 'FAILED';
      }
    }
    completed += batch;
    if (completed >= deviceCount) {
      clearInterval(interval);
      if (jobs[jobId]) {
        jobs[jobId].status = 'COMPLETED';
        jobs[jobId].completedAt = new Date().toISOString();
      }
    }
  }, 500);

  res.json(buildJobResponse(jobs[jobId]));
});

// ── Job status ────────────────────────────────────────────────────────────────
function serveJob(req, res) {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found' });
  res.json(buildJobResponse(job));
}
router.get('/jobs/:jobId',        serveJob);
router.get('/jobs/:jobId/status', serveJob);

// ── Firmware summary ──────────────────────────────────────────────────────────
router.get('/firmware/summary', (_req, res) => {
  res.json([
    { version: 'v3.4.1', count: 64, deviceType: 'BTS' },
    { version: 'v2.2.0', count: 12, deviceType: 'BTS' },
    { version: 'v3.0.1', count: 84, deviceType: 'CPE' },
    { version: 'v2.9.5', count: 14, deviceType: 'CPE' },
  ]);
});

module.exports = router;

'use strict';

/**
 * Config stub — handles config templates, push jobs, and config history.
 * Mounted at /api/v1/config (intercepts before the Java config-service proxy
 * which is currently returning 503).
 */
const express = require('express');
const router  = express.Router();

// ── In-memory stores ─────────────────────────────────────────────────────────
let templates = [
  {
    id: 'tpl-bts-standard', name: 'BTS-Standard-5GHz', deviceType: 'BTS', isDefault: true,
    parameters: {
      txPowerDbm: 23, operatingChannel: '36', channelBandwidthMHz: '80',
      beaconInterval: 100, dtimPeriod: 1, shortGuardInterval: true, bandSteering: false,
      ipMode: 'DHCP', dnsServer1: '8.8.8.8', dnsServer2: '8.8.4.4',
      vlanMode: 'Single', vlanId: 100, vlanPriority: 0,
      qosProfile: 'BEST_EFFORT', ulBandwidthLimit: 100, dlBandwidthLimit: 200,
      snmpCommunity: 'public', ntpServer: 'pool.ntp.org', timezone: 'Asia/Kolkata', logLevel: 'INFO',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl-cpe-home', name: 'CPE-Home-Basic', deviceType: 'CPE', isDefault: false,
    parameters: {
      ipMode: 'DHCP', dnsServer: '8.8.8.8',
      vlanId: 200, vlanPriority: 0,
      qosProfile: 'BEST_EFFORT', ulBandwidthLimit: 50, dlBandwidthLimit: 100,
      snmpCommunity: 'public', ntpServer: 'pool.ntp.org', timezone: 'Asia/Kolkata', logLevel: 'WARN',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl-cpe-enterprise', name: 'CPE-Enterprise-200', deviceType: 'CPE', isDefault: false,
    parameters: {
      ipMode: 'Static', ipAddress: '10.30.1.100', subnetMask: '255.255.255.0', gateway: '10.30.1.254', dnsServer: '10.0.0.1',
      vlanId: 300, vlanPriority: 5,
      qosProfile: 'EF', ulBandwidthLimit: 200, dlBandwidthLimit: 200,
      snmpCommunity: 'corp-rw', ntpServer: '10.0.0.5', timezone: 'Asia/Kolkata', logLevel: 'WARN',
    },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl-idu-p2p', name: 'IDU-P2P-Backhaul', deviceType: 'IDU', isDefault: false,
    parameters: {
      ipMode: 'Static', ipAddress: '192.168.100.1', subnetMask: '255.255.255.252', gateway: '192.168.100.2',
      vlanId: 400, vlanPriority: 7,
      snmpCommunity: 'backhaul', ntpServer: 'pool.ntp.org', logLevel: 'INFO',
    },
    createdAt: new Date().toISOString(),
  },
];
let nextTplId  = 3;
let jobs       = {};
let nextJobId  = 1;

// ── Templates ────────────────────────────────────────────────────────────────
router.get('/templates', (_req, res) => res.json(templates));

router.post('/templates', (req, res) => {
  const { name, deviceType, parameters, description, isDefault } = req.body || {};
  if (!name) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
  const tpl = { id: `tpl-${nextTplId++}`, name, description: description || '', deviceType: deviceType || 'BTS', isDefault: isDefault || false, parameters: parameters || {}, createdAt: new Date().toISOString() };
  templates.push(tpl);
  res.status(201).json(tpl);
});

router.put('/templates/:id', (req, res) => {
  const idx = templates.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'NOT_FOUND', message: 'Template not found' });
  templates[idx] = { ...templates[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  res.json(templates[idx]);
});

router.delete('/templates/:id', (req, res) => {
  const idx = templates.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'NOT_FOUND', message: 'Template not found' });
  templates.splice(idx, 1);
  res.status(204).end();
});

// ── Push (single device) ─────────────────────────────────────────────────────
router.post('/push/:deviceId', (req, res) => {
  const { deviceId }  = req.params;
  const { templateId, firmware, firmwareVersion } = req.body || req.query || {};
  const jobId = `job-${nextJobId++}`;
  const job = {
    jobId, deviceId, templateId, firmwareVersion,
    status: 'QUEUED', startedAt: new Date().toISOString(), completedAt: null,
    devices: [{ deviceId, status: 'QUEUED' }],
  };
  jobs[jobId] = job;
  // Simulate async completion
  setTimeout(() => {
    jobs[jobId].status        = 'COMPLETED';
    jobs[jobId].completedAt   = new Date().toISOString();
    jobs[jobId].devices[0].status = 'SUCCESS';
  }, 2000);
  res.json({ jobId, status: 'QUEUED', message: firmware ? 'Firmware upgrade queued' : 'Config push queued' });
});

// ── Bulk push ─────────────────────────────────────────────────────────────────
router.post('/bulk-push', (req, res) => {
  const { templateId, deviceType, deviceIds } = req.body || {};
  const jobId = `job-${nextJobId++}`;
  const targets = (deviceIds || []).map((id) => ({ deviceId: id, status: 'QUEUED' }));
  const job = {
    jobId, templateId, deviceType, status: 'RUNNING',
    startedAt: new Date().toISOString(), completedAt: null, devices: targets,
  };
  jobs[jobId] = job;
  setTimeout(() => {
    jobs[jobId].status = 'COMPLETED';
    jobs[jobId].completedAt = new Date().toISOString();
    jobs[jobId].devices.forEach((d) => { d.status = 'SUCCESS'; });
  }, 3000);
  res.json({ jobId, status: 'RUNNING', total: targets.length });
});

// ── Job status ────────────────────────────────────────────────────────────────
router.get('/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found' });
  res.json(job);
});

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

'use strict';

/**
 * Admin stub router — handles endpoints not yet backed by a dedicated microservice.
 * Serves real-ish mock data so the UI works fully during development.
 * Mounted at /api/v1/admin and /api/v1/organizations and /api/v1/nms
 */
const express = require('express');
const router  = express.Router();

// ── In-memory stores (reset on gateway restart) ───────────────────────────────
let northboundConfig = {
  netcool:  { enabled: false, host: 'netcool.local', port: 9999, username: 'omnibus' },
  mycom:    { enabled: false, host: 'mycom.local',   port: 8080, apiKey: '' },
  mobinet:  { enabled: false, url: '',               apiKey: '' },
  syslog:   { enabled: false, host: 'siem.local',    port: 514,  protocol: 'UDP' },
  niam:     { enabled: false, ldapUrl: '',           baseDn: '',  bindDn: '' },
};

let backups = [];
let nextBackupId = 1;

let organizations = [
  { id: 'org-1', name: 'Airtel UBR — North',  description: 'Northern circle operations', createdAt: new Date().toISOString() },
  { id: 'org-2', name: 'Airtel UBR — South',  description: 'Southern circle operations', createdAt: new Date().toISOString() },
];

let hierarchies = {
  'org-1': [
    { id: 'hv-1', name: 'Haryana Network',  organizationId: 'org-1', description: 'Haryana state hierarchy', createdAt: new Date().toISOString() },
    { id: 'hv-2', name: 'Punjab Network',   organizationId: 'org-1', description: 'Punjab state hierarchy',   createdAt: new Date().toISOString() },
  ],
  'org-2': [
    { id: 'hv-3', name: 'Karnataka Network',organizationId: 'org-2', description: 'Karnataka state hierarchy',createdAt: new Date().toISOString() },
  ],
};

let networks = {
  'hv-1': [
    { id: 'net-1', name: 'Gurgaon Cluster',  hierarchyViewId: 'hv-1', organizationId: 'org-1', createdAt: new Date().toISOString() },
    { id: 'net-2', name: 'Faridabad Cluster', hierarchyViewId: 'hv-1', organizationId: 'org-1', createdAt: new Date().toISOString() },
  ],
  'hv-2': [
    { id: 'net-3', name: 'Chandigarh Cluster', hierarchyViewId: 'hv-2', organizationId: 'org-1', createdAt: new Date().toISOString() },
  ],
};

// ── /api/v1/admin/redundancy ──────────────────────────────────────────────────
router.get('/redundancy', (_req, res) => {
  const now = new Date().toISOString();
  res.json({
    sites: [
      {
        name: 'Site A — Primary', role: 'PRIMARY', ipAddress: '10.0.1.100',
        status: 'ACTIVE', syncStatus: 'IN_SYNC', lastSyncAt: now,
        cpuPct: Math.floor(20 + Math.random() * 15),
        memPct: Math.floor(35 + Math.random() * 20),
      },
      {
        name: 'Site B — Secondary', role: 'STANDBY', ipAddress: '10.0.2.100',
        status: 'STANDBY', syncStatus: 'IN_SYNC', lastSyncAt: now,
        cpuPct: Math.floor(8 + Math.random() * 10),
        memPct: Math.floor(25 + Math.random() * 15),
      },
    ],
    vipAddress: '10.0.0.100',
    heartbeatIntervalSec: 5,
    failoverThresholdMissed: 3,
    maxFailoverTimeSec: 60,
    dbReplication: 'Synchronous (MongoDB replica set)',
    dataLossTolerance: 'Zero (RPO = 0)',
  });
});

router.post('/redundancy/sync', (_req, res) => {
  res.json({ status: 'ok', message: 'Force sync triggered', triggeredAt: new Date().toISOString() });
});

router.post('/redundancy/switchover', (_req, res) => {
  res.json({ status: 'ok', message: 'Manual switchover initiated', triggeredAt: new Date().toISOString() });
});

// ── /api/v1/admin/backups ─────────────────────────────────────────────────────
router.get('/backups', (_req, res) => res.json(backups));

router.post('/backups', (req, res) => {
  const type = req.body?.type || 'FULL';
  const record = {
    id: `bkp-${nextBackupId++}`,
    name: `backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-${type.toLowerCase()}`,
    createdAt: new Date().toISOString(),
    sizeBytes: Math.floor(50_000_000 + Math.random() * 200_000_000),
    status: 'COMPLETED',
    type,
  };
  backups.unshift(record);
  res.status(201).json(record);
});

router.post('/backups/:id/restore', (req, res) => {
  const b = backups.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Backup not found' });
  res.json({ status: 'ok', message: `Restore from ${b.name} initiated`, startedAt: new Date().toISOString() });
});

router.delete('/backups/:id', (req, res) => {
  const before = backups.length;
  backups = backups.filter((x) => x.id !== req.params.id);
  if (backups.length === before) return res.status(404).json({ error: 'Backup not found' });
  res.status(204).end();
});

// ── /api/v1/admin/northbound ──────────────────────────────────────────────────
router.get('/northbound', (_req, res) => res.json(northboundConfig));

router.put('/northbound', (req, res) => {
  northboundConfig = { ...northboundConfig, ...req.body };
  res.json(northboundConfig);
});

// ── /api/v1/audit ─────────────────────────────────────────────────────────────
// Note: mounted separately at /api/v1/audit in app.js; this handles the case
// when the real audit service is unreachable.
const AUDIT_ACTIONS = ['LOGIN','LOGOUT','CREATE_USER','DELETE_USER','UPDATE_USER','RESET_PASSWORD',
  'PUSH_CONFIG','BULK_PUSH','FIRMWARE_UPGRADE','ACK_ALARM','CLEAR_ALARM','BACKUP_CREATE','REDUNDANCY_SYNC'];
const AUDIT_RESOURCES = ['USER','DEVICE','CONFIG','ALARM','BACKUP','REDUNDANCY'];

function makeAuditEntry(i) {
  const ts = new Date(Date.now() - i * 180_000).toISOString();
  const action = AUDIT_ACTIONS[i % AUDIT_ACTIONS.length];
  const resource = AUDIT_RESOURCES[i % AUDIT_RESOURCES.length];
  return {
    id: `audit-${i + 1}`,
    timestamp: ts,
    actor: i % 5 === 0 ? 'operator' : 'admin',
    action,
    resource,
    resourceId: `${resource.toLowerCase()}-${100 + i}`,
    outcome: i % 7 === 0 ? 'FAILURE' : 'SUCCESS',
    ipAddress: `10.0.${Math.floor(i / 10) % 10}.${50 + (i % 200)}`,
    detail: `${action} performed on ${resource}`,
  };
}
const AUDIT_LOG = Array.from({ length: 100 }, (_, i) => makeAuditEntry(i));

router.get('/audit-stub', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(AUDIT_LOG.slice(0, limit));
});

module.exports = router;

'use strict';

/**
 * Diagnostics stub — NMS-AS-04/05/06/08
 * Provides mock responses for all diagnostics endpoints while the
 * Java diagnostics-service is unavailable.
 */

const express = require('express');
const router  = express.Router();

const LOG_LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
const LOG_SOURCES = ['kernel', 'wlan0', 'dhcpd', 'syslog', 'watchdog', 'ntp', 'snmpd'];
const LOG_MESSAGES = [
  'Interface wlan0 link up — associated to AP',
  'DHCP lease renewed for 192.168.1.45',
  'NTP sync successful — offset 2.3ms',
  'CPU utilization spike: 87% — throttling',
  'Beacon interval adjusted to 100ms',
  'SNMP trap sent to 10.0.0.1',
  'Radio channel scan completed — selected channel 44',
  'Watchdog heartbeat OK',
  'Memory usage: 342MB / 512MB (66%)',
  'Firmware integrity check passed',
  'Client disassociation: reason=4 (inactivity)',
  'TX power set to 23 dBm',
  'DNS query failed for ntp.pool.org — retrying',
  'SSH session opened from 10.0.10.5',
  'Config push received — applying template v3',
];

function fakeLog(level, ts) {
  return {
    timestamp: ts,
    level,
    message: LOG_MESSAGES[Math.floor(Math.random() * LOG_MESSAGES.length)],
    source:  LOG_SOURCES[Math.floor(Math.random() * LOG_SOURCES.length)],
  };
}

// POST /diagnostics/:deviceId/logs
router.post('/:deviceId/logs', (req, res) => {
  const { deviceId } = req.params;
  const lines  = Math.min(parseInt(req.body?.lines ?? 200, 10), 1000);
  const level  = (req.body?.level ?? '').toUpperCase();

  const now = Date.now();
  let logs = Array.from({ length: lines }, (_, i) => {
    const lvl = LOG_LEVELS[Math.floor(Math.random() * LOG_LEVELS.length)];
    return fakeLog(lvl, new Date(now - i * 3_000).toISOString());
  }).reverse();

  // Apply level filter if specified
  if (level && level !== 'ALL') {
    const order = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const minIdx = order.indexOf(level);
    if (minIdx >= 0) logs = logs.filter((l) => order.indexOf(l.level) >= minIdx);
  }

  res.json(logs);
});

// POST /diagnostics/:deviceId/speed-test
router.post('/:deviceId/speed-test', (req, res) => {
  const { deviceId } = req.params;
  res.json({
    deviceId,
    downloadMbps:   +(50 + Math.random() * 200).toFixed(2),
    uploadMbps:     +(20 + Math.random() * 80).toFixed(2),
    latencyMs:      +(5  + Math.random() * 30).toFixed(1),
    packetLossPct:  +(Math.random() * 1.5).toFixed(2),
    testedAt:       new Date().toISOString(),
    status:         'SUCCESS',
  });
});

// POST /diagnostics/:deviceId/spectrum-analysis
router.post('/:deviceId/spectrum-analysis', (req, res) => {
  const { deviceId } = req.params;
  const freqs = [5180, 5200, 5220, 5240, 5260, 5280, 5300, 5320, 5500, 5520, 5540, 5560, 5580, 5600, 5620, 5640, 5660, 5680, 5700, 5720, 5745, 5765, 5785, 5805, 5825];
  res.json({
    deviceId,
    capturedAt: new Date().toISOString(),
    status: 'SUCCESS',
    buckets: freqs.map((f) => ({
      frequencyMHz:          f,
      powerDbm:              +(-95 + Math.random() * 50).toFixed(1),
      channelUtilizationPct: +(Math.random() * 80).toFixed(1),
    })),
  });
});

// GET /diagnostics/missing-data
router.get('/missing-data', (_req, res) => {
  const serials = [
    ['dev-cpe-dn-099', 'CPE-A61-000099'],
    ['dev-bts-dn-010', 'BTS-A60-000010'],
    ['dev-cpe-ds-045', 'CPE-A61-000045'],
  ];
  const now = Date.now();
  res.json(serials.map(([id, sn], i) => ({
    deviceId:       id,
    serialNumber:   sn,
    lastReportedAt: i === 0 ? null : new Date(now - (i * 7_200_000)).toISOString(),
    missedCycles:   [12, 3, 7][i],
  })));
});

// ── WO-012: Firmware Upgrade Operations ───────────────────────────────────

// POST /operations/devices/:deviceId/firmware-upgrade
router.post('/operations/devices/:deviceId/firmware-upgrade', (req, res) => {
  const { deviceId } = req.params;
  const { expectedVersion, imageRef, checksumAlgorithm, checksumValue, transferMethod } = req.body;

  if (!expectedVersion || !imageRef || !checksumAlgorithm || !checksumValue || !transferMethod) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'VALIDATION_ERROR', message: 'Missing required fields' },
    });
  }

  const jobId = `fw-job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  res.status(202).json({
    jobId,
    status: 'PENDING',
    firmwarePhase: 'ACCEPTED',
    acceptedAt: new Date().toISOString(),
    precheckState: 'PENDING',
    trackingUrl: `/api/v1/operations/firmware-jobs/${jobId}`,
  });
});

// GET /operations/firmware-jobs/:jobId
router.get('/operations/firmware-jobs/:jobId', (req, res) => {
  const { jobId } = req.params;

  // Simulate firmware job phases
  const phases = ['ACCEPTED', 'PRECHECK', 'TRANSFER', 'CHECKSUM_VERIFY', 'INSTALL', 'REBOOT_WAIT', 'POSTCHECK', 'SUCCEEDED'];
  const randomPhaseIdx = Math.floor(Math.random() * phases.length);
  const phase = phases[randomPhaseIdx];
  const isComplete = phase === 'SUCCEEDED';

  res.json({
    id: jobId,
    deviceId: 'dev-bts-dn-010',
    imageRef: 'firmware-images/ubr-bts-a60-v3.5.2.1.bin',
    expectedVersion: '3.5.2.1',
    checksumAlgorithm: 'SHA256',
    transferMethod: 'HTTP',
    actor: 'operator',
    role: 'network_engineer',
    firmwarePhase: phase,
    status: isComplete ? 'COMPLETED' : 'IN_PROGRESS',
    transferProgress: phase === 'TRANSFER' ? Math.floor(Math.random() * 100) : 100,
    checksumVerified: ['CHECKSUM_VERIFY', 'INSTALL', 'REBOOT_WAIT', 'POSTCHECK', 'SUCCEEDED'].includes(phase),
    observedVersion: isComplete ? '3.5.2.1' : null,
    discrepancy: false,
    retryable: true,
    compatibilityDecision: 'COMPATIBLE',
    acceptedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    completedAt: isComplete ? new Date().toISOString() : null,
    durationMs: isComplete ? 5 * 60 * 1000 : null,
  });
});

// GET /operations/devices/:deviceId/firmware-jobs
router.get('/operations/devices/:deviceId/firmware-jobs', (req, res) => {
  const { deviceId } = req.params;

  res.json([
    {
      id: 'fw-job-001',
      deviceId,
      expectedVersion: '3.5.2.1',
      firmwarePhase: 'SUCCEEDED',
      status: 'COMPLETED',
      acceptedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString(),
      discrepancy: false,
    },
    {
      id: 'fw-job-002',
      deviceId,
      expectedVersion: '3.5.1.0',
      firmwarePhase: 'FAILED',
      status: 'FAILED',
      failureReason: 'Checksum verification failed',
      acceptedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 3 * 60 * 1000).toISOString(),
    },
  ]);
});

module.exports = router;

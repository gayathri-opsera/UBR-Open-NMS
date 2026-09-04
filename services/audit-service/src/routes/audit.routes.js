const router = require('express').Router();
const config = require('../config');
const auditService = require('../services/audit.service');
const { forward } = require('../services/syslog.forwarder');
const logger = require('../utils/logger');

// POST /api/v1/audit/events — direct REST ingest (inter-service)
router.post('/events', async (req, res) => {
  try {
    const entry = await auditService.ingestEvent(req.body);
    forward(entry);
    res.status(201).json({ status: 'ok', id: entry._id });
  } catch (err) {
    logger.error('Failed to ingest audit event', { error: err.message });
    if (err.message.includes('Missing required')) {
      return res.status(400).json({ status: 'error', error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to persist audit event' } });
  }
});

// GET /api/v1/audit/logs — query with filters
router.get('/logs', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Admin role required' } });
  }
  try {
    const { actor, action, resource, startTime, endTime, correlationId, offset, limit } = req.query;
    const result = await auditService.queryLogs({ actor, action, resource, startTime, endTime, correlationId, offset, limit });
    res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error('Failed to query audit logs', { error: err.message });
    res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to query audit logs' } });
  }
});

// GET /api/v1/audit/logs/export — CSV export
router.get('/logs/export', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Admin role required' } });
  }
  try {
    const { actor, action, resource, startTime, endTime } = req.query;
    const records = await auditService.exportLogs(
      { actor, action, resource, startTime, endTime },
      config.audit.maxExportRows
    );

    const { Parser } = require('json2csv');
    const fields = ['actor', 'timestamp', 'action', 'resource', 'resourceId', 'result', 'sourceIp', 'correlationId', 'serviceSource', 'retentionClass'];
    const parser = new Parser({ fields });
    const csv = parser.parse(records);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send(csv);
  } catch (err) {
    logger.error('Failed to export audit logs', { error: err.message });
    res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to export audit logs' } });
  }
});

/**
 * Retention policy catalog (WO-008).
 * Application-level definitions — not infrastructure retention rules.
 * Accessible to admin, compliance, and auditor roles.
 */
const RETENTION_POLICIES = [
  {
    retentionClass: 'audit',
    displayName: 'Audit Log',
    minimumRetentionDays: 365,
    applicableRecordTypes: ['admin_action', 'login', 'logout'],
  },
  {
    retentionClass: 'security',
    displayName: 'Security Evidence',
    minimumRetentionDays: 365,
    applicableRecordTypes: ['southbound.auth.failure', 'southbound.hmac.failure', 'capability.denied'],
  },
  {
    retentionClass: 'onboarding',
    displayName: 'Onboarding Record',
    minimumRetentionDays: 365,
    applicableRecordTypes: ['onboarding.attempt', 'onboarding.rejected'],
  },
  {
    retentionClass: 'alarm_incident',
    displayName: 'Alarm Incident',
    minimumRetentionDays: 180,
    applicableRecordTypes: ['alarm_raised', 'alarm_cleared'],
  },
  {
    retentionClass: 'config_history',
    displayName: 'Configuration History',
    minimumRetentionDays: 365,
    applicableRecordTypes: ['config.push', 'config.rollback'],
  },
  {
    retentionClass: 'evidence_export',
    displayName: 'Evidence Export',
    minimumRetentionDays: 365,
    applicableRecordTypes: ['evidence.exported'],
  },
];

// GET /api/v1/audit/retention-policies — retention policy catalog (WO-008)
router.get('/retention-policies', (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  const allowed = ['admin', 'compliance', 'auditor'];
  if (!allowed.includes(role)) {
    return res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN', message: 'Admin, compliance, or auditor role required' },
    });
  }
  res.json({ status: 'ok', data: RETENTION_POLICIES });
});

module.exports = router;
module.exports.RETENTION_POLICIES = RETENTION_POLICIES;

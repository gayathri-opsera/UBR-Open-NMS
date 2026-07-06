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
    const fields = ['actor', 'timestamp', 'action', 'resource', 'resourceId', 'result', 'sourceIp', 'correlationId', 'serviceSource'];
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

module.exports = router;

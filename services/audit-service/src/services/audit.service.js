const AuditEntry = require('../models/audit-entry.model');
const logger = require('../utils/logger');

/**
 * Persist a single audit event to MongoDB.
 */
async function ingestEvent(eventData) {
  const {
    actor,
    timestamp,
    action,
    resource,
    resourceId,
    result,
    sourceIp,
    changeDetails,
    correlationId,
    serviceSource,
  } = eventData;

  if (!actor || !action || !resource || !result) {
    throw new Error('Missing required audit event fields: actor, action, resource, result');
  }

  const entry = new AuditEntry({
    actor,
    timestamp: timestamp ? new Date(timestamp) : new Date(),
    action,
    resource,
    resourceId,
    result,
    sourceIp,
    changeDetails,
    correlationId,
    serviceSource,
  });

  await entry.save();
  logger.info('Audit event persisted', { actor, action, resource, resourceId, correlationId });
  return entry;
}

/**
 * Query audit logs with optional filters + pagination.
 */
async function queryLogs({ actor, action, resource, startTime, endTime, correlationId, offset = 0, limit = 50 } = {}) {
  const filter = {};
  if (actor) filter.actor = actor;
  if (action) filter.action = action;
  if (resource) filter.resource = resource;
  if (correlationId) filter.correlationId = correlationId;
  if (startTime || endTime) {
    filter.timestamp = {};
    if (startTime) filter.timestamp.$gte = new Date(startTime);
    if (endTime) filter.timestamp.$lte = new Date(endTime);
  }

  const [data, total] = await Promise.all([
    AuditEntry.find(filter)
      .sort({ timestamp: -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .lean(),
    AuditEntry.countDocuments(filter),
  ]);

  return { data, pagination: { total, offset: Number(offset), limit: Number(limit) } };
}

/**
 * Export audit logs as an array of plain objects for CSV conversion.
 */
async function exportLogs(filters = {}, maxRows = 10000) {
  const { actor, action, resource, startTime, endTime } = filters;
  const filter = {};
  if (actor) filter.actor = actor;
  if (action) filter.action = action;
  if (resource) filter.resource = resource;
  if (startTime || endTime) {
    filter.timestamp = {};
    if (startTime) filter.timestamp.$gte = new Date(startTime);
    if (endTime) filter.timestamp.$lte = new Date(endTime);
  }

  const records = await AuditEntry.find(filter)
    .sort({ timestamp: -1 })
    .limit(maxRows)
    .lean();

  return records;
}

module.exports = { ingestEvent, queryLogs, exportLogs };

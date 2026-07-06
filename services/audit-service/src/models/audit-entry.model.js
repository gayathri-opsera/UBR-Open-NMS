const mongoose = require('mongoose');
const config = require('../config');

const auditEntrySchema = new mongoose.Schema(
  {
    actor: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now },
    action: {
      type: String,
      required: true,
      enum: ['CREATE', 'READ', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'CONFIG_PUSH', 'EXPORT', 'ADMIN'],
      index: true,
    },
    resource: { type: String, required: true, index: true },
    resourceId: { type: String, index: true },
    result: { type: String, required: true, enum: ['SUCCESS', 'FAILURE'] },
    sourceIp: { type: String },
    changeDetails: { type: mongoose.Schema.Types.Mixed },
    correlationId: { type: String, index: true },
    serviceSource: { type: String },
  },
  {
    versionKey: false,
    collection: 'audit_logs',
  }
);

// TTL index — documents expire after configured days (default 365)
auditEntrySchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: (config.audit.ttlDays || 365) * 86400 }
);

// Prevent any updates or deletes at model level via middleware
auditEntrySchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany'], function () {
  throw new Error('Audit log records are immutable and cannot be modified or deleted.');
});

const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);

module.exports = AuditEntry;

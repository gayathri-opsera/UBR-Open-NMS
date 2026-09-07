'use strict';

const mongoose = require('mongoose');
const config = require('../config');

/**
 * Sensitive field names that must be redacted from audit payloads (WO-006).
 * Any payload key matching one of these patterns is removed before persistence.
 */
const REDACTED_FIELD_PATTERNS = [
  /password/i, /token/i, /secret/i, /signature/i,
  /hmac/i, /privateKey/i, /private_key/i, /cert/i,
  /credential/i,
];

/**
 * Redact sensitive fields from an audit payload object (WO-006).
 * Returns a sanitised copy — the original object is not mutated.
 *
 * @param {object|null} payload  The audit payload to sanitise
 * @returns {object} A shallow-copy with sensitive keys removed
 */
function redact(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const sanitised = { ...payload };
  for (const key of Object.keys(sanitised)) {
    if (REDACTED_FIELD_PATTERNS.some((p) => p.test(key))) {
      delete sanitised[key];
    } else if (typeof sanitised[key] === 'object' && sanitised[key] !== null) {
      sanitised[key] = redact(sanitised[key]);
    }
  }
  return sanitised;
}

const auditEntrySchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      // Accept both legacy flat string and new structured object format.
      // System actor: { userId: "system", username: serviceId, role: "system" }
    },
    timestamp: { type: Date, required: true, default: Date.now },
    action: {
      type: String,
      required: true,
      enum: [
        // ── Legacy CRUD actions ──────────────────────────────────────────────
        'CREATE', 'READ', 'UPDATE', 'DELETE',
        'LOGIN', 'LOGOUT', 'LOGIN_FAILED',
        'CONFIG_PUSH', 'EXPORT', 'ADMIN',
        // ── WO-006: Discovery mode governance ────────────────────────────────
        'discovery.mode.changed',
        'discovery.mode.change.denied',
        // ── WO-006: Onboarding ───────────────────────────────────────────────
        'onboarding.attempt',
        'onboarding.rejected',
        'onboarding.assignment.override',
        // ── WO-006: Southbound security ──────────────────────────────────────
        'southbound.auth.failure',
        'southbound.hmac.failure',
        'southbound.mtls.failure',
        // ── WO-006: Capability ───────────────────────────────────────────────
        'capability.denied',
        'capability.policy.read',
        // ── WO-006: Config/credential ────────────────────────────────────────
        'config.withheld',
        'credential.ref.accessed',
        // ── WO-006: Evidence export ──────────────────────────────────────────
        'evidence.exported',
        'evidence.export.denied',
        // ── WO-020: SSO lifecycle ────────────────────────────────────────────
        'sso.login.initiated',
        'sso.login.success',
        'sso.login.failed',
        'sso.config.updated',
        // ── WO-020: MFA lifecycle ────────────────────────────────────────────
        'mfa.enrolled',
        'mfa.challenge.success',
        'mfa.challenge.failed',
        'mfa.disabled',
        'mfa.backup_code.used',
        // ── WO-020: Password governance ──────────────────────────────────────
        'password.expired',
        'password.renewed',
        'password.policy.violated',
        'password.reset.initiated',
        // ── WO-020: Role and identity governance ─────────────────────────────
        'role.changed',
        'permission.changed',
        'identity.provider.changed',
        // ── WO-020: Access control ───────────────────────────────────────────
        'access.denied',
        'access.partial',
      ],
      index: true,
    },
    resource: { type: String, required: true, index: true },
    resourceId: { type: String, index: true },
    // WO-006: structured resource object (replaces flat string in new schema)
    resourceObj: { type: mongoose.Schema.Types.Mixed },
    result: {
      type: String,
      // Legacy field: SUCCESS / FAILURE
      enum: ['SUCCESS', 'FAILURE', null],
    },
    outcome: {
      type: String,
      // WO-006 extended: blocked and pending added alongside success/failure/denied
      enum: ['success', 'failure', 'denied', 'blocked', 'pending', null],
      index: true,
    },
    sourceIp: { type: String },
    changeDetails: { type: mongoose.Schema.Types.Mixed },
    correlationId: { type: String, index: true },
    serviceSource: { type: String },
    // WO-006: payload is automatically redacted before persistence
    payload: { type: mongoose.Schema.Types.Mixed },
    errorMessage: { type: String },
    // WO-008: retention class
    retentionClass: {
      type: String,
      enum: ['audit', 'security', 'onboarding', 'alarm_incident',
             'config_history', 'evidence_export', 'legacy', null],
    },
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
auditEntrySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany'],
  function () {
    throw new Error('Audit log records are immutable and cannot be modified or deleted.');
  }
);

// WO-006: Redact sensitive fields from payload before save
auditEntrySchema.pre('save', function () {
  if (this.payload) {
    this.payload = redact(this.payload);
  }
});

const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);

module.exports = AuditEntry;
module.exports.redact = redact;
module.exports.REDACTED_FIELD_PATTERNS = REDACTED_FIELD_PATTERNS;

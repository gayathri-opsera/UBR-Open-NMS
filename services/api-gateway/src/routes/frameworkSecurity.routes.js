'use strict';

/**
 * WO-005: Framework Security — Credential Reference API
 *
 * Exposes northbound-safe credential management under:
 *   /api/framework/v1/security/credential-references
 *
 * Contract:
 *   POST   /               — create a new credential reference (secret is write-only)
 *   GET    /               — list all credential references (safe metadata only)
 *   GET    /:credentialRef — read one credential reference (safe metadata only)
 *   PUT    /:credentialRef — update metadata or rotate the secret (secret is write-only)
 *
 * Security invariants (WO-005 constraints):
 *   - Secrets are encrypted at rest using AES-256-GCM via aesEncrypt.js.
 *   - Secret values are NEVER returned in any response, log, or audit payload.
 *   - Audit events are emitted for every create and update with redacted metadata.
 *   - A missing credentialRef returns 404 without revealing other valid identifiers.
 *   - Encryption or persistence failure returns a sanitised error — never the input.
 *
 * Requires framework SuperAdmin capability (requireFrameworkCapability(3, ...)) on
 * create/update; list/read requires SuperAdmin as well because this is sensitive metadata.
 */

const express  = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const { encrypt }                     = require('../utils/aesEncrypt');
const { redactObject }                = require('../utils/secretRedact');
// detectCredentials is NOT applied here — this route intentionally accepts write-only
// secret values that are immediately encrypted. It is applied to Product Definition uploads.
const { requireFrameworkCapability, FRAMEWORK_CAPABILITY } = require('../middleware/rbac.middleware');
const logger                          = require('../utils/logger');

const router = express.Router();

// ── MongoDB connection ────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI_CONFIG
  || process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubrnms_config';

let _col = null;

async function getCol() {
  if (_col) return _col;
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection('framework_credential_refs');
    return _col;
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  _col = mongoose.connection.db.collection('framework_credential_refs');
  return _col;
}

getCol().catch((e) =>
  logger.error({ msg: '[framework-security] MongoDB connect failed', err: e.message }),
);

// ── Supported credential types ────────────────────────────────────────────────

const ALLOWED_TYPES = new Set([
  'snmp_v2c',
  'snmp_v3',
  'ssh_password',
  'ssh_key',
  'rest_api_key',
  'rest_bearer',
  'netconf_password',
  'grpc_mtls',
]);

// ── Sensitive field names that are accepted as write-only input ───────────────
// These are stripped before any document is stored in the safe metadata fields.
// The encrypted envelope is stored separately.
const WRITE_ONLY_SECRET_KEYS = new Set([
  'community', 'password', 'privateKey', 'apiKey', 'token', 'bearerToken',
  'authKey', 'secretValue', 'secret',
]);

// ── Safe response DTO ─────────────────────────────────────────────────────────

/**
 * Project a stored document to the safe public shape.
 * The `encryptedSecret` field is NEVER included.
 *
 * @param {object} doc - Raw MongoDB document
 * @returns {object}   - Safe DTO with non-sensitive fields only
 */
function toSafeDto(doc) {
  if (!doc) return null;
  return {
    credentialRef:  doc.credentialRef,
    type:           doc.type,
    scope:          doc.scope,
    label:          doc.label || null,
    status:         doc.status,
    healthSummary:  doc.healthSummary || null,
    createdAt:      doc.createdAt,
    updatedAt:      doc.updatedAt,
    lastRotatedAt:  doc.lastRotatedAt || null,
    createdBy:      doc.createdBy,
    updatedBy:      doc.updatedBy || null,
  };
}

// ── Audit emission (fire-and-forget, best-effort) ─────────────────────────────

function emitCredentialAuditEvent(action, actor, credentialRef, credentialType, scope, outcome, correlationId) {
  try {
    const AUDIT_URL = process.env.AUDIT_SERVICE_URL || 'http://nms-audit:3007';
    const payload = JSON.stringify({
      actor:         { userId: actor.userId || actor.sub || 'unknown', role: actor.role || 'unknown' },
      action,
      resource:      'credential_reference',
      resourceId:    credentialRef,
      outcome,
      correlationId,
      timestamp:     new Date().toISOString(),
      serviceSource: 'api-gateway',
      // Safe metadata only — never include secret values
      metadata:      redactObject({ credentialRef, credentialType, scope }),
    });

    const http = require('http');
    const parsed = new URL(AUDIT_URL);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     '/api/v1/audit/events',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  3000,
    };
    const req = http.request(options, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {
    // Non-blocking: audit failure must never cause the API call to fail
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /
 * Create a new credential reference.
 *
 * Request body (all secret fields are write-only):
 *   { type, scope, label?, [community|password|privateKey|apiKey|token|bearerToken] }
 *
 * Returns: 201 { status: 'ok', data: SafeCredentialDto }
 */
router.post(
  '/',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'security.credentials.create'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const actor         = req.user || {};

    try {
      const { type, scope, label, ...rest } = req.body || {};

      // Validate credential type
      if (!type || !ALLOWED_TYPES.has(type)) {
        return res.status(400).json({
          status: 'error',
          error: {
            code:         'INVALID_CREDENTIAL_TYPE',
            message:      `Credential type '${type}' is not supported. Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
            correlationId,
          },
        });
      }

      if (!scope || typeof scope !== 'string' || scope.trim().length === 0) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'MISSING_SCOPE', message: 'scope is required', correlationId },
        });
      }

      // Extract secret value — exactly one write-only field must be present
      let secretValue = null;
      for (const key of WRITE_ONLY_SECRET_KEYS) {
        if (rest[key] !== undefined && rest[key] !== null && rest[key] !== '') {
          secretValue = String(rest[key]);
          break;
        }
      }

      if (!secretValue) {
        return res.status(400).json({
          status: 'error',
          error: {
            code:    'MISSING_SECRET',
            message: 'At least one write-only secret field (community, password, privateKey, apiKey, token, bearerToken) must be provided.',
            correlationId,
          },
        });
      }

      // Encrypt the secret — if this fails, return 503 without echoing the value
      let encryptedSecret;
      try {
        encryptedSecret = encrypt(secretValue);
      } catch (encErr) {
        logger.error({ msg: 'Credential encryption failed', err: encErr.message, correlationId });
        return res.status(503).json({
          status: 'error',
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Secret encryption is currently unavailable. Retry later.', correlationId },
        });
      }

      const credentialRef = uuidv4();
      const now           = new Date().toISOString();

      const doc = {
        credentialRef,
        type:            type.trim(),
        scope:           scope.trim(),
        label:           label || null,
        status:          'active',
        healthSummary:   null,
        encryptedSecret,              // AES-256-GCM envelope — never returned to clients
        createdAt:       now,
        updatedAt:       now,
        lastRotatedAt:   now,
        createdBy:       actor.userId || actor.sub || 'unknown',
        updatedBy:       null,
      };

      const col = await getCol();
      await col.insertOne(doc);

      // Emit a redacted audit event (fire-and-forget)
      emitCredentialAuditEvent(
        'credential_reference.create', actor, credentialRef, type, scope, 'success', correlationId,
      );

      logger.info({
        msg:          'Credential reference created',
        credentialRef,
        type,
        scope,
        actor:        actor.userId || actor.sub,
        correlationId,
      });

      return res.status(201).json({ status: 'ok', data: toSafeDto(doc) });

    } catch (err) {
      logger.error({ msg: 'credential_reference.create failed', err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.', correlationId },
      });
    }
  },
);

/**
 * GET /
 * List all credential references (safe metadata only).
 *
 * Returns: 200 { status: 'ok', data: SafeCredentialDto[] }
 */
router.get(
  '/',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'security.credentials.list'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();

    try {
      const col  = await getCol();
      const docs = await col
        .find({}, { projection: { encryptedSecret: 0 } })
        .sort({ createdAt: -1 })
        .toArray();

      return res.status(200).json({ status: 'ok', data: docs.map(toSafeDto) });

    } catch (err) {
      logger.error({ msg: 'credential_reference.list failed', err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId },
      });
    }
  },
);

/**
 * GET /:credentialRef
 * Read one credential reference (safe metadata only).
 *
 * Returns: 200 { status: 'ok', data: SafeCredentialDto }
 * Returns: 404 if not found — without revealing other valid identifiers
 */
router.get(
  '/:credentialRef',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'security.credentials.get'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { credentialRef } = req.params;

    try {
      const col = await getCol();
      const doc = await col.findOne(
        { credentialRef },
        { projection: { encryptedSecret: 0 } },
      );

      if (!doc) {
        return res.status(404).json({
          status: 'error',
          error: {
            code:    'CREDENTIAL_NOT_FOUND',
            message: 'The requested credential reference does not exist.',
            correlationId,
          },
        });
      }

      return res.status(200).json({ status: 'ok', data: toSafeDto(doc) });

    } catch (err) {
      logger.error({ msg: 'credential_reference.get failed', err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId },
      });
    }
  },
);

/**
 * PUT /:credentialRef
 * Update credential metadata or rotate the secret.
 *
 * Rotation: if any WRITE_ONLY_SECRET_KEYS field is present, the secret is re-encrypted.
 * Metadata-only update: if no secret field is present, the existing encrypted secret
 * is preserved unchanged.
 *
 * Returns: 200 { status: 'ok', data: SafeCredentialDto }
 */
router.put(
  '/:credentialRef',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'security.credentials.update'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const actor         = req.user || {};
    const { credentialRef } = req.params;

    try {
      const col = await getCol();
      const existing = await col.findOne({ credentialRef });

      if (!existing) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'CREDENTIAL_NOT_FOUND', message: 'The requested credential reference does not exist.', correlationId },
        });
      }

      const { scope, label, status, ...rest } = req.body || {};
      const now = new Date().toISOString();

      const $set = {
        updatedAt: now,
        updatedBy: actor.userId || actor.sub || 'unknown',
      };

      if (scope && typeof scope === 'string') $set.scope = scope.trim();
      if (label !== undefined) $set.label = label || null;
      if (status && ['active', 'inactive', 'revoked'].includes(status)) $set.status = status;

      // Secret rotation — only if a new write-only field is provided
      let rotated = false;
      let newSecretValue = null;
      for (const key of WRITE_ONLY_SECRET_KEYS) {
        if (rest[key] !== undefined && rest[key] !== null && rest[key] !== '') {
          newSecretValue = String(rest[key]);
          break;
        }
      }

      if (newSecretValue) {
        try {
          $set.encryptedSecret = encrypt(newSecretValue);
          $set.lastRotatedAt   = now;
          rotated = true;
        } catch (encErr) {
          logger.error({ msg: 'Secret rotation encryption failed', err: encErr.message, correlationId });
          return res.status(503).json({
            status: 'error',
            error: { code: 'SERVICE_UNAVAILABLE', message: 'Secret encryption is currently unavailable. The previous secret has been preserved. Retry later.', correlationId },
          });
        }
      }

      await col.updateOne({ credentialRef }, { $set });

      const updated = await col.findOne({ credentialRef }, { projection: { encryptedSecret: 0 } });

      emitCredentialAuditEvent(
        rotated ? 'credential_reference.rotate' : 'credential_reference.update',
        actor, credentialRef, existing.type, updated.scope, 'success', correlationId,
      );

      logger.info({
        msg:          rotated ? 'Credential reference rotated' : 'Credential reference updated',
        credentialRef,
        rotated,
        actor:        actor.userId || actor.sub,
        correlationId,
      });

      return res.status(200).json({ status: 'ok', data: toSafeDto(updated) });

    } catch (err) {
      logger.error({ msg: 'credential_reference.update failed', err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId },
      });
    }
  },
);

module.exports = router;

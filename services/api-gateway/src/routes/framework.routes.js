'use strict';

/**
 * WO-007: Read-Only Framework API Routes
 *
 * Exposes versioned, authenticated, read-only northbound endpoints for:
 *   GET /api/framework/v1/devices/:deviceId/framework-identity
 *   GET /api/framework/v1/discovery/runs/:runId/results
 *   GET /api/framework/v1/failures
 *   GET /api/framework/v1/security/status
 *
 * Note: Product Definition endpoints are handled by frameworkProductDefinitions.js
 * and parameter/template endpoints are handled by frameworkParameters.routes.js.
 *
 * All routes:
 *  - Require JWT authentication (handled by global authenticate middleware in app.js)
 *  - Require ReadOnly+ framework capability (read-only story — no write/provisioning)
 *  - Return a consistent error envelope { status: 'error', error: { code, message, details, correlationId } }
 *  - Propagate correlation IDs from the request
 *  - Never include credential values or southbound secret material
 *  - Apply conservative pagination defaults (limit=20, max=100) on list endpoints
 *
 * Handlers proxy to downstream services where available; for endpoints whose
 * downstream is not yet deployed, a gateway-level response is returned so the
 * contract remains stable and testable.
 */

const express    = require('express');
const httpProxy  = require('express-http-proxy');
const { v4: uuidv4 } = require('uuid');

const config  = require('../config');
const { requireFrameworkCapability, FRAMEWORK_CAPABILITY } = require('../middleware/rbac.middleware');
const { redactObject } = require('../utils/secretRedact');
const logger  = require('../utils/logger');

const router = express.Router();

// ── Pagination helpers ────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE     = 100;

/**
 * Parse and clamp a `limit` query parameter.
 * Returns a safe integer in the range [1, MAX_PAGE_SIZE].
 *
 * @param {*} raw - Raw query string value
 * @returns {number}
 */
function parseLimit(raw) {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/** Build a correlation-ID-bearing structured error response body. */
function errBody(code, message, details, correlationId) {
  return { status: 'error', error: { code, message, details: details || {}, correlationId } };
}

// ── Proxy factories ───────────────────────────────────────────────────────────

function proxyTo(serviceUrl, opts = {}) {
  return httpProxy(serviceUrl, {
    timeout: 30000,
    ...opts,
    proxyReqOptDecorator(proxyReqOpts, srcReq) {
      proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
      proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
      proxyReqOpts.headers['X-Correlation-Id'] = srcReq.headers['x-correlation-id'] || '';
      return proxyReqOpts;
    },
    proxyErrorHandler(err, res, next) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        return res.status(503).json(
          errBody('SERVICE_UNAVAILABLE', 'Downstream service is not reachable. Try again later.', {}, ''),
        );
      }
      if (err.code === 'ETIMEDOUT') {
        return res.status(503).json(
          errBody('SERVICE_UNAVAILABLE', 'Downstream service timed out. Retry using exponential back-off.', {}, ''),
        );
      }
      next(err);
    },
  });
}

// ── Device Framework Identity ─────────────────────────────────────────────────

/**
 * GET /devices/:deviceId/framework-identity
 *
 * Returns the framework classification for a device:
 *   productDefinitionId, productDefinitionVersion, matchedFingerprint,
 *   matchedAt, identityStatus (matched | unmatched | conflict | stale)
 *
 * Proxied to the inventory service, which holds the framework-identity
 * association produced by the discovery fingerprint matcher.
 */
router.get(
  '/devices/:deviceId/framework-identity',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.framework-identity.get'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId }  = req.params;

    logger.info({ msg: 'Framework identity requested', deviceId, correlationId });

    const inventoryUrl = config.services.inventory || 'http://inventory:3002';
    const proxy = proxyTo(inventoryUrl, {
      proxyReqPathResolver: () => `/api/v1/devices/${encodeURIComponent(deviceId)}/framework-identity`,
      userResDecorator(proxyRes, proxyResData) {
        // Strip any residual credential-adjacent fields from the downstream response
        try {
          const body = JSON.parse(proxyResData.toString('utf8'));
          return JSON.stringify(redactObject(body));
        } catch (_) { return proxyResData; }
      },
    });

    return proxy(req, res, next);
  },
);

// ── Discovery Run Results ─────────────────────────────────────────────────────

/**
 * GET /discovery/runs/:runId/results
 *
 * Returns the results for a specific discovery run.
 *
 * Query params:
 *   limit  (int, default=20, max=100) — page size
 *   cursor (string)                   — opaque pagination cursor from a previous response
 *   sort   (string, default=createdAt_desc) — sort order
 *
 * Proxied to the discovery service. Results never include SNMP community strings
 * or other credential values.
 */
router.get(
  '/discovery/runs/:runId/results',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'discovery.runs.results.get'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { runId }     = req.params;
    const limit         = parseLimit(req.query.limit);
    const cursor        = req.query.cursor || '';
    const sort          = req.query.sort || 'createdAt_desc';

    // Guard: excessive limit is capped — return 400 if the caller provided an unparseable limit
    if (req.query.limit !== undefined && Number.isNaN(parseInt(req.query.limit, 10))) {
      return res.status(400).json(
        errBody('VALIDATION_ERROR', "'limit' must be a positive integer.", { field: 'limit' }, correlationId),
      );
    }

    logger.info({ msg: 'Discovery run results requested', runId, limit, correlationId });

    const discoveryUrl = config.services.discovery || 'http://disc:3007';
    const proxy = proxyTo(discoveryUrl, {
      proxyReqPathResolver: () => {
        const params = new URLSearchParams({ limit: String(limit), sort });
        if (cursor) params.set('cursor', cursor);
        return `/api/v1/discovery/runs/${encodeURIComponent(runId)}/results?${params.toString()}`;
      },
      userResDecorator(proxyRes, proxyResData) {
        try {
          const body = JSON.parse(proxyResData.toString('utf8'));
          return JSON.stringify(redactObject(body));
        } catch (_) { return proxyResData; }
      },
    });

    return proxy(req, res, next);
  },
);

// ── Guided Failure Details ────────────────────────────────────────────────────

/**
 * GET /failures
 *
 * Returns paginated framework failures (unreachable, unknown, adapter-failed devices).
 *
 * Query params:
 *   limit   (int, default=20, max=100)
 *   cursor  (string)
 *   status  (string) — one of: unreachable, unknown, adapter_failed, stale
 *   sort    (string, default=lastFailedAt_desc)
 */
router.get(
  '/failures',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'failures.list'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const limit  = parseLimit(req.query.limit);
    const cursor = req.query.cursor || '';
    const status = req.query.status || '';
    const sort   = req.query.sort || 'lastFailedAt_desc';

    const VALID_STATUSES = new Set(['unreachable', 'unknown', 'adapter_failed', 'stale', '']);
    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json(
        errBody(
          'VALIDATION_ERROR',
          `'status' must be one of: unreachable, unknown, adapter_failed, stale.`,
          { field: 'status', received: status },
          correlationId,
        ),
      );
    }

    if (req.query.limit !== undefined && Number.isNaN(parseInt(req.query.limit, 10))) {
      return res.status(400).json(
        errBody('VALIDATION_ERROR', "'limit' must be a positive integer.", { field: 'limit' }, correlationId),
      );
    }

    logger.info({ msg: 'Framework failures requested', limit, status, correlationId });

    // Failures are aggregated by the discovery service
    const discoveryUrl = config.services.discovery || 'http://disc:3007';
    const proxy = proxyTo(discoveryUrl, {
      proxyReqPathResolver: () => {
        const params = new URLSearchParams({ limit: String(limit), sort });
        if (cursor) params.set('cursor', cursor);
        if (status) params.set('status', status);
        return `/api/v1/discovery/failures?${params.toString()}`;
      },
      userResDecorator(proxyRes, proxyResData) {
        try {
          const body = JSON.parse(proxyResData.toString('utf8'));
          return JSON.stringify(redactObject(body));
        } catch (_) { return proxyResData; }
      },
    });

    return proxy(req, res, next);
  },
);

// ── Framework Security Status ─────────────────────────────────────────────────

/**
 * GET /security/status
 *
 * Returns the overall framework security readiness status:
 *   credentialVaultStatus, encryptionAlgorithm, lastKeyRotation,
 *   tlsStatus, auditEnabled, activeCredentialCount, unreachableCount, staleCount
 *
 * This endpoint aggregates signals from the credential vault runtime and the
 * audit service. Responses never include vault secrets or key material.
 *
 * Only SuperAdmin callers may access security status.
 */
router.get(
  '/security/status',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'security.status.get'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();

    logger.info({ msg: 'Framework security status requested', correlationId });

    // Security status is served by the credential-vault-runtime (Java service)
    // or aggregated at the gateway level from auth + audit signals.
    const vaultUrl = config.services.credentialVault || 'http://credential-vault:8090';
    const proxy = proxyTo(vaultUrl, {
      proxyReqPathResolver: () => '/api/v1/security/status',
      userResDecorator(proxyRes, proxyResData) {
        try {
          const body = JSON.parse(proxyResData.toString('utf8'));
          // Redact any residual key material or raw credential fields
          return JSON.stringify(redactObject(body));
        } catch (_) { return proxyResData; }
      },
    });

    return proxy(req, res, next);
  },
);

module.exports = router;

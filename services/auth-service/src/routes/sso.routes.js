'use strict';

/**
 * SSO Routes — tenant-selectable enterprise identity provider (WO-013).
 *
 * Endpoints:
 *   POST   /api/v1/auth/sso/initiate          Initiate an OIDC or SAML login
 *   GET    /api/v1/auth/sso/callback/oidc     OIDC authorization callback
 *   POST   /api/v1/auth/sso/callback/saml     SAML assertion callback
 *   GET    /api/v1/auth/sso/metadata          SAML SP metadata (XML)
 *   GET    /api/v1/auth/sso/config            Read tenant SSO config (admin)
 *   PUT    /api/v1/auth/sso/config            Update tenant SSO config (admin)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const ssoService = require('../services/sso.service');
const sessionService = require('../services/session.service');
const { authenticate, requireRole } = require('../middleware/rbac.middleware');
const logger = require('../utils/logger');
const config = require('../config');

const router = express.Router();

// ── Tenant resolution ─────────────────────────────────────────────────────────

/**
 * Resolve tenant ID from X-Tenant-ID header or hostname.
 * Returns the tenant ID string or 'default' as fallback.
 */
function resolveTenantId(req) {
  const headerTenant = req.headers['x-tenant-id'];
  if (headerTenant) return headerTenant.trim().toLowerCase();
  const host = req.hostname || '';
  const subdomain = host.split('.')[0];
  if (subdomain && subdomain !== 'localhost' && subdomain !== 'ubr-nms') {
    return subdomain.toLowerCase();
  }
  return 'default';
}

/**
 * Get the Redis client from sessionService (shared connection).
 * sessionService exposes the ioredis client via sessionService.getRedis() if available.
 */
function getRedis() {
  if (sessionService.getRedis) return sessionService.getRedis();
  // Fallback in-memory store for development/test (no-op Redis mock)
  return {
    setex: async () => 'OK',
    get: async () => null,
    del: async () => 0,
  };
}

// ── Validation helpers ────────────────────────────────────────────────────────

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg },
    });
  }
  return null;
}

function requestContext(req) {
  return {
    ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  };
}

// ── POST /api/v1/auth/sso/initiate ────────────────────────────────────────────

/**
 * Initiate enterprise SSO login.
 * Returns a redirect URL for the configured IdP.
 */
router.post('/initiate',
  [body('provider').optional().isIn(['oidc', 'saml'])],
  async (req, res) => {
    const validationErr = handleValidation(req, res);
    if (validationErr) return;

    const tenantId = resolveTenantId(req);
    const redis = getRedis();

    try {
      const tenantConfig = await ssoService.getTenantConfig(tenantId);
      if (!tenantConfig) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'SSO_NOT_CONFIGURED', message: 'No SSO configuration found for this tenant.' },
        });
      }

      const provider = req.body.provider || tenantConfig.providerType;

      if (provider === 'oidc') {
        const { authorizationUrl } = await ssoService.initiateOIDC(tenantConfig, redis);
        return res.status(200).json({ status: 'ok', data: { redirectUrl: authorizationUrl, provider: 'oidc' } });
      }

      if (provider === 'saml') {
        const { redirectUrl } = await ssoService.initiateSAML(tenantConfig, redis);
        return res.redirect(redirectUrl);
      }

      return res.status(400).json({
        status: 'error',
        error: { code: 'UNSUPPORTED_PROVIDER', message: `Provider '${provider}' is not supported via SSO initiation.` },
      });
    } catch (err) {
      logger.error('SSO initiation failed', { tenantId, error: err.message });
      return res.status(err.status || 503).json({
        status: 'error',
        error: { code: err.code || 'SSO_INITIATION_FAILED', message: err.message },
      });
    }
  }
);

// ── GET /api/v1/auth/sso/callback/oidc ────────────────────────────────────────

/**
 * OIDC authorization code callback.
 * Validates state, exchanges the code for tokens, creates a session, and
 * redirects the frontend to the post-login URL.
 */
router.get('/callback/oidc', async (req, res) => {
  const tenantId = resolveTenantId(req);
  const redis = getRedis();

  try {
    const tenantConfig = await ssoService.getTenantConfig(tenantId);
    if (!tenantConfig) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'SSO_NOT_CONFIGURED', message: 'Tenant SSO not configured.' },
      });
    }

    const result = await ssoService.handleOIDCCallback(
      {
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        errorDescription: req.query.error_description,
      },
      tenantConfig,
      redis,
      requestContext(req)
    );

    return res.status(200).json({ status: 'ok', data: result });
  } catch (err) {
    logger.warn('OIDC callback failed', { tenantId, error: err.message });
    return res.status(err.status || 401).json({
      status: 'error',
      error: { code: err.code || 'SSO_CALLBACK_FAILED', message: err.message },
    });
  }
});

// ── POST /api/v1/auth/sso/callback/saml ───────────────────────────────────────

/**
 * SAML assertion callback (HTTP-POST binding).
 */
router.post('/callback/saml', async (req, res) => {
  const tenantId = resolveTenantId(req);
  const redis = getRedis();

  try {
    const tenantConfig = await ssoService.getTenantConfig(tenantId);
    if (!tenantConfig) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'SSO_NOT_CONFIGURED', message: 'Tenant SSO not configured.' },
      });
    }

    const result = await ssoService.handleSAMLCallback(
      {
        samlResponse: req.body.SAMLResponse,
        relayState: req.body.RelayState,
      },
      tenantConfig,
      redis,
      requestContext(req)
    );

    return res.status(200).json({ status: 'ok', data: result });
  } catch (err) {
    logger.warn('SAML callback failed', { tenantId, error: err.message });
    return res.status(err.status || 401).json({
      status: 'error',
      error: { code: err.code || 'SSO_CALLBACK_FAILED', message: err.message },
    });
  }
});

// ── GET /api/v1/auth/sso/metadata ─────────────────────────────────────────────

/**
 * Serve SAML Service Provider metadata XML.
 * Used by IdPs to configure the SP trust relationship.
 */
router.get('/metadata', async (req, res) => {
  const tenantId = resolveTenantId(req);

  try {
    const tenantConfig = await ssoService.getTenantConfig(tenantId);
    if (!tenantConfig || tenantConfig.providerType !== 'saml') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'SAML_NOT_CONFIGURED', message: 'SAML is not configured for this tenant.' },
      });
    }

    const xml = await ssoService.getSAMLMetadata(tenantConfig);
    res.set('Content-Type', 'application/xml');
    return res.send(xml);
  } catch (err) {
    logger.error('SAML metadata generation failed', { tenantId, error: err.message });
    return res.status(500).json({
      status: 'error',
      error: { code: 'METADATA_ERROR', message: 'Failed to generate SP metadata.' },
    });
  }
});

// ── GET /api/v1/auth/sso/config ──────────────────────────────────────────────

/**
 * Read SSO configuration for the current tenant.
 * Admin-only — secret references are never returned.
 */
router.get('/config', authenticate, requireRole('admin'), async (req, res) => {
  const tenantId = resolveTenantId(req);

  try {
    const cfg = await ssoService.getTenantSSOConfig(tenantId);
    if (!cfg) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'SSO_NOT_CONFIGURED', message: 'No SSO configuration found for this tenant.' },
      });
    }
    return res.status(200).json({ status: 'ok', data: cfg });
  } catch (err) {
    logger.error('Failed to read SSO config', { tenantId, error: err.message });
    return res.status(500).json({
      status: 'error',
      error: { code: 'CONFIG_READ_ERROR', message: 'Failed to retrieve SSO configuration.' },
    });
  }
});

// ── PUT /api/v1/auth/sso/config ───────────────────────────────────────────────

/**
 * Create or update SSO configuration for the current tenant.
 * Admin-only. Validates provider type and required fields before saving.
 */
router.put('/config',
  authenticate,
  requireRole('admin'),
  [
    body('providerType').isIn(['local', 'ldap', 'oidc', 'saml']).withMessage('providerType must be local, ldap, oidc, or saml.'),
    body('localFallbackEnabled').optional().isBoolean(),
  ],
  async (req, res) => {
    const validationErr = handleValidation(req, res);
    if (validationErr) return;

    const tenantId = resolveTenantId(req);
    const actor = req.user?.userId || 'system';

    // Provider-specific required field validation
    const { providerType, oidc, saml } = req.body;
    if (providerType === 'oidc' && (!oidc || !oidc.discoveryUrl || !oidc.clientId)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'VALIDATION_ERROR', message: 'OIDC configuration requires discoveryUrl and clientId.' },
      });
    }
    if (providerType === 'saml' && (!saml || !saml.entryPoint || !saml.issuer)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'VALIDATION_ERROR', message: 'SAML configuration requires entryPoint and issuer.' },
      });
    }

    try {
      const saved = await ssoService.upsertTenantSSOConfig(tenantId, req.body, actor);
      return res.status(200).json({ status: 'ok', data: saved });
    } catch (err) {
      logger.error('Failed to update SSO config', { tenantId, error: err.message });
      return res.status(err.status || 500).json({
        status: 'error',
        error: { code: err.code || 'CONFIG_UPDATE_ERROR', message: err.message },
      });
    }
  }
);

module.exports = router;

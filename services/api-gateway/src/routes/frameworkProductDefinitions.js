'use strict';

/**
 * API Gateway route for Framework Product Definitions.
 *
 * Proxies all /api/v1/framework/product-definitions/* requests to the
 * product-definition-service after enforcing role-based access:
 *
 *   POST   /upload            → FRAMEWORK_ADMIN, SYSTEM_ADMIN
 *   GET    /:id/versions      → FRAMEWORK_ADMIN, SYSTEM_ADMIN, NMS_OPERATOR
 *   GET    /:id/versions/:vid → same read roles
 *   GET    /:id/versions/:vid/report → same read roles
 *
 * Gateway-injected headers forwarded to the downstream service:
 *   X-User-Id, X-Username, X-User-Role, X-Correlation-Id
 */

const express = require('express');
const httpProxy = require('express-http-proxy');
const config = require('../config');

const router = express.Router();

// ── RBAC middleware ───────────────────────────────────────────────────────────

const WRITE_ROLES = new Set(['FRAMEWORK_ADMIN', 'SYSTEM_ADMIN']);
const READ_ROLES  = new Set(['FRAMEWORK_ADMIN', 'SYSTEM_ADMIN', 'NMS_OPERATOR']);

/**
 * Requires the requesting user to hold one of the allowed roles.
 * Roles are injected by the upstream JWT/RBAC middleware as req.user.role.
 */
function requireFrameworkRole(allowedRoles) {
  return (req, res, next) => {
    const role = (req.user && req.user.role) ? req.user.role.toUpperCase() : '';
    if (!allowedRoles.has(role)) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: `Role '${role || 'unknown'}' is not authorised for this operation. Required: ${[...allowedRoles].join(', ')}`,
      });
    }
    next();
  };
}

// ── Proxy factory ─────────────────────────────────────────────────────────────

const serviceUrl = config.services.productDefinition || 'http://localhost:8093';

function productDefinitionProxy() {
  return httpProxy(serviceUrl, {
    timeout: 60000, // upload can be up to 10 MB
    proxyReqOptDecorator(proxyReqOpts, srcReq) {
      // Forward gateway-populated identity headers so the downstream service
      // can persist actor information without touching the JWT itself.
      proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
      proxyReqOpts.headers['X-Username']       = srcReq.headers['x-username'] || '';
      proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
      proxyReqOpts.headers['X-Correlation-Id'] = srcReq.headers['x-correlation-id'] || '';
      return proxyReqOpts;
    },
    proxyErrorHandler(err, res, next) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        return res.status(503).json({
          code: 'SERVICE_UNAVAILABLE',
          message: 'product-definition-service is not reachable — check deployment status',
        });
      }
      if (err.code === 'ETIMEDOUT') {
        return res.status(504).json({
          code: 'GATEWAY_TIMEOUT',
          message: 'product-definition-service did not respond in time',
        });
      }
      next(err);
    },
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Upload: write-role required
router.post('/upload', requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());

// List all definitions (summary): read-role required
router.get('/', requireFrameworkRole(READ_ROLES), productDefinitionProxy());

// Read endpoints: read-role required
router.get('/:definitionId/versions',                             requireFrameworkRole(READ_ROLES), productDefinitionProxy());
router.get('/:definitionId/versions/:versionId',                  requireFrameworkRole(READ_ROLES), productDefinitionProxy());
router.get('/:definitionId/versions/:versionId/report',           requireFrameworkRole(READ_ROLES), productDefinitionProxy());

// Active version, lifecycle history, and audit history: read-role required
router.get('/:definitionId/active',             requireFrameworkRole(READ_ROLES), productDefinitionProxy());
router.get('/:definitionId/lifecycle-history',  requireFrameworkRole(READ_ROLES), productDefinitionProxy());
// WO-020: paginated audit trail — Admin/SYSTEM_ADMIN only (no operators)
router.get('/:definitionId/audit-history',      requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());

// Lifecycle mutations: write-role required (stage, activate, rollback)
// These routes advance the Product Definition lifecycle state — only admins may perform them.
router.put('/:definitionId/versions/:versionId/stage',    requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());
router.put('/:definitionId/versions/:versionId/activate', requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());
router.put('/:definitionId/rollback',                     requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());
// WO-017: Targeted rollback to specific version — POST with {targetVersionId, reason} body
router.post('/:definitionId/rollback',                    requireFrameworkRole(WRITE_ROLES), productDefinitionProxy());

// Health passthrough — unauthenticated health probe for infrastructure monitoring
router.get('/health', productDefinitionProxy());

module.exports = router;

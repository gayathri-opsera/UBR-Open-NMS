'use strict';

/**
 * API Gateway route for Framework Product Definitions.
 *
 * Proxies all /api/v1/framework/product-definitions/* requests to the
 * product-definition-service after enforcing role-based access using the
 * WO-004 framework capability model:
 *
 *   SuperAdmin (admin / FRAMEWORK_ADMIN / SYSTEM_ADMIN / super_admin)
 *     → full lifecycle: upload, stage, activate, rollback, audit-history
 *   Operator (operator / NMS_OPERATOR / network_engineer / noc_operator)
 *     → read + lifecycle mutations (stage, activate, rollback)
 *   ReadOnly (viewer / compliance / auditor / user)
 *     → read-only: list, get version, report, active, lifecycle-history
 *
 * All authorization failures return the standard structured error envelope:
 *   { status: "error", error: { code, message, details: {}, correlationId } }
 *
 * Gateway-injected headers forwarded to the downstream service:
 *   X-User-Id, X-Username, X-User-Role, X-Correlation-Id
 */

const express = require('express');
const httpProxy = require('express-http-proxy');
const config = require('../config');
const {
  requireFrameworkCapability,
  FRAMEWORK_CAPABILITY,
} = require('../middleware/rbac.middleware');

const { detectCredentials } = require('../middleware/credentialDetect.middleware');

const router = express.Router();

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

// Health passthrough — unauthenticated health probe for infrastructure monitoring
router.get('/health', productDefinitionProxy());

// Upload: SuperAdmin only — triggers validation and ingestion pipeline.
// WO-005: detectCredentials scans the request body for credential-like content
// and rejects the upload before it reaches the product-definition-service.
router.post('/upload',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.upload'),
  detectCredentials,
  productDefinitionProxy(),
);

// List all definitions (summary): ReadOnly+
router.get('/',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list'),
  productDefinitionProxy(),
);

// Read endpoints: ReadOnly+
router.get('/:definitionId/versions',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.list'),
  productDefinitionProxy(),
);
router.get('/:definitionId/versions/:versionId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.get'),
  productDefinitionProxy(),
);
router.get('/:definitionId/versions/:versionId/report',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.versions.report'),
  productDefinitionProxy(),
);

// Active version and lifecycle history: ReadOnly+
router.get('/:definitionId/active',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.active.get'),
  productDefinitionProxy(),
);
router.get('/:definitionId/lifecycle-history',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.lifecycle-history'),
  productDefinitionProxy(),
);

// Audit trail: SuperAdmin only — contains sensitive operational metadata
// WO-020: paginated audit trail restricted to admins; operators are excluded
router.get('/:definitionId/audit-history',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.audit-history'),
  productDefinitionProxy(),
);

// Lifecycle mutations: Operator+ (admins and operators may mutate lifecycle state)
router.put('/:definitionId/versions/:versionId/stage',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.stage'),
  productDefinitionProxy(),
);
router.put('/:definitionId/versions/:versionId/activate',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.activate'),
  productDefinitionProxy(),
);
router.put('/:definitionId/rollback',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.rollback'),
  productDefinitionProxy(),
);
// WO-017: Targeted rollback to specific version — POST with {targetVersionId, reason} body
router.post('/:definitionId/rollback',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.rollback.targeted'),
  productDefinitionProxy(),
);

module.exports = router;

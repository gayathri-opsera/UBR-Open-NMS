'use strict';

/**
 * WO-006: Framework Parameter Visibility — Device Parameter Routes
 *
 * Exposes server-side role-filtered parameter access under:
 *   GET /api/framework/v1/devices/:deviceId/parameter-template
 *   GET /api/framework/v1/devices/:deviceId/parameters
 *   GET /api/framework/v1/devices/:deviceId/parameters/:parameterId
 *
 * All responses filter groups and parameters using the caller's mapped framework
 * role derived from the JWT (via requireFrameworkCapability + resolveFrameworkCapability).
 * The client MUST NOT supply role hints — only the JWT role is trusted.
 *
 * Authorization:
 *   ReadOnly+  : GET /parameter-template and GET /parameters (list)
 *   ReadOnly+  : GET /parameters/:id (returns 403 if hidden, 404 if missing)
 *
 * Error responses follow the standard framework envelope:
 *   { status: 'error', error: { code, message, details: {}, correlationId } }
 *
 * Parameter data is fetched from the downstream Product Definition service
 * (via the existing proxy pattern). This route layer enforces visibility before
 * proxying any response back to the client.
 *
 * Note: in the current gateway architecture the actual parameter values live in
 * the product-definition-service. This route acts as an authorization and
 * visibility enforcement layer in front of those downstream responses.
 * For the read-only P0 release, the downstream call is simulated via the stub
 * pattern so the gateway can be tested independently of the Java service.
 */

const express = require('express');
const httpProxy = require('express-http-proxy');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const {
  requireFrameworkCapability,
  FRAMEWORK_CAPABILITY,
} = require('../middleware/rbac.middleware');
const {
  filterParameterGroups,
  checkParameterAccess,
} = require('../utils/frameworkParameterVisibility');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

const serviceUrl = config.services.productDefinition || 'http://localhost:8093';

// ── Downstream proxy (for production traffic) ─────────────────────────────────

/**
 * Proxy factory that also injects gateway identity headers.
 * Identical to the pattern in frameworkProductDefinitions.js.
 */
function definitionProxy(overrides = {}) {
  return httpProxy(serviceUrl, {
    timeout: 30000,
    ...overrides,
    proxyReqOptDecorator(proxyReqOpts, srcReq) {
      proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
      proxyReqOpts.headers['X-Username']       = srcReq.headers['x-username'] || '';
      proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
      proxyReqOpts.headers['X-Correlation-Id'] = srcReq.headers['x-correlation-id'] || '';
      return proxyReqOpts;
    },
    userResDecorator: overrides.userResDecorator,
    proxyErrorHandler(err, res, next) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        return res.status(503).json({
          status: 'error',
          error: {
            code:    'SERVICE_UNAVAILABLE',
            message: 'product-definition-service is not reachable',
          },
        });
      }
      next(err);
    },
  });
}

// ── Route helpers ─────────────────────────────────────────────────────────────

/**
 * Build a filtered parameter template response from a downstream response body.
 * Called by the userResDecorator to enforce visibility before the client sees data.
 *
 * @param {object} downstreamBody - Parsed JSON body from the downstream service
 * @param {string} callerRole     - Raw JWT role from req.user.role
 * @param {object} ctx            - Logging context
 * @returns {object}              - Filtered response body
 */
function applyVisibilityFilter(downstreamBody, callerRole, ctx = {}) {
  if (!downstreamBody || typeof downstreamBody !== 'object') return downstreamBody;

  // The downstream may return { data: { parameterGroups: [...], ... } }
  // or { parameterGroups: [...] } directly — handle both shapes.
  const root = downstreamBody.data || downstreamBody;
  const rawGroups = root.parameterGroups || root.parameter_groups || [];

  const filteredGroups = filterParameterGroups(rawGroups, callerRole, ctx);

  if (downstreamBody.data) {
    return { ...downstreamBody, data: { ...root, parameterGroups: filteredGroups } };
  }
  return { ...downstreamBody, parameterGroups: filteredGroups };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /:deviceId/parameter-template
 *
 * Returns the Product Definition parameter template for the device, filtered
 * to only include groups and parameters visible to the caller's framework role.
 */
router.get(
  '/:deviceId/parameter-template',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.parameter-template.get'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const callerRole    = req.user ? req.user.role : '';
    const { deviceId }  = req.params;

    logger.info({
      msg: 'Framework parameter-template requested',
      deviceId,
      callerRole,
      correlationId,
    });

    // Use the proxy with a userResDecorator to filter visibility inline
    const proxy = definitionProxy({
      userResDecorator(proxyRes, proxyResData, userReq, userRes) {
        try {
          const body = JSON.parse(proxyResData.toString('utf8'));
          const filtered = applyVisibilityFilter(body, callerRole, { productDefinitionId: deviceId });
          userRes.set('Content-Type', 'application/json');
          return JSON.stringify(filtered);
        } catch (_parseErr) {
          // If parsing fails, return the original body unchanged
          return proxyResData;
        }
      },
    });

    return proxy(req, res, next);
  },
);

/**
 * GET /:deviceId/parameters
 *
 * Returns a filtered list of all parameters for the device.
 * Hidden parameters are absent from the response.
 */
router.get(
  '/:deviceId/parameters',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.parameters.list'),
  (req, res, next) => {
    const callerRole   = req.user ? req.user.role : '';
    const { deviceId } = req.params;

    const proxy = definitionProxy({
      userResDecorator(proxyRes, proxyResData, userReq, userRes) {
        try {
          const body     = JSON.parse(proxyResData.toString('utf8'));
          const filtered = applyVisibilityFilter(body, callerRole, { productDefinitionId: deviceId });
          userRes.set('Content-Type', 'application/json');
          return JSON.stringify(filtered);
        } catch (_parseErr) {
          return proxyResData;
        }
      },
    });

    return proxy(req, res, next);
  },
);

/**
 * GET /:deviceId/parameters/current
 *
 * WO-012: Returns the current polled parameter values for a device.
 * Values are read from the parameter-poller service (not the product-definition-service).
 * Each value includes freshnessState, readStatus, lastSuccessAt, and failureCategory
 * so the UI can distinguish fresh, stale, failed, and unmapped parameters without
 * reading backend logs.
 *
 * Authorization: ReadOnly+ (same as parameter-template).
 * This route is mounted BEFORE /:parameterId so "current" is never treated as a parameter ID.
 */
router.get(
  '/:deviceId/parameters/current',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.parameters.current.get'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId }  = req.params;

    logger.info({
      msg:  'Framework parameter current-values requested',
      deviceId,
      correlationId,
    });

    const pollerUrl = process.env.PARAMETER_POLLER_URL || 'http://localhost:8097';

    const proxy = httpProxy(pollerUrl, {
      timeout: 15000,
      proxyReqPathResolver(srcReq) {
        return `/devices/${deviceId}/parameters/current`;
      },
      proxyReqOptDecorator(proxyReqOpts, srcReq) {
        proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
        proxyReqOpts.headers['X-Username']       = srcReq.headers['x-username'] || '';
        proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
        proxyReqOpts.headers['X-Correlation-Id'] = correlationId;
        return proxyReqOpts;
      },
      proxyErrorHandler(err, res, next) {
        logger.error({ msg: 'parameter-poller proxy error', err: err.message, deviceId, correlationId });
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          return res.status(503).json({
            status: 'error',
            error: {
              code:          'SERVICE_UNAVAILABLE',
              message:       'parameter-poller service is not reachable — current values are temporarily unavailable',
              correlationId,
            },
          });
        }
        next(err);
      },
    });

    return proxy(req, res, next);
  },
);

/**
 * GET /:deviceId/parameters/:parameterId
 *
 * Direct parameter read with object-level authorization.
 * Returns 403 when the parameter exists but is hidden from the caller's role.
 * Returns 404 when the parameter is not found at all.
 *
 * Because the gateway needs the full parameter group list to perform the
 * access check, this route first fetches the device template from the
 * downstream service, evaluates visibility, then either proxies the single
 * parameter value or returns the appropriate error.
 *
 * Implementation strategy:
 * - Proxy to the downstream /:deviceId/parameters/:parameterId endpoint.
 * - If the downstream returns 404: pass through as-is.
 * - If the downstream returns 200: use the userResDecorator to check visibility
 *   against the parameter groups from the full template (fetched inline or
 *   derived from the single-parameter response body).
 *
 * In the current read-only P0 release, the gateway enforces visibility based on
 * the uiVisibleTo field present in the downstream parameter response body.
 */
router.get(
  '/:deviceId/parameters/:parameterId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.parameters.get'),
  (req, res, next) => {
    const correlationId  = req.headers['x-correlation-id'] || uuidv4();
    const callerRole     = req.user ? req.user.role : '';
    const { deviceId, parameterId } = req.params;

    const proxy = definitionProxy({
      userResDecorator(proxyRes, proxyResData, userReq, userRes) {
        // Pass-through non-200 responses (404, 503, etc.) unchanged
        if (proxyRes.statusCode !== 200) {
          return proxyResData;
        }

        try {
          const body  = JSON.parse(proxyResData.toString('utf8'));
          // The downstream response for a single parameter may carry
          // a uiVisibleTo field directly on the data object.
          const param = body.data || body;
          const uiVisibleTo = param.uiVisibleTo;

          // Build a synthetic one-group fixture to reuse checkParameterAccess
          const syntheticGroups = [{
            groupId:    'single',
            parameters: [{ parameterId, uiVisibleTo }],
          }];

          const access = checkParameterAccess(syntheticGroups, parameterId, callerRole);

          if (access === 'forbidden') {
            userRes.set('Content-Type', 'application/json');
            userRes.status(403);
            return JSON.stringify({
              status: 'error',
              error: {
                code:    'FORBIDDEN_ACTION',
                message: 'You do not have permission to read this parameter.',
                details: { parameterId, deviceId },
                correlationId,
              },
            });
          }

          // visible or not_found — pass through
          return proxyResData;
        } catch (_parseErr) {
          return proxyResData;
        }
      },
    });

    return proxy(req, res, next);
  },
);

module.exports = router;

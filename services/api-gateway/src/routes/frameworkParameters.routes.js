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
const live = require('../live/liveParameters');

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
    // Forward the full original path so express-http-proxy doesn't strip the
    // sub-router prefix (req.url) and only send the relative sub-path downstream.
    proxyReqPathResolver: overrides.proxyReqPathResolver ?? ((req) => req.originalUrl),
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
 * GET /:deviceId/ui-template
 *
 * Returns the adaptive UI template for a device, built ONLY from the ACTIVE version of
 * the Product Definition the device is linked to (parameter_registry_entries in the
 * product-definition database). Nothing is added that the definition does not contain.
 *
 * The device's definition is the one stored on the device record at provisioning; a device
 * that predates that link is resolved by vendor when exactly one active definition matches.
 * There is deliberately no "first active definition" fallback — an unrelated device must
 * never be shown another product's parameters.
 *
 * Returns AdaptiveUiTemplateResponse shape:
 *   { status: 'ok', data: { productDefinitionId, versionId, registryVersion, deviceType, groups[] } }
 * or
 *   { status: 'NO_ACTIVE_FRAMEWORK', error: { code, message, correlationId } }
 */
router.get(
  '/:deviceId/ui-template',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.ui-template.get'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId }  = req.params;
    const callerRole    = req.user ? req.user.role : '';

    logger.info({ msg: 'Framework ui-template requested', deviceId, correlationId });

    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
          status: 'error',
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Parameter registry not reachable', correlationId },
        });
      }

      const device = await live.findDevice(deviceId);
      const productDefinitionId = device ? await live.ensureDefinitionLink(device) : null;

      const definition = productDefinitionId ? await live.loadDefinition(productDefinitionId) : null;
      if (!definition) {
        return res.status(200).json({
          status: 'NO_ACTIVE_FRAMEWORK',
          error: {
            code: 'NO_ACTIVE_FRAMEWORK',
            message: productDefinitionId
              ? `No active parameter registry for product definition "${productDefinitionId}".`
              : 'This device has no active Product Definition framework association.',
            correlationId,
          },
        });
      }

      const groups = live.groupEntries(definition.entries).map((g) => {
        const subGroups = [];
        const parameters = g.params.map((e, i) => {
          const dataType = (e.dataType || 'STRING').toString();
          const dt = dataType.toLowerCase();
          const hasEnum = Array.isArray(e.enumValues) && e.enumValues.length > 0;
          // The widget declared in the definition wins; otherwise derive from the data type.
          const widget = e.uiWidget
            || (dt === 'boolean' ? 'toggle' : (dt === 'enum' || hasEnum) ? 'dropdown'
              : (e.minValue != null && e.maxValue != null) ? 'slider' : 'textfield');
          if (e.subGroup && !subGroups.includes(e.subGroup)) subGroups.push(e.subGroup);
          return {
            parameterId:     e.parameterId,
            label:           e.displayName || e.parameterId,
            dataType,
            unit:            e.unit || '',
            uiWidget:        widget,
            effectiveWidget: widget,
            readOnly:        e.readOnly === true,
            snmpOid:         e.snmpOid || '',
            hidden:          false,           // hidden parameters are removed by the visibility filter below
            displayOrder:    e.displayOrder || i + 1,
            subGroup:        e.subGroup || null,
            enumValues:      e.enumValues || [],
            minValue:        e.minValue ?? null,
            maxValue:        e.maxValue ?? null,
            defaultValue:    e.defaultValue ?? null,
            uiVisibleTo:     e.uiVisibleTo,   // consumed by the visibility filter, stripped below
          };
        });
        return {
          groupId:             g.groupId,
          label:               g.groupId.charAt(0).toUpperCase() + g.groupId.slice(1),
          pollIntervalSeconds: live.POLL_INTERVAL_SECONDS,
          subGroups,
          parameters,
        };
      });

      const visible = filterParameterGroups(groups, callerRole, { productDefinitionId })
        .map((g) => ({
          ...g,
          parameters: g.parameters.map(({ uiVisibleTo, ...p }) => p),
        }));

      return res.json({
        status: 'ok',
        data: {
          productDefinitionId,
          versionId:       definition.versionId,
          registryVersion: definition.registryVersion,
          deviceType:      device?.deviceType || device?.genericDeviceType || 'GENERIC',
          groups:          visible,
        },
      });
    } catch (err) {
      logger.error({ msg: 'ui-template error', err: err.message, deviceId, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: err.message, correlationId },
      });
    }
  },
);

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
 * GET /:deviceId/parameters/current[?refresh=1]
 *
 * Live values for every parameter of the device's active Product Definition, read from the
 * device itself (read-only SNMP walk of the definition's OIDs, see src/live/liveParameters.js).
 * Stored values older than a few seconds are refreshed on demand; ?refresh=1 forces a re-poll.
 * Each value carries freshnessState / readStatus so the UI can tell fresh, stale, failed and
 * unmapped (no OID in the definition) parameters apart. Tables come back as several instances.
 *
 * Authorization: ReadOnly+ (same as ui-template).
 * This route is mounted BEFORE /:parameterId so "current" is never treated as a parameter ID.
 */
router.get(
  '/:deviceId/parameters/current',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'devices.parameters.current.get'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId }  = req.params;
    const callerRole    = req.user ? req.user.role : '';

    logger.info({ msg: 'Framework parameter current-values requested', deviceId, correlationId });

    try {
      const device = await live.findDevice(deviceId);
      if (!device) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'DEVICE_NOT_FOUND', message: `Device ${deviceId} not found`, correlationId },
        });
      }
      const { http, body } = await live.getCurrent(device, { force: req.query.refresh === '1' });
      if (body.data && Array.isArray(body.data.groups)) {
        body.data.groups = filterParameterGroups(body.data.groups, callerRole,
          { productDefinitionId: device.productDefinitionId })
          .map((g) => ({ ...g, parameters: g.parameters.map(({ uiVisibleTo, ...p }) => p) }));
      }
      return res.status(http).json(body);
    } catch (err) {
      logger.error({ msg: 'current-values error', err: err.message, deviceId, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: err.message, correlationId },
      });
    }
  },
);

/**
 * PUT /:deviceId/parameters/:parameterId
 *
 * Writes a single parameter value via the parameter-poller service.
 * Authorization: Operator+ (write tier — no separate ReadWrite capability in RBAC model).
 */
router.put(
  '/:deviceId/parameters/:parameterId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'devices.parameters.write'),
  (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId, parameterId } = req.params;

    if (!req.body || typeof req.body.value !== 'string') {
      return res.status(400).json({
        status: 'error',
        error: {
          code:          'VALIDATION_ERROR',
          message:       'Request body must include a string field "value"',
          correlationId,
        },
      });
    }

    logger.info({
      msg: 'Framework parameter write requested',
      deviceId,
      parameterId,
      correlationId,
    });

    const pollerUrl = process.env.PARAMETER_POLLER_URL || 'http://localhost:8097';

    const proxy = httpProxy(pollerUrl, {
      timeout: 15000,
      proxyReqPathResolver() {
        return `/devices/${deviceId}/parameters/${parameterId}`;
      },
      proxyReqOptDecorator(proxyReqOpts, srcReq) {
        proxyReqOpts.method = 'PUT';
        proxyReqOpts.headers['Content-Type'] = 'application/json';
        proxyReqOpts.headers['X-User-Id']       = srcReq.headers['x-user-id'] || '';
        proxyReqOpts.headers['X-Username']       = srcReq.headers['x-username'] || '';
        proxyReqOpts.headers['X-User-Role']      = srcReq.headers['x-user-role'] || '';
        proxyReqOpts.headers['X-Correlation-Id'] = correlationId;
        return proxyReqOpts;
      },
      proxyErrorHandler(err, res, next) {
        logger.error({ msg: 'parameter-poller write proxy error', err: err.message, deviceId, parameterId, correlationId });
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          return res.status(503).json({
            status: 'error',
            error: {
              code:          'SERVICE_UNAVAILABLE',
              message:       'parameter-poller service is not reachable — parameter write is temporarily unavailable',
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

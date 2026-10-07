'use strict';

/**
 * Node View Routes
 * ================
 *
 * Implements the new pre-built wireframe architecture.
 * The wireframe is generated ONCE during definition activation and persisted.
 * At runtime this route performs a simple indexed lookup — no rebuilding.
 *
 * Routes:
 *
 *   GET /api/node-view/:deviceId
 *     Returns wireframe + current parameter values in one response.
 *     The frontend can render the skeleton immediately and poll values separately.
 *
 *   GET /api/node-view/wireframe/:productDefinitionId
 *     Returns just the persisted wireframe (static, aggressively cached).
 *
 *   POST /api/node-view/wireframes/migrate
 *     Admin endpoint: generates wireframes for all active definitions
 *     that don't yet have one (backward-compatibility migration).
 *
 * Architecture principle:
 *   UPLOAD-TIME  →  build wireframe once, persist to node_view_wireframes
 *   RUNTIME      →  load wireframe by index, bind live values, render
 */

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const logger     = require('../utils/logger');
const live       = require('../live/liveParameters');
const { getCachedOnly } = live;
const crypto     = require('crypto');
const { planChange } = require('../live/parameterWrite');
const { setValues, writeCommunityFor } = require('../live/snmpSet');
const { buildWireframe, WIREFRAME_SCHEMA_VERSION } = require('../live/wireframeBuilder');
const {
  NodeViewWireframe,
  getFromCache,
  setInCache,
  invalidateCache,
} = require('../models/nodeViewWireframe.model');
const {
  requireFrameworkCapability,
  FRAMEWORK_CAPABILITY,
} = require('../middleware/rbac.middleware');

const router = express.Router();

// ── Role-filter helper (mirrors frameworkParameters.routes.js) ────────────────

/**
 * Strip parameters the caller's role cannot see.
 * uiVisibleTo === null/undefined means visible to all roles.
 */
function applyRoleFilter(groups, callerRole) {
  const ROLE_RANK = { viewer: 0, operator: 1, admin: 2, superadmin: 3 };
  const rank = ROLE_RANK[(callerRole || '').toLowerCase()] ?? 0;
  return groups
    .map((g) => ({
      ...g,
      parameters: g.parameters
        .filter((p) => {
          // uiVisibleTo may be a string (old schema) or array of strings (new schema)
          if (!p.uiVisibleTo || (Array.isArray(p.uiVisibleTo) && p.uiVisibleTo.length === 0)) return true;
          const vis = Array.isArray(p.uiVisibleTo) ? p.uiVisibleTo : [p.uiVisibleTo];
          // If any allowed role in the array is at or below the caller's rank, show it
          const minRequired = Math.min(...vis.map(r => ROLE_RANK[(r || '').toLowerCase()] ?? 0));
          return rank >= minRequired;
        })
        .map(({ uiVisibleTo, ...rest }) => rest),
    }))
    .filter((g) => g.parameters.length > 0);
}

// ── GET /api/node-view/wireframe/:productDefinitionId ─────────────────────────
/**
 * Static wireframe endpoint — returns the persisted layout for a product definition.
 * Cache: Redis (1 h) → MongoDB → 404
 *
 * Frontend can call this immediately on page load to render the skeleton
 * before values arrive.
 */
router.get(
  '/wireframe/:productDefinitionId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'node-view.wireframe.get'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { productDefinitionId } = req.params;
    const callerRole = req.user?.role || '';
    const redis = req.app.get('redis');

    try {
      // 1. Redis cache
      const cached = await getFromCache(redis, productDefinitionId);
      if (cached) {
        const filtered = applyRoleFilter(cached.wireframe?.groups || [], callerRole);
        return res.json({ status: 'ok', source: 'cache', data: { ...cached, wireframe: { groups: filtered } } });
      }

      // 2. MongoDB
      const doc = await NodeViewWireframe.findOne(
        { productDefinitionId, status: 'ACTIVE' },
        { __v: 0 },
      ).lean();

      if (!doc) {
        return res.status(404).json({
          status: 'error',
          error: {
            code: 'NO_WIREFRAME',
            message: `No active wireframe for product definition "${productDefinitionId}". ` +
              'Upload and activate a definition or run the migration endpoint.',
            correlationId,
          },
        });
      }

      // Populate cache
      await setInCache(redis, productDefinitionId, doc);

      const filtered = applyRoleFilter(doc.wireframe?.groups || [], callerRole);
      return res.json({
        status: 'ok',
        source: 'db',
        data: {
          productDefinitionId: doc.productDefinitionId,
          versionId:           doc.versionId,
          registryVersion:     doc.registryVersion,
          parameterCount:      doc.parameterCount,
          groupCount:          doc.groupCount,
          createdAt:           doc.createdAt,
          updatedAt:           doc.updatedAt,
          wireframe:           { groups: filtered },
        },
      });
    } catch (err) {
      logger.error({ msg: 'node-view wireframe error', productDefinitionId, err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: err.message, correlationId },
      });
    }
  },
);

// ── Wireframe resolution (self-healing) ───────────────────────────────────────

/** Hash of everything in the registry entries that shapes the wireframe. */
function definitionFingerprint(entries) {
  const h = crypto.createHash('sha1');
  for (const e of entries) {
    h.update(JSON.stringify([
      e.groupId, e.subGroup, e.parameterId, e.displayName, e.dataType, e.uiWidget, e.readOnly,
      e.snmpOid, e.displayOrder, e.groupDisplayOrder, e.enumValues, e.minValue, e.maxValue,
      e.defaultValue, e.unit, e.hidden,
    ]));
  }
  return h.digest('hex');
}

/**
 * The wireframe for a product definition: the persisted one when it is current, otherwise
 * rebuilt from the active registry (and persisted). "Current" = same shape version and the
 * registry it was built from is unchanged — so a re-uploaded / re-activated definition can
 * never be shown through a stale layout.
 * @returns {Promise<null | { doc: object, definition: object }>}
 */
async function resolveWireframe(redis, productDefinitionId) {
  const definition = await live.loadDefinition(productDefinitionId).catch(() => null);
  if (!definition || !definition.entries?.length) return null;
  const fingerprint = definitionFingerprint(definition.entries);

  const isCurrent = (d) => d && d.schemaVersion === WIREFRAME_SCHEMA_VERSION
    && d.fingerprint === fingerprint && d.versionId === definition.versionId;

  let doc = await getFromCache(redis, productDefinitionId);
  if (!isCurrent(doc)) {
    doc = await NodeViewWireframe.findOne({ productDefinitionId, status: 'ACTIVE' }, { __v: 0 }).lean();
  }
  if (!isCurrent(doc)) {
    const built = buildWireframe(definition);
    doc = {
      productDefinitionId,
      versionId:       definition.versionId,
      registryVersion: definition.registryVersion,
      schemaVersion:   WIREFRAME_SCHEMA_VERSION,
      fingerprint,
      status:          'ACTIVE',
      wireframe:       built.wireframe,
      parameterCount:  built.parameterCount,
      groupCount:      built.groupCount,
      validationWarnings: built.validationErrors,
    };
    try {
      await NodeViewWireframe.updateMany(
        { productDefinitionId, status: 'ACTIVE', versionId: { $ne: definition.versionId } },
        { $set: { status: 'SUPERSEDED' } },
      );
      await NodeViewWireframe.findOneAndUpdate(
        { productDefinitionId, versionId: definition.versionId },
        { $set: { ...doc, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    } catch (e) {
      logger.warn({ msg: 'node-view: wireframe persist failed (serving built copy)', productDefinitionId, err: e.message });
    }
  }
  await setInCache(redis, productDefinitionId, doc);
  return { doc, definition };
}

// ── GET /api/node-view/:deviceId ──────────────────────────────────────────────
/**
 * Combined Node View endpoint.
 *
 * Returns both the persisted wireframe and the latest cached/live values
 * in a single response. The response shape is:
 * {
 *   status: 'ok',
 *   data: {
 *     device: { id, productDefinitionId, deviceType, status },
 *     wireframe: { version, groups[] },      // from node_view_wireframes
 *     values: { [parameterId]: { value, display, freshnessState, readStatus, collectedAt } }
 *   }
 * }
 *
 * The frontend can render the wireframe skeleton IMMEDIATELY (no SNMP wait)
 * and update cells as values arrive.
 */
router.get(
  '/:deviceId',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'node-view.get'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId } = req.params;
    const callerRole = req.user?.role || '';
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const redis = req.app.get('redis');

    try {
      // ── Step 1: Resolve device + productDefinitionId ─────────────────────
      const device = await live.findDevice(deviceId);
      if (!device) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'DEVICE_NOT_FOUND', message: `Device "${deviceId}" not found.`, correlationId },
        });
      }

      let productDefinitionId = await live.ensureDefinitionLink(device);

      // ── Auto-link: try to match by manufacturer/vendor if still unlinked ──
      if (!productDefinitionId) {
        try {
          const mongoose = require('mongoose');
          if (mongoose.connection.readyState === 1) {
            const PDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
            const db = mongoose.connection.client.db(PDEF_DB);

            // ── Token-based fuzzy matching ────────────────────────────────────
            // Splits a string into meaningful word tokens, stripping version numbers,
            // separators, and short/numeric-only tokens.
            // e.g. "EOC Configurations_GUI" → ['eoc', 'configurations', 'gui']
            //      "Configurations GUI 3"   → ['configurations', 'gui']
            //      "Unknown"                → [] (skipped — sentinel)
            const SKIP_TOKENS = new Set(['unknown', 'generic', 'device', 'snmp']);
            const tokenize = (s) => (s || '').toLowerCase()
              .replace(/[_\-]/g, ' ')
              .split(/\s+/)
              .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !SKIP_TOKENS.has(w));

            const deviceVendorTokens = tokenize(device.manufacturer || device.vendor || '');
            const deviceModelTokens  = tokenize(device.model || '');
            const deviceDescrTokens  = tokenize(device.sysDescr || '');
            const deviceAllTokens    = new Set([...deviceVendorTokens, ...deviceModelTokens, ...deviceDescrTokens]);

            // Find an ACTIVE version whose vendor/model tokens appear in device tokens
            const candidates = await db.collection('product_definition_versions')
              .find({ lifecycleStatus: 'ACTIVE' })
              .sort({ updatedAt: -1 })
              .toArray();

            let matched = null;
            for (const c of candidates) {
              const defVendorTokens = tokenize(c.vendor || '');
              const defModelTokens  = tokenize(c.model  || '');

              // Vendor match: all non-empty def vendor tokens appear in device tokens
              const vendorMatch = defVendorTokens.length > 0 &&
                defVendorTokens.every((t) => deviceAllTokens.has(t));

              // Model match: all def model tokens appear in device tokens (version nums already stripped)
              const modelMatch = defModelTokens.length > 0 &&
                defModelTokens.every((t) => deviceAllTokens.has(t));

              if (vendorMatch || modelMatch) {
                matched = c;
                logger.info({
                  msg: 'node-view: auto-link token match',
                  deviceId,
                  definitionId: c.definitionId,
                  defVendor: c.vendor, defModel: c.model,
                  vendorMatch, modelMatch,
                });
                break;
              }
            }
            if (matched) {
              productDefinitionId = matched.definitionId;
              // ── CRITICAL: update in-memory device so getCachedOnly() sees the link ──
              device.productDefinitionId = productDefinitionId;
              // Persist the link on the device document so future requests skip this lookup
              const invDb = mongoose.connection.client.db(process.env.MONGO_DB_NAME || 'ubrnms');
              await invDb.collection('devices').updateOne(
                { _id: device._id },
                { $set: { productDefinitionId, updatedAt: new Date() } },
              );
              logger.info({ msg: 'node-view: auto-linked device to definition', deviceId, productDefinitionId });
            }
          }
        } catch (autoErr) {
          logger.warn({ msg: 'node-view: auto-link failed', deviceId, err: autoErr.message });
        }
      }

      if (!productDefinitionId) {
        // The Node View shows ONLY parameters declared by a product definition. With no
        // definition linked there is nothing to show — never substitute other device data
        // (no MIB-2 / system info fallback).
        return res.status(200).json({
          status: 'ok',
          data: {
            noFramework:  true,
            collectedAt:  null,
            pollStatus:   'NOT_POLLED',
            wireframe:    { productDefinitionId: null, versionId: '', registryVersion: '', parameterCount: 0, groupCount: 0, groups: [] },
            values:       {},
            writable:     { enabled: false },
            device: {
              id:          deviceId,
              productDefinitionId: null,
              deviceType:  device.genericDeviceType || device.deviceType || 'GENERIC',
              status:      device.status || 'UNKNOWN',
              ipAddress:   device.ipAddress,
            },
          },
        });
      }

      // ── Step 2: Load the wireframe (persisted, rebuilt when the definition changed) ──
      const resolved = await resolveWireframe(redis, productDefinitionId);
      const wireframeDoc = resolved ? resolved.doc : null;

      // Apply role filter to groups
      const filteredGroups = wireframeDoc
        ? applyRoleFilter(wireframeDoc.wireframe?.groups || [], callerRole)
        : [];

      // ── Step 3: Get current parameter values (cache only — never block on SNMP) ─
      // We read only what the background scheduler already stored.
      // This keeps Node View load time < 200 ms regardless of SNMP reachability.
      // Pass ?refresh=1 to explicitly trigger a fresh SNMP poll (separate request).
      let valuesData = null;
      try {
        if (refresh) {
          // Explicit refresh requested — do a live SNMP poll (may be slow)
          valuesData = (await live.getCurrent(device, { force: true })).body;
        } else {
          // Default: return cached values only — instant, no SNMP
          valuesData = (await getCachedOnly(device)).body;
        }
      } catch (e) {
        logger.warn({ msg: 'node-view: values fetch failed', deviceId, err: e.message });
      }

      // Flatten values into a simple map: parameterId → value record
      // This is the new "simple binding" shape the frontend uses.
      //
      // NOTE: getCachedOnly() / getCurrent() return { body: { status, data: { groups, pollStatus, collectedAt } } }
      //       so we must unwrap the `.data` envelope before accessing `groups`.
      const valuesInner = valuesData?.data ?? valuesData ?? {};
      const valuesMap = {};
      if (valuesInner.groups) {
        for (const g of valuesInner.groups) {
          for (const p of (g.parameters || [])) {
            valuesMap[`${g.groupId}::${p.parameterId}`] = {
              value:          p.value         ?? null,
              display:        p.display       ?? null,
              freshnessState: p.freshnessState,
              readStatus:     p.readStatus,
              collectedAt:    p.collectedAt   ?? null,
              isTable:        p.isTable       || false,
              instances:      p.instances     || [],
              unit:           p.unit          || null,
              failureReason:  p.failureReason || null,
            };
          }
        }
      }

      return res.json({
        status: 'ok',
        data: {
          device: {
            id:                  device.serialNumber || device._id || deviceId,
            productDefinitionId,
            deviceType:          device.genericDeviceType || device.deviceType || 'GENERIC',
            status:              device.status || 'UNKNOWN',
            ipAddress:           device.ipAddress,
          },
          wireframe: {
            productDefinitionId,
            versionId:       wireframeDoc?.versionId || '',
            registryVersion: wireframeDoc?.registryVersion || '',
            parameterCount:  wireframeDoc?.parameterCount || 0,
            groupCount:      wireframeDoc?.groupCount || 0,
            groups:          filteredGroups,
          },
          values: valuesMap,
          writable: { enabled: !!writeCommunityFor(device) },
          pollStatus:  valuesInner.pollStatus  || 'NOT_POLLED',
          collectedAt: valuesInner.collectedAt || null,
        },
      });
    } catch (err) {
      logger.error({ msg: 'node-view error', deviceId, err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: err.message, correlationId },
      });
    }
  },
);

// ── PUT /api/node-view/:deviceId/parameters ──────────────────────────────────
/**
 * Apply edited parameter values to the device (SNMP SET).
 *
 * Body: { changes: [{ groupId, parameterId, instance?, value }] }
 *
 * Only parameters of the device's active product definition can be written, and only when
 * the definition marks them writable and the value fits the declared type / options /
 * range. Requires an SNMP write community (device.snmpWriteCommunity or
 * SNMP_WRITE_COMMUNITY); without one the request is refused with WRITE_NOT_CONFIGURED and
 * nothing is sent to the device. Values are never logged.
 */
router.put(
  '/:deviceId/parameters',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'node-view.write'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const { deviceId } = req.params;
    const changes = req.body && req.body.changes;
    const fail = (http, code, message) =>
      res.status(http).json({ status: 'error', error: { code, message, correlationId } });

    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
      return fail(400, 'VALIDATION_ERROR', 'Body must be { changes: [ … ] } with 1–100 entries');
    }
    try {
      const device = await live.findDevice(deviceId);
      if (!device) return fail(404, 'DEVICE_NOT_FOUND', `Device "${deviceId}" not found.`);
      const productDefinitionId = await live.ensureDefinitionLink(device);
      const definition = productDefinitionId ? await live.loadDefinition(productDefinitionId).catch(() => null) : null;
      if (!definition) return fail(409, 'NO_ACTIVE_FRAMEWORK', 'This device has no active product definition.');

      const plans = changes.map((c) => planChange(definition, c));
      const community = writeCommunityFor(device);
      if (!community) {
        return fail(409, 'WRITE_NOT_CONFIGURED',
          'No SNMP write community is configured for this device, so nothing was sent. ' +
          'Set snmpWriteCommunity on the device (or SNMP_WRITE_COMMUNITY on the gateway).');
      }

      const results = plans.map((p, i) => ({
        groupId: changes[i] && changes[i].groupId,
        parameterId: changes[i] && changes[i].parameterId,
        instance: changes[i] && changes[i].instance != null ? String(changes[i].instance) : '',
        ok: false,
        ...(p.ok ? {} : { code: p.code, error: p.error }),
      }));

      const toSend = plans.map((p, i) => ({ p, i })).filter((x) => x.p.ok);
      if (toSend.length) {
        const { host, port } = live.splitHostPort(device);
        const sent = await setValues({
          host, port, community,
          items: toSend.map((x) => ({ oid: x.p.oid, value: x.p.value })),
        });
        sent.forEach((r, k) => {
          const slot = results[toSend[k].i];
          slot.ok = r.ok;
          if (!r.ok) { slot.code = 'DEVICE_REJECTED'; slot.error = r.error; }
        });
        logger.info({
          msg: 'node-view: parameters applied', deviceId, correlationId,
          user: req.user && (req.user.username || req.user.sub),
          applied: results.filter((r) => r.ok).map((r) => `${r.groupId}/${r.parameterId}${r.instance ? `#${r.instance}` : ''}`),
          failed: results.filter((r) => !r.ok).length,
        });
        if (results.some((r) => r.ok)) await live.refreshDevice(device).catch(() => {});
      }

      const okCount = results.filter((r) => r.ok).length;
      return res.status(okCount ? 200 : 422).json({
        status: okCount === results.length ? 'ok' : okCount ? 'partial' : 'error',
        results,
        correlationId,
      });
    } catch (err) {
      logger.error({ msg: 'node-view write error', deviceId, err: err.message, correlationId });
      return fail(500, 'INTERNAL_ERROR', err.message);
    }
  },
);

// ── POST /api/node-view/wireframes/migrate ────────────────────────────────────
/**
 * Admin migration endpoint: builds and persists wireframes for all active
 * product definitions that don't yet have one.
 *
 * Idempotent — safe to run multiple times.
 */
router.post(
  '/wireframes/migrate',
  requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'node-view.migrate'),
  async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const redis = req.app.get('redis');

    try {
      const mongoose = require('mongoose');
      const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';
      const db = mongoose.connection.readyState === 1
        ? mongoose.connection.client.db(PRODUCTDEF_DB)
        : null;

      if (!db) {
        return res.status(503).json({
          status: 'error',
          error: { code: 'SERVICE_UNAVAILABLE', message: 'MongoDB not connected', correlationId },
        });
      }

      // Find all active definition IDs from the parameter registry
      const activeDefIds = await db.collection('parameter_registry_entries')
        .distinct('productDefinitionId');

      const results = { built: [], skipped: [], failed: [] };

      for (const defId of activeDefIds) {
        // Skip if already has an ACTIVE wireframe
        const existing = await NodeViewWireframe.findOne({ productDefinitionId: defId, status: 'ACTIVE' }).lean();
        if (existing) { results.skipped.push(defId); continue; }

        try {
          const definition = await live.loadDefinition(defId);
          if (!definition || !definition.entries?.length) { results.skipped.push(defId); continue; }

          const { wireframe, parameterCount, groupCount, validationErrors } = buildWireframe(definition);

          await NodeViewWireframe.findOneAndUpdate(
            { productDefinitionId: defId, versionId: definition.versionId },
            {
              $set: {
                productDefinitionId: defId,
                versionId:           definition.versionId,
                registryVersion:     definition.registryVersion,
                status:              'ACTIVE',
                wireframe,
                parameterCount,
                groupCount,
                validationWarnings:  validationErrors,
                updatedAt:           new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
          );

          await invalidateCache(redis, defId);
          results.built.push({ defId, parameterCount, groupCount });
          logger.info({ msg: 'migration: wireframe built', defId, parameterCount, groupCount });
        } catch (e) {
          results.failed.push({ defId, error: e.message });
          logger.error({ msg: 'migration: wireframe failed', defId, err: e.message });
        }
      }

      return res.json({ status: 'ok', correlationId, results });
    } catch (err) {
      logger.error({ msg: 'node-view migrate error', err: err.message, correlationId });
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: err.message, correlationId },
      });
    }
  },
);

module.exports = router;

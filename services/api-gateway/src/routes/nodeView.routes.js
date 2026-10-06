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
const { buildWireframe } = require('../live/wireframeBuilder');
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
            const vendor = (device.manufacturer || device.vendor || '').toLowerCase();
            const model  = (device.model || '').toLowerCase();
            // Find an ACTIVE version whose vendor matches
            const candidates = await db.collection('product_definition_versions')
              .find({ lifecycleStatus: 'ACTIVE' })
              .sort({ updatedAt: -1 })
              .toArray();
            let matched = null;
            for (const c of candidates) {
              const cv = (c.vendor || '').toLowerCase();
              const cm = (c.model  || '').toLowerCase();
              if (vendor && cv && cv.includes(vendor)) { matched = c; break; }
              if (model  && cm && cm.includes(model))  { matched = c; break; }
            }
            if (matched) {
              productDefinitionId = matched.definitionId;
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
        // ── Fallback: fetch MIB-2 system group via SNMP GET ──────────────────
        // Returns basic device info even when no product definition is linked.
        try {
          const { valueToString } = require('../live/snmpWalk');
          const snmp = require('net-snmp');
          const MIB2_SYSTEM = {
            '.1.3.6.1.2.1.1.1.0': 'System Description',
            '.1.3.6.1.2.1.1.2.0': 'System Object ID',
            '.1.3.6.1.2.1.1.3.0': 'System Uptime',
            '.1.3.6.1.2.1.1.4.0': 'System Contact',
            '.1.3.6.1.2.1.1.5.0': 'System Name',
            '.1.3.6.1.2.1.1.6.0': 'System Location',
            '.1.3.6.1.2.1.1.7.0': 'System Services',
          };
          // Parse host:port from ipAddress (e.g. "host.docker.internal:1163")
          const rawIp  = device.host || device.ipAddress || device.ip || '';
          const colonIdx = rawIp.lastIndexOf(':');
          const host   = colonIdx > 0 ? rawIp.slice(0, colonIdx) : rawIp;
          const port   = device.snmpPort || device.port || (colonIdx > 0 ? parseInt(rawIp.slice(colonIdx + 1), 10) : 161) || 161;
          const community = device.snmpCommunity || device.community || 'public';

          if (host) {
            const session = snmp.createSession(host, community, {
              port, retries: 1, timeout: 3000, version: snmp.Version2c,
            });
            const oidList = Object.keys(MIB2_SYSTEM).map((o) => o.replace(/^\./, ''));
            const basicParams = await new Promise((resolve) => {
              session.get(oidList, (err, varbinds) => {
                try { session.close(); } catch { /* ignore */ }
                if (err || !varbinds) return resolve([]);
                const result = [];
                for (const vb of varbinds) {
                  if (snmp.isVarbindError(vb)) continue;
                  const oidKey = `.${vb.oid}`;
                  const label  = MIB2_SYSTEM[oidKey] || oidKey;
                  result.push({ parameterId: oidKey, displayName: label, value: valueToString(vb), snmpOid: oidKey });
                }
                resolve(result);
              });
            });

            if (basicParams.length > 0) {
              return res.status(200).json({
                status: 'ok',
                data: {
                  deviceId,
                  productDefinitionId: null,
                  noFramework: true,
                  collectedAt: new Date().toISOString(),
                  pollStatus: 'REACHABLE',
                  wireframe: {
                    registryVersion: 0,
                    groups: [{
                      groupId:      'system',
                      label:        'System Info',
                      displayOrder: 1,
                      subGroups:    [],
                      parameters:   basicParams.map((p, i) => ({
                        parameterId:   p.parameterId,
                        displayName:   p.displayName,
                        snmpOid:       p.snmpOid,
                        dataType:      'string',
                        uiWidget:      'text',
                        readOnly:      true,
                        hidden:        false,
                        displayOrder:  i + 1,
                      })),
                    }],
                  },
                  values: {
                    status: 'ok',
                    groups: [{
                      groupId:    'system',
                      parameters: basicParams.map((p) => ({
                        parameterId: p.parameterId,
                        value:       p.value,
                        rawValue:    p.value,
                        timestamp:   new Date().toISOString(),
                        status:      'ok',
                      })),
                    }],
                  },
                },
              });
            }
          }
        } catch (snmpErr) {
          logger.debug({ msg: 'node-view: basic SNMP fallback failed', deviceId, err: snmpErr.message });
        }

        // No SNMP data either — return the original no-framework response
        return res.status(200).json({
          status: 'NO_ACTIVE_FRAMEWORK',
          error: {
            code: 'NO_ACTIVE_FRAMEWORK',
            message: 'This device has no active Product Definition framework association.',
            correlationId,
          },
        });
      }

      // ── Step 2: Load persisted wireframe (cache → DB → fallback build) ───
      let wireframeDoc = null;

      // Try Redis first
      const cached = await getFromCache(redis, productDefinitionId);
      if (cached) {
        wireframeDoc = cached;
      } else {
        // Try MongoDB
        wireframeDoc = await NodeViewWireframe.findOne(
          { productDefinitionId, status: 'ACTIVE' },
          { __v: 0 },
        ).lean();

        if (wireframeDoc) {
          await setInCache(redis, productDefinitionId, wireframeDoc);
        }
      }

      // Fallback: build on-the-fly if no persisted wireframe exists yet
      // (handles pre-migration devices; also builds and persists for next time)
      if (!wireframeDoc) {
        logger.warn({
          msg: 'node-view: no persisted wireframe — building on demand (run migration)',
          productDefinitionId, deviceId,
        });
        const definition = await live.loadDefinition(productDefinitionId);
        if (definition && definition.entries?.length > 0) {
          const built = buildWireframe(definition);
          // Persist async so next request hits the cache
          setImmediate(async () => {
            try {
              await NodeViewWireframe.findOneAndUpdate(
                { productDefinitionId, versionId: definition.versionId },
                {
                  $set: {
                    productDefinitionId,
                    versionId:       definition.versionId,
                    registryVersion: definition.registryVersion,
                    status:          'ACTIVE',
                    wireframe:       built.wireframe,
                    parameterCount:  built.parameterCount,
                    groupCount:      built.groupCount,
                    validationWarnings: built.validationErrors,
                    updatedAt:       new Date(),
                  },
                  $setOnInsert: { createdAt: new Date() },
                },
                { upsert: true },
              );
              await setInCache(redis, productDefinitionId, {
                productDefinitionId,
                versionId: definition.versionId,
                registryVersion: definition.registryVersion,
                wireframe: built.wireframe,
                parameterCount: built.parameterCount,
                groupCount: built.groupCount,
              });
            } catch (e) {
              logger.warn({ msg: 'node-view: fallback persist failed', err: e.message });
            }
          });
          wireframeDoc = {
            productDefinitionId,
            versionId:      definition.versionId,
            registryVersion: definition.registryVersion,
            wireframe:      built.wireframe,
            parameterCount: built.parameterCount,
            groupCount:     built.groupCount,
          };
        }
      }

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
      const valuesMap = {};
      if (valuesData?.groups) {
        for (const g of valuesData.groups) {
          for (const p of (g.parameters || [])) {
            valuesMap[p.parameterId] = {
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
          pollStatus:  valuesData?.pollStatus  || 'NOT_POLLED',
          collectedAt: valuesData?.collectedAt || null,
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

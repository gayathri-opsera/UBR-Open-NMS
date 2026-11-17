'use strict';

/**
 * MIB UI Builder — descriptor draft CRUD + publish/XML generation.
 * Mounted at /api/v1/ui-builder
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const UiDescriptor = require('../models/uiDescriptor.model');
const { generateUiXml } = require('../live/uiXmlGenerator');
const { NodeViewWireframe, invalidateCache } = require('../models/nodeViewWireframe.model');
const { helperId } = require('../live/derivedValues');
const { headerInputs, HEADER_GROUP, objectOid } = require('../live/headerSources');
const { deletePolicy } = require('../live/descriptorDelete');
const mongoose = require('mongoose');

const router = express.Router();

function actorId(req) {
  return req.user?.sub || req.user?.userId || req.headers['x-user-id'] || null;
}

function requireAuthenticated(req, res, next) {
  if (!actorId(req)) {
    return res.status(401).json({
      status: 'error',
      error: { code: 'UNAUTHORIZED', message: 'Authentication required (Bearer token or x-user-id)' },
    });
  }
  return next();
}

function ok(data, meta = {}) {
  return { status: 'ok', ...meta, data };
}

function err(code, message, status = 400) {
  return { status, body: { status: 'error', error: { code, message } } };
}

function toDescriptor(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    descriptorId:        o.descriptorId,
    nodeViewId:          o.nodeViewId,
    screenName:          o.screenName,
    deviceProfile:       o.deviceProfile,
    productDefinitionId: o.productDefinitionId,
    vendor:              o.vendor,
    productFamily:       o.productFamily,
    mibModule:           o.mibModule,
    status:              o.status,
    sections:            o.sections || [],
    deviceUi:            o.deviceUi || null,
    layoutMode:          o.layoutMode || null,
    defaultPollInterval: o.defaultPollInterval ?? null,
    generatedXml:        o.generatedXml,
    /** Full MibObjectSummary array; allows session restore without re-uploading the MIB. */
    selectedObjects:     Array.isArray(o.selectedObjects) ? o.selectedObjects : [],
    createdBy:           o.createdBy,
    updatedBy:           o.updatedBy,
    createdAt:           o.createdAt,
    updatedAt:           o.updatedAt,
  };
}

function toSummary(doc) {
  const full = toDescriptor(doc);
  if (!full) return null;
  const { sections, generatedXml, selectedObjects, ...summary } = full;
  return {
    ...summary,
    sectionCount:  Array.isArray(sections)        ? sections.length        : 0,
    objectCount:   Array.isArray(selectedObjects)  ? selectedObjects.length : 0,
  };
}

function validateBoundOids(descriptor) {
  const missing = [];
  for (const section of descriptor.sections || []) {
    for (const field of section.fields || []) {
      if (field.elementType !== 'field-label' && field.elementType !== 'table-block') continue;
      const name = field.mibObject || field.label || field.fieldId || 'unknown field';
      // Fixed text needs no OID. A calculated field needs an expression and an OID for each of its inputs, not one of its own.
      if (field.valueSource === 'static') continue;
      if (field.valueSource === 'calc') {
        const calc = field.calc || {};
        if (!(calc.expr && String(calc.expr).trim()) && !(calc.template && String(calc.template).trim())) missing.push(`${name} (calculation has no expression)`);
        for (const i of calc.inputs || []) {
          if (!i.oid || !String(i.oid).trim()) missing.push(`${name} (input "${i.name || '?'}" has no OID)`);
        }
        continue;
      }
      if (!field.oid || !String(field.oid).trim()) missing.push(name);
    }
  }
  // header bar data sources: every input needs an OID (the header has no field of its own to carry one)
  const ui = descriptor.deviceUi || {};
  const check = (label, src) => {
    if (!src) return;
    if (src.kind === 'calc' && !(src.expr && String(src.expr).trim())) missing.push(`Header · ${label} (calculation has no expression)`);
    if (src.kind === 'template' && !(src.template && String(src.template).trim())) missing.push(`Header · ${label} (template is empty)`);
    for (const i of src.inputs || []) if (!i.oid || !String(i.oid).trim()) missing.push(`Header · ${label} (input "${i.name || '?'}" has no OID)`);
  };
  for (const k of ['productName', 'versionLine', 'uptime']) check(k, ui.sources && ui.sources[k]);
  (ui.radios || []).forEach((r, i) => { check(`radio ${i + 1} mode`, r.modeSource); check(`radio ${i + 1} label`, r.labelSource); });
  return missing;
}

/**
 * Does this screen use the device look in Node View? Explicitly when Builder v2 saved it ('device'); and for screens
 * saved before that flag existed, when they carry Builder-v2-only data (the device header config). 'classic' always wins.
 */
function usesDeviceLayout(descriptor) {
  if (!descriptor) return false;
  if (descriptor.layoutMode === 'classic') return false;
  if (descriptor.layoutMode === 'device') return true;
  const ui = descriptor.deviceUi;
  return !!ui && typeof ui === 'object' && Object.keys(ui).length > 0;
}

/** Only real enum entries: a table block keeps its `columns` setting in the same map. */
function enumEntries(enumMap) {
  if (!enumMap || typeof enumMap !== 'object') return [];
  return Object.entries(enumMap).filter(([value]) => value !== 'columns');
}

function enumMapToOptions(enumMap) {
  return enumEntries(enumMap).map(([value, label]) => ({ value, label: String(label) }));
}

/** "enable(1)" style strings — the form the live reader (resolveDisplay) turns a raw 1 into "enable(1)". */
function enumMapToValues(enumMap) {
  return enumEntries(enumMap).map(([value, label]) => `${label}(${value})`);
}

/** Live-refresh bounds (seconds). Below 2 s a lab agent cannot keep up; above 300 s the normal poll is enough. */
const LIVE_MIN_S = 2;
const LIVE_MAX_S = 300;

/**
 * Real-time refresh interval for a section, or null when off. Honoured only for sections whose fields are ALL
 * read-only, so a live read can never run alongside values someone is editing.
 */
function liveRefreshFor(section, parameters) {
  const n = Number(section && section.liveRefreshSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!parameters.length || parameters.some((p) => !p.readOnly)) return null;
  return Math.min(LIVE_MAX_S, Math.max(LIVE_MIN_S, Math.round(n)));
}

/**
 * Convert a published UI descriptor into a Node View wireframe document.
 */
function descriptorToWireframe(descriptor) {
  const groups = [...(descriptor.sections || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((section, gi) => {
      const fields = [...(section.fields || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const parameters = fields
        .filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block')
        .flatMap((f, pi) => {
          const source = f.valueSource === 'static' || f.valueSource === 'calc' ? f.valueSource : 'mib';
          const parameterId = f.mibObject || f.fieldId;
          const main = {
            parameterId,
            fieldId:         f.fieldId,
            elementType:     f.elementType,
            uiOrder:         f.order ?? pi,
            displayName:     f.label || f.mibObject || f.fieldId,
            dataType:        enumEntries(f.enumMap).length ? 'ENUM' : 'STRING',
            unit:            f.units || null,
            uiWidget:        f.widget || null,
            effectiveWidget: f.widget || (f.elementType === 'table-block' ? 'data-table' : 'textfield'),
            readOnly:        source !== 'mib' ? true : f.access !== 'read-write',
            snmpOid:         source === 'mib' ? (f.oid || null) : null,
            hidden:          false,
            displayOrder:    pi + 1,
            subGroup:        null,
            enumValues:      enumMapToValues(f.enumMap),
            options:         enumMapToOptions(f.enumMap),
            minValue:        f.minValue ?? null,
            maxValue:        f.maxValue ?? null,
            defaultValue:    null,
            description:     f.helpText || null,
            thresholds:      null,
            sensitive:       false,
            columns:         f.elementType === 'table-block'
              ? (f.enumMap?.columns || null)
              : null,
            confirmWrite:    f.confirmWrite || false,
            pollInterval:    f.pollInterval ?? section.pollInterval ?? 60,
            ...(source === 'static' ? { valueSource: 'static', staticValue: String(f.staticValue ?? '') } : {}),
            ...(source === 'calc' && f.calc && (f.calc.expr || f.calc.template) ? {
              valueSource: 'calc',
              calc: {
                expr: String(f.calc.expr || ''), template: f.calc.template ? String(f.calc.template) : null, fallback: f.calc.fallback != null ? String(f.calc.fallback) : null,
                format: f.calc.format || 'none', decimals: f.calc.decimals ?? null,
                inputs: (f.calc.inputs || []).filter((i) => i && i.name && i.oid).map((i) => ({
                  name: String(i.name), oid: objectOid(i.oid), ...(i.map ? { map: i.map } : {}), ...(i.strip ? { strip: String(i.strip) } : {}),
                  ...(Array.isArray(i.emptyValues) ? { emptyValues: i.emptyValues } : {}),
                })) },
            } : {}),
            ...(Array.isArray(f.emptyValues) ? { emptyValues: f.emptyValues } : {}),
          };
          // A calculated field reads its inputs through hidden helper parameters (one per input OID), which the
          // normal poll collects like any other parameter.
          const helpers = main.valueSource === 'calc'
            ? main.calc.inputs.map((i) => ({
              parameterId: helperId(parameterId, i.name), displayName: i.name, dataType: 'STRING', unit: null, uiWidget: null,
              effectiveWidget: 'readonly', readOnly: true, snmpOid: i.oid, hidden: true, displayOrder: 1000 + pi, subGroup: null,
              enumValues: [], options: [], minValue: null, maxValue: null, defaultValue: null, description: null, thresholds: null,
              sensitive: false, columns: null, confirmWrite: false, pollInterval: f.pollInterval ?? section.pollInterval ?? 60,
            }))
            : [];
          return [main, ...helpers];
        });

      const layoutItems = fields
        .filter((f) => f.elementType === 'heading' || f.elementType === 'sub-heading' || f.elementType === 'divider')
        .map((f) => ({ fieldId: f.fieldId, elementType: f.elementType, label: f.label || '', uiOrder: f.order ?? 0 }));
      const tableWithCols = parameters.find((p) => p.columns);
      const groupId = section.sectionId || `section_${gi + 1}`;

      return {
        groupId,
        label:               section.title || groupId,
        displayOrder:        gi + 1,
        pollIntervalSeconds: section.pollInterval ?? 60,
        liveRefreshSeconds:  liveRefreshFor(section, parameters),
        subGroups:           [],
        parameters,
        ...(layoutItems.length ? { layoutItems } : {}),
        // A section may carry its own tree position (device-style Page > Parent > Tab); otherwise the legacy flat layout.
        uiPage:              (section.uiPage && String(section.uiPage).trim()) || descriptor.screenName || 'UI Builder',
        uiParent:            (section.uiParent && String(section.uiParent).trim()) || section.title || '',
        uiTab:               (section.uiTab && String(section.uiTab).trim()) || section.title || groupId,
        ...(section.uiTitle ? { uiTitle: section.uiTitle } : {}),
        ...(section.uiNote ? { uiNote: section.uiNote } : {}),
        ...(section.uiLayout ? { uiLayout: section.uiLayout } : {}),
        ...(section.uiColumn ? { uiColumn: section.uiColumn } : {}),
        ...(section.uiHideWhenEmpty ? { uiHideWhenEmpty: true } : {}),
        ...(section.uiLayout === 'matrix' && section.uiMatrix ? { uiMatrix: {
          hideEmptyColumns: section.uiMatrix.hideEmptyColumns !== false,
          columns: (section.uiMatrix.columns || []).filter((c) => c && String(c.index) !== '').map((c) => ({ index: String(c.index), label: String(c.label || c.index), ...(c.map && typeof c.map === 'object' ? { map: c.map } : {}) })),
        } } : {}),
        ...(tableWithCols ? { columns: tableWithCols.columns } : {}),
      };
    })
    // device layout keeps empty sections: an empty tab is still a tab of the screen
    .filter((g) => usesDeviceLayout(descriptor) || g.parameters.length > 0);

  // Header bar inputs: hidden parameters in a synthetic group, so the normal poll reads them for every device
  if (usesDeviceLayout(descriptor)) {
    const inputs = headerInputs(descriptor.deviceUi);
    if (inputs.length) {
      groups.push({
        groupId: HEADER_GROUP, label: 'Header', displayOrder: groups.length + 1, pollIntervalSeconds: 30, liveRefreshSeconds: null, subGroups: [],
        parameters: inputs.map((i, n) => ({
          parameterId: i.parameterId, displayName: i.parameterId, dataType: 'STRING', unit: null, uiWidget: null, effectiveWidget: 'readonly',
          readOnly: true, snmpOid: i.oid, hidden: true, displayOrder: n + 1, subGroup: null, enumValues: [], options: [], minValue: null, maxValue: null,
          defaultValue: null, description: null, thresholds: null, sensitive: false, columns: null, confirmWrite: false, pollInterval: 30,
        })),
      });
    }
  }

  const parameterCount = groups.reduce((n, g) => n + g.parameters.length, 0);
  return { groups, parameterCount, groupCount: groups.length };
}

async function persistWireframeFromDescriptor(descriptor, redis) {
  // Use descriptorId as the wireframe key when no product definition XML is linked.
  // This allows MIB Builder published screens to drive the Node View without
  // requiring a separate product definition XML upload.
  const productDefinitionId = descriptor.productDefinitionId || descriptor.descriptorId;
  if (!productDefinitionId) {
    logger.info({ msg: 'ui-builder publish: no productDefinitionId or descriptorId; wireframe link skipped' });
    return;
  }

  const { groups, parameterCount, groupCount } = descriptorToWireframe(descriptor);
  if (groupCount === 0 || (!usesDeviceLayout(descriptor) && parameterCount === 0)) {
    logger.warn({ msg: 'ui-builder publish: no bindable fields for wireframe', descriptorId: descriptor.descriptorId });
    return;
  }

  const versionId = `ui-builder-${descriptor.descriptorId}`;

  await NodeViewWireframe.updateMany(
    { productDefinitionId, status: 'ACTIVE' },
    { $set: { status: 'SUPERSEDED', updatedAt: new Date() } },
  );

  await NodeViewWireframe.findOneAndUpdate(
    { productDefinitionId, versionId },
    {
      $set: {
        productDefinitionId,
        versionId,
        registryVersion:     'ui-builder',
        status:              'ACTIVE',
        wireframe:           { groups, deviceUi: usesDeviceLayout(descriptor) ? (descriptor.deviceUi || {}) : null, layoutMode: usesDeviceLayout(descriptor) ? 'device' : null },
        schemaVersion:       2,
        fingerprint:         descriptor.descriptorId,
        parameterCount,
        groupCount,
        validationWarnings:  [],
        updatedAt:           new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true },
  );

  await invalidateCache(redis, productDefinitionId);
  logger.info({
    msg: 'ui-builder publish: wireframe linked',
    descriptorId: descriptor.descriptorId,
    productDefinitionId,
    groupCount,
    parameterCount,
  });
}

router.use(requireAuthenticated);

router.get('/descriptors', async (req, res) => {
  try {
    const docs = await UiDescriptor.find({}).sort({ updatedAt: -1 }).lean();
    return res.json(ok(docs.map(toSummary)));
  } catch (e) {
    logger.error({ msg: 'ui-builder list failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

router.post('/descriptors', async (req, res) => {
  const body = req.body || {};
  if (!body.screenName || !String(body.screenName).trim()) {
    return res.status(400).json(err('VALIDATION_ERROR', 'screenName is required').body);
  }

  const user = actorId(req);
  const descriptorId = body.descriptorId || uuidv4();

  try {
    const doc = await UiDescriptor.create({
      descriptorId,
      nodeViewId:          body.nodeViewId,
      screenName:          String(body.screenName).trim(),
      deviceProfile:       body.deviceProfile,
      productDefinitionId: body.productDefinitionId,
      vendor:              body.vendor,
      productFamily:       body.productFamily,
      mibModule:           body.mibModule,
      status:              'draft',
      sections:            Array.isArray(body.sections)        ? body.sections        : [],
      deviceUi:            body.deviceUi && typeof body.deviceUi === 'object' ? body.deviceUi : undefined,
      layoutMode:          body.layoutMode || undefined,
      defaultPollInterval: Number(body.defaultPollInterval) || undefined,
      selectedObjects:     Array.isArray(body.selectedObjects) ? body.selectedObjects : [],
      createdBy:           user,
      updatedBy:           user,
    });
    logger.info({ msg: 'ui-builder descriptor created', descriptorId, user });
    return res.status(201).json(ok(toDescriptor(doc)));
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json(err('DUPLICATE', 'descriptorId already exists', 409).body);
    }
    logger.error({ msg: 'ui-builder create failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

router.get('/descriptors/:id', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id });
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);
    return res.json(ok(toDescriptor(doc)));
  } catch (e) {
    logger.error({ msg: 'ui-builder get failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

router.put('/descriptors/:id', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id });
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);

    const body = req.body || {};
    const user = actorId(req);

    if (body.screenName != null) doc.screenName = String(body.screenName).trim();
    if (body.nodeViewId !== undefined) doc.nodeViewId = body.nodeViewId;
    if (body.deviceProfile !== undefined) doc.deviceProfile = body.deviceProfile;
    if (body.productDefinitionId !== undefined) doc.productDefinitionId = body.productDefinitionId;
    if (body.vendor !== undefined) doc.vendor = body.vendor;
    if (body.productFamily !== undefined) doc.productFamily = body.productFamily;
    if (body.mibModule !== undefined) doc.mibModule = body.mibModule;
    if (Array.isArray(body.sections)) doc.sections = body.sections;
    if (body.deviceUi !== undefined) { doc.deviceUi = body.deviceUi; doc.markModified('deviceUi'); }
    if (body.layoutMode !== undefined) doc.layoutMode = body.layoutMode;
    if (body.defaultPollInterval !== undefined) doc.defaultPollInterval = Number(body.defaultPollInterval) || undefined;
    if (Array.isArray(body.selectedObjects)) doc.selectedObjects = body.selectedObjects;
    doc.updatedBy = user;

    await doc.save();
    logger.info({ msg: 'ui-builder descriptor saved', descriptorId: doc.descriptorId, user });
    return res.json(ok(toDescriptor(doc)));
  } catch (e) {
    logger.error({ msg: 'ui-builder update failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

router.post('/descriptors/:id/publish', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id });
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);

    const plain = toDescriptor(doc);
    const missingOids = validateBoundOids(plain);
    if (missingOids.length) {
      return res.status(422).json(err(
        'VALIDATION_ERROR',
        `All bound fields must have an OID. Missing: ${missingOids.join(', ')}`,
        422,
      ).body);
    }

    if (usesDeviceLayout(plain) && plain.layoutMode !== 'device') { doc.layoutMode = 'device'; plain.layoutMode = 'device'; }
    const generatedXml = generateUiXml(plain);
    doc.generatedXml = generatedXml;
    doc.status = 'published';
    doc.updatedBy = actorId(req);
    if (req.body?.productDefinitionId) {
      doc.productDefinitionId = req.body.productDefinitionId;
    }

    await doc.save();

    const published = toDescriptor(doc);
    await persistWireframeFromDescriptor(published, req.app.get('redis'));

    logger.info({ msg: 'ui-builder descriptor published', descriptorId: doc.descriptorId });
    return res.json(ok(published));
  } catch (e) {
    logger.error({ msg: 'ui-builder publish failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

/**
 * Devices (either inventory store) whose Node View layout is this screen.
 * Fails closed: when neither store can be asked, the answer is "unknown", never "none" — deleting a published screen
 * on a guess could strip the layout from a device that is using it.
 */
async function devicesUsing(ids) {
  const client = mongoose.connection && mongoose.connection.client;
  if (!client || !ids.length) throw new Error('device store not available');
  const seen = new Map();
  let answered = 0;
  for (const dbName of ['ubrnms_inventory', 'ubrnms']) {
    try {
      const rows = await client.db(dbName).collection('devices')
        .find({ productDefinitionId: { $in: ids } }, { projection: { serialNumber: 1, ipAddress: 1 } }).limit(50).toArray();
      answered += 1;
      rows.forEach((d) => seen.set(String(d._id), d));
    } catch { /* this store is missing */ }
  }
  if (answered === 0) throw new Error('device store not available');
  return [...seen.values()];
}

router.delete('/descriptors/:id', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id });
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);

    const published = doc.status === 'published';
    let linkedDevices = [];
    if (published) {
      try { linkedDevices = await devicesUsing([doc.descriptorId, doc.productDefinitionId].filter(Boolean)); }
      catch { return res.status(503).json(err('DEVICE_LOOKUP_FAILED', 'Could not check which devices use this screen, so it was not deleted. Try again.', 503).body); }
    }
    const verdict = deletePolicy({ status: doc.status, role: req.user && req.user.role, linkedDevices });
    if (!verdict.ok) {
      const body = err(verdict.code, verdict.message, verdict.http).body;
      if (verdict.devices) body.error.devices = verdict.devices;
      return res.status(verdict.http).json(body);
    }

    if (published) {
      // Remove the Node View layout this screen published (only its own version — never a product definition's)
      const key = doc.productDefinitionId || doc.descriptorId;
      await NodeViewWireframe.deleteMany({ versionId: `ui-builder-${doc.descriptorId}` });
      await invalidateCache(req.app.get('redis'), key).catch(() => {});
    }
    await UiDescriptor.deleteOne({ descriptorId: req.params.id });
    logger.info({ msg: 'ui-builder descriptor deleted', descriptorId: req.params.id, wasPublished: published, user: actorId(req) });
    return res.json(ok({ deleted: true, descriptorId: req.params.id }));
  } catch (e) {
    logger.error({ msg: 'ui-builder delete failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

router.get('/descriptors/:id/xml', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id }).lean();
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);

    const xml = doc.generatedXml || generateUiXml(toDescriptor(doc));
    return res.json(ok({ descriptorId: doc.descriptorId, xml }));
  } catch (e) {
    logger.error({ msg: 'ui-builder xml failed', err: e.message });
    return res.status(500).json(err('INTERNAL_ERROR', e.message, 500).body);
  }
});

module.exports = router;
module.exports.validateBoundOids = validateBoundOids;   // for tests
module.exports.usesDeviceLayout = usesDeviceLayout;
module.exports.descriptorToWireframe = descriptorToWireframe;
module.exports.liveRefreshFor = liveRefreshFor;   // exposed for unit tests

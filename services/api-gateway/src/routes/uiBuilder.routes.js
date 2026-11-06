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
      if (!field.oid || !String(field.oid).trim()) {
        missing.push(field.mibObject || field.fieldId || field.label || 'unknown field');
      }
    }
  }
  return missing;
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
        .map((f, pi) => ({
          parameterId:     f.mibObject || f.fieldId,
          displayName:     f.label || f.mibObject || f.fieldId,
          dataType:        enumEntries(f.enumMap).length ? 'ENUM' : 'STRING',
          unit:            f.units || null,
          uiWidget:        f.widget || null,
          effectiveWidget: f.widget || (f.elementType === 'table-block' ? 'data-table' : 'textfield'),
          readOnly:        f.access !== 'read-write',
          snmpOid:         f.oid || null,
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
        }));

      const tableWithCols = parameters.find((p) => p.columns);
      const groupId = section.sectionId || `section_${gi + 1}`;

      return {
        groupId,
        label:               section.title || groupId,
        displayOrder:        gi + 1,
        pollIntervalSeconds: section.pollInterval ?? 60,
        subGroups:           [],
        parameters,
        uiPage:              descriptor.screenName || 'UI Builder',
        uiParent:            section.title || '',
        uiTab:               section.title || groupId,
        ...(tableWithCols ? { columns: tableWithCols.columns } : {}),
      };
    })
    .filter((g) => g.parameters.length > 0);

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
  if (groupCount === 0) {
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
        wireframe:           { groups },
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

router.delete('/descriptors/:id', async (req, res) => {
  try {
    const doc = await UiDescriptor.findOne({ descriptorId: req.params.id });
    if (!doc) return res.status(404).json(err('NOT_FOUND', 'Descriptor not found', 404).body);
    if (doc.status === 'published') {
      return res.status(409).json(err('CONFLICT', 'Published descriptors cannot be deleted', 409).body);
    }
    await UiDescriptor.deleteOne({ descriptorId: req.params.id });
    logger.info({ msg: 'ui-builder descriptor deleted', descriptorId: req.params.id });
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
module.exports.descriptorToWireframe = descriptorToWireframe;   // exposed for unit tests

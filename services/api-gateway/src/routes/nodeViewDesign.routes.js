'use strict';
/**
 * Node View Design Routes
 * =======================
 * Pre-MIB phase CRUD + copy + lock operations.
 * Mounted at /api/v1/node-view-designs
 *
 * Routes:
 *   GET    /                  list all designs (summary)
 *   POST   /                  create new design
 *   GET    /:id               get full design
 *   PUT    /:id               update (sections, labels, metadata)
 *   DELETE /:id               delete (only draft/ready — not if linked to a published descriptor)
 *   POST   /:id/copy          duplicate design as a new draft
 *   POST   /:id/lock          toggle layout lock on/off
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const NodeViewDesign = require('../models/nodeViewDesign.model');

const router = express.Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function actorId(req) {
  return req.user?.sub || req.user?.userId || req.headers['x-user-id'] || null;
}

function actorRole(req) {
  return (req.user?.role || req.headers['x-role'] || '').toLowerCase();
}

/** Admin = admin, descriptor_admin, superadmin. Non-admins may only read. */
function requireAdmin(req, res, next) {
  const role = actorRole(req);
  const adminRoles = ['admin', 'descriptor_admin', 'superadmin'];
  if (!adminRoles.includes(role)) {
    return res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN', message: 'Admin role required to modify node view designs (PV-01)' },
    });
  }
  return next();
}

function requireAuthenticated(req, res, next) {
  if (!actorId(req) && !actorRole(req)) {
    return res.status(401).json({
      status: 'error',
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }
  return next();
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(data, meta = {}) {
  return { status: 'ok', ...meta, data };
}

function errBody(code, message, status = 400) {
  return { status, body: { status: 'error', error: { code, message } } };
}

// ── Summary view (list) ───────────────────────────────────────────────────────

function toSummary(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    nodeViewId:     o.nodeViewId,
    name:           o.name,
    deviceFamily:   o.deviceFamily,
    description:    o.description,
    status:         o.status,
    locked:         o.locked,
    sectionCount:   (o.sections || []).length,
    labelCount:     (o.sections || []).reduce((n, s) => n + (s.labels || []).length, 0),
    linkedDescriptorId: o.linkedDescriptorId,
    copiedFromId:   o.copiedFromId,
    createdBy:      o.createdBy,
    updatedBy:      o.updatedBy,
    createdAt:      o.createdAt,
    updatedAt:      o.updatedAt,
  };
}

// ── GET /  — list all designs ─────────────────────────────────────────────────

router.use(requireAuthenticated);

router.get('/', async (req, res) => {
  try {
    const { status, deviceFamily } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (deviceFamily) filter.deviceFamily = new RegExp(deviceFamily, 'i');

    const docs = await NodeViewDesign.find(filter).sort({ updatedAt: -1 }).lean();
    return res.json(ok(docs.map(toSummary), { total: docs.length }));
  } catch (e) {
    logger.error({ msg: 'nvd list failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── POST /  — create new design ───────────────────────────────────────────────

router.post('/', requireAdmin, async (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json(errBody('VALIDATION_ERROR', 'name is required').body);
  }

  const user = actorId(req);
  const nodeViewId = body.nodeViewId || uuidv4();

  try {
    const doc = await NodeViewDesign.create({
      nodeViewId,
      name:          String(body.name).trim(),
      deviceFamily:  body.deviceFamily || '',
      description:   body.description || '',
      sections:      Array.isArray(body.sections) ? body.sections : [],
      gridSize:      body.gridSize || 40,
      createdBy:     user,
      updatedBy:     user,
    });
    logger.info({ msg: 'nvd created', nodeViewId, user });
    return res.status(201).json(ok(doc.toObject()));
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json(errBody('DUPLICATE', 'nodeViewId already exists', 409).body);
    }
    logger.error({ msg: 'nvd create failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── GET /:id  — full design ───────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const doc = await NodeViewDesign.findOne({ nodeViewId: req.params.id });
    if (!doc) return res.status(404).json(errBody('NOT_FOUND', 'Node view design not found', 404).body);
    return res.json(ok(doc.toObject()));
  } catch (e) {
    logger.error({ msg: 'nvd get failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── PUT /:id  — update ────────────────────────────────────────────────────────

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await NodeViewDesign.findOne({ nodeViewId: req.params.id });
    if (!doc) return res.status(404).json(errBody('NOT_FOUND', 'Node view design not found', 404).body);

    const body = req.body || {};
    const user = actorId(req);

    if (body.name != null)         doc.name         = String(body.name).trim();
    if (body.deviceFamily != null) doc.deviceFamily = body.deviceFamily;
    if (body.description != null)  doc.description  = body.description;
    if (body.gridSize != null)     doc.gridSize      = body.gridSize;
    if (Array.isArray(body.sections)) doc.sections  = body.sections;
    if (body.linkedDescriptorId !== undefined) doc.linkedDescriptorId = body.linkedDescriptorId;
    doc.updatedBy = user;

    await doc.save();
    logger.info({ msg: 'nvd updated', nodeViewId: doc.nodeViewId, user });
    return res.json(ok(doc.toObject()));
  } catch (e) {
    logger.error({ msg: 'nvd update failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── DELETE /:id  — delete ─────────────────────────────────────────────────────

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await NodeViewDesign.findOne({ nodeViewId: req.params.id });
    if (!doc) return res.status(404).json(errBody('NOT_FOUND', 'Node view design not found', 404).body);
    if (doc.linkedDescriptorId) {
      return res.status(409).json(errBody(
        'CONFLICT',
        `This node view is linked to descriptor ${doc.linkedDescriptorId}. Unlink it first.`,
        409,
      ).body);
    }
    await NodeViewDesign.deleteOne({ nodeViewId: req.params.id });
    logger.info({ msg: 'nvd deleted', nodeViewId: req.params.id });
    return res.json(ok({ deleted: true, nodeViewId: req.params.id }));
  } catch (e) {
    logger.error({ msg: 'nvd delete failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── POST /:id/copy  — duplicate (PV-11) ──────────────────────────────────────

router.post('/:id/copy', requireAdmin, async (req, res) => {
  try {
    const src = await NodeViewDesign.findOne({ nodeViewId: req.params.id }).lean();
    if (!src) return res.status(404).json(errBody('NOT_FOUND', 'Node view design not found', 404).body);

    const user = actorId(req);
    const newId = uuidv4();
    const body = req.body || {};

    // Deep-copy sections with new label IDs to avoid collisions
    const copiedSections = (src.sections || []).map((s) => ({
      ...s,
      sectionId: uuidv4(),
      frozen: false,  // reset freeze state on copy
      labels: (s.labels || []).map((l) => ({
        ...l,
        labelId: uuidv4(),
        frozen: false,
        mappedField: null, // unlinked on copy
      })),
    }));

    const newDoc = await NodeViewDesign.create({
      nodeViewId:    newId,
      name:          body.name || `Copy of ${src.name}`,
      deviceFamily:  src.deviceFamily,
      description:   src.description,
      sections:      copiedSections,
      gridSize:      src.gridSize,
      locked:        false,  // always unlocked on copy
      copiedFromId:  src.nodeViewId,
      createdBy:     user,
      updatedBy:     user,
    });

    logger.info({ msg: 'nvd copied', from: src.nodeViewId, to: newId, user });
    return res.status(201).json(ok(newDoc.toObject()));
  } catch (e) {
    logger.error({ msg: 'nvd copy failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

// ── POST /:id/lock  — toggle layout lock (PV-08) ──────────────────────────────

router.post('/:id/lock', requireAdmin, async (req, res) => {
  try {
    const doc = await NodeViewDesign.findOne({ nodeViewId: req.params.id });
    if (!doc) return res.status(404).json(errBody('NOT_FOUND', 'Node view design not found', 404).body);

    const body = req.body || {};
    // Accept explicit locked value or toggle
    doc.locked = body.locked !== undefined ? !!body.locked : !doc.locked;
    doc.updatedBy = actorId(req);
    await doc.save();

    logger.info({ msg: 'nvd lock toggled', nodeViewId: doc.nodeViewId, locked: doc.locked });
    return res.json(ok({ nodeViewId: doc.nodeViewId, locked: doc.locked }));
  } catch (e) {
    logger.error({ msg: 'nvd lock failed', err: e.message });
    return res.status(500).json(errBody('INTERNAL_ERROR', e.message, 500).body);
  }
});

module.exports = router;

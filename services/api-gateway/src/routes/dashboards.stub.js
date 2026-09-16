'use strict';

/**
 * Custom Dashboards stub — MongoDB-backed CRUD.
 * Mounted at /api/v1/dashboards in app.js (behind JWT middleware).
 *
 * Collection: ubrnms_config.custom_dashboards
 * Scoped per user via req.user.username so each operator sees only their own.
 * Admins can optionally see all with ?all=true.
 */

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const MONGO_URI = process.env.MONGO_URI_CONFIG
  || process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubrnms_config';

let _col = null;

async function getCol() {
  if (_col) return _col;
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection('custom_dashboards');
    return _col;
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  _col = mongoose.connection.db.collection('custom_dashboards');
  return _col;
}

getCol().catch((e) => console.error('[dashboards-stub] MongoDB connect failed:', e.message));

function toApi(doc) {
  const { _id, __v, ...rest } = doc;
  return { id: String(_id), ...rest };
}

// ── LIST ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const user  = req.user?.username || 'anonymous';
  const isAdmin = req.user?.role === 'admin';
  const showAll = isAdmin && req.query.all === 'true';

  try {
    const col  = await getCol();
    const filter = showAll ? {} : { $or: [{ createdBy: user }, { isShared: true }] };
    const docs = await col.find(filter).sort({ updatedAt: -1 }).toArray();
    res.json(docs.map(toApi));
  } catch (e) {
    console.error('[dashboards-stub] LIST error:', e.message);
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── CREATE ────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const user = req.user?.username || 'anonymous';
  const { name, description, scope, widgets, isDefault, filters, isShared } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
  }

  try {
    const col = await getCol();

    // Enforce unique name per user
    const exists = await col.findOne({ name: name.trim(), createdBy: user });
    if (exists) {
      return res.status(409).json({ code: 'DUPLICATE', message: `A dashboard named "${name.trim()}" already exists` });
    }

    // If new dashboard is set as default, unset others for this user
    if (isDefault) {
      await col.updateMany({ createdBy: user }, { $set: { isDefault: false } });
    }

    const now = new Date();
    const doc = {
      _id:         `dash-${Date.now()}`,
      name:        name.trim(),
      description: description || '',
      scope:       scope || 'BOTH',
      widgets:     Array.isArray(widgets) ? widgets : [],
      isDefault:   Boolean(isDefault),
      isShared:    Boolean(isShared),
      filters:     filters || {},
      createdBy:   user,
      createdAt:   now,
      updatedAt:   now,
    };

    await col.insertOne(doc);
    res.status(201).json(toApi(doc));
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ code: 'DUPLICATE', message: 'Dashboard already exists' });
    }
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── GET ONE ───────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const col = await getCol();
    const doc = await col.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
    res.json(toApi(doc));
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── UPDATE ────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const user = req.user?.username || 'anonymous';
  const { name, description, scope, widgets, isDefault, filters, isShared } = req.body || {};

  try {
    const col = await getCol();
    const existing = await col.findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });

    // Check for duplicate name (exclude current)
    if (name?.trim() && name.trim() !== existing.name) {
      const dup = await col.findOne({ name: name.trim(), createdBy: existing.createdBy, _id: { $ne: req.params.id } });
      if (dup) return res.status(409).json({ code: 'DUPLICATE', message: `A dashboard named "${name.trim()}" already exists` });
    }

    // Unset other defaults if this one becomes default
    if (isDefault) {
      await col.updateMany({ createdBy: existing.createdBy, _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
    }

    const update = {
      ...(name !== undefined        && { name: name.trim() }),
      ...(description !== undefined && { description }),
      ...(scope !== undefined       && { scope }),
      ...(widgets !== undefined     && { widgets }),
      ...(isDefault !== undefined   && { isDefault: Boolean(isDefault) }),
      ...(isShared !== undefined    && { isShared: Boolean(isShared) }),
      ...(filters !== undefined     && { filters }),
      updatedAt: new Date(),
    };

    const result = await col.findOneAndUpdate(
      { _id: req.params.id },
      { $set: update },
      { returnDocument: 'after' },
    );
    res.json(toApi(result));
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const col = await getCol();
    const r   = await col.deleteOne({ _id: req.params.id });
    if (r.deletedCount === 0) return res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

module.exports = router;

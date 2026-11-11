'use strict';
/**
 * Device Type Combinations — DT-02, DT-04, DT-10
 *
 * A DeviceTypeCombination is a first-class entity: { model, role } → { configuration, nodeView }.
 * One model can have many roles; each combination is unique on (model, role).
 *
 * Routes:
 *   GET    /api/v1/device-type-combinations              — list all combinations
 *   POST   /api/v1/device-type-combinations              — create a combination
 *   PUT    /api/v1/device-type-combinations/:id          — update a combination
 *   DELETE /api/v1/device-type-combinations/:id          — delete a combination
 *   GET    /api/v1/device-type-combinations/models       — list unique models
 *   GET    /api/v1/device-type-combinations/roles        — roles for ?model=X
 *
 * Audit:
 *   GET    /api/v1/device-type-combinations/audit        — full change log
 *   GET    /api/v1/device-type-combinations/audit/:deviceId — log for one device
 *   POST   /api/v1/device-type-combinations/audit        — write an entry (internal / called by provision + devices stubs)
 */

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const router = express.Router();

// ── MongoDB helpers ───────────────────────────────────────────────────────────
let _db = null;
async function getDb() {
  if (_db) return _db;
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) throw new Error('MongoDB not connected');
  _db = conn.db;
  return _db;
}
async function getComboCol()  { return (await getDb()).collection('deviceTypeCombinations'); }
async function getAuditCol()  { return (await getDb()).collection('deviceTypeChangeLogs'); }

// ── Seed default combinations if collection is empty ─────────────────────────
async function seedDefaults(col) {
  const count = await col.countDocuments();
  if (count > 0) return;
  const now = new Date();
  const defaults = [
    { model: 'EOC640',    role: 'BTS',      description: 'Base Transceiver Station',         productDefinitionId: 'eoc-configurations-gui', nodeViewDescriptorId: null },
    { model: 'EOC640',    role: 'CPE',      description: 'Customer Premises Equipment',       productDefinitionId: 'eoc-configurations-gui', nodeViewDescriptorId: null },
    { model: 'UBR-655',   role: 'BTS',      description: 'Base Transceiver Station',         productDefinitionId: 'ubr-networks.ubr-650',   nodeViewDescriptorId: null },
    { model: 'UBR-655',   role: 'CPE',      description: 'Customer Premises Equipment',      productDefinitionId: 'ubr-networks.ubr-650',   nodeViewDescriptorId: null },
    { model: 'IOS Switch','role': 'SWITCH', description: 'Layer-2/3 Network Switch',         productDefinitionId: null,                     nodeViewDescriptorId: null },
    { model: 'SRX300',    role: 'FIREWALL', description: 'Network Firewall',                 productDefinitionId: 'juniper-srx300',         nodeViewDescriptorId: null },
    { model: 'AirMax AC', role: 'RADIO',    description: 'Wireless Radio',                   productDefinitionId: 'ubiquiti-airmax-radio',  nodeViewDescriptorId: null },
    { model: 'Generic',   role: 'ROUTER',   description: 'IP Router',                        productDefinitionId: null,                     nodeViewDescriptorId: null },
    { model: 'Generic',   role: 'GATEWAY',  description: 'Edge Gateway',                     productDefinitionId: null,                     nodeViewDescriptorId: null },
    { model: 'Generic',   role: 'AP',       description: 'Wi-Fi Access Point',               productDefinitionId: null,                     nodeViewDescriptorId: null },
  ];
  await col.insertMany(defaults.map((d) => ({
    _id:                  uuidv4(),
    combinationId:        uuidv4(),
    ...d,
    isActive:             true,
    createdAt:            now,
    updatedAt:            now,
    createdBy:            'system',
  })));
  console.log('[device-type-combinations] Seeded', defaults.length, 'default combinations');
}

// ── GET /models ───────────────────────────────────────────────────────────────
router.get('/models', async (_req, res) => {
  try {
    const col    = await getComboCol();
    await seedDefaults(col);
    const models = await col.distinct('model', { isActive: { $ne: false } });
    return res.json(models.sort());
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── GET /roles?model=X ────────────────────────────────────────────────────────
router.get('/roles', async (req, res) => {
  try {
    const { model } = req.query;
    const col   = await getComboCol();
    await seedDefaults(col);
    const query = { isActive: { $ne: false }, ...(model ? { model } : {}) };
    const docs  = await col.find(query, { projection: { role: 1, description: 1, productDefinitionId: 1, nodeViewDescriptorId: 1 } }).toArray();
    return res.json(docs.map((d) => ({
      role:                 d.role,
      description:          d.description,
      productDefinitionId:  d.productDefinitionId,
      nodeViewDescriptorId: d.nodeViewDescriptorId,
    })));
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── GET /audit or /audit/:deviceId ────────────────────────────────────────────
router.get('/audit/:deviceId?', async (req, res) => {
  try {
    const col   = await getAuditCol();
    const query = req.params.deviceId ? { serialNumber: req.params.deviceId } : {};
    const docs  = await col.find(query).sort({ changedAt: -1 }).limit(200).toArray();
    return res.json(docs);
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── POST /audit — internal write (called from provision.stub and devices.stub) ─
router.post('/audit', async (req, res) => {
  try {
    const col    = await getAuditCol();
    const entry  = {
      _id:          uuidv4(),
      ...req.body,
      changedAt:    req.body.changedAt ? new Date(req.body.changedAt) : new Date(),
    };
    await col.insertOne(entry);
    return res.status(201).json(entry);
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── GET / — list all ──────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const col  = await getComboCol();
    await seedDefaults(col);
    const docs = await col.find({}).sort({ model: 1, role: 1 }).toArray();
    return res.json(docs.map(toApi));
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── POST / — create ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { model, role, description, productDefinitionId, nodeViewDescriptorId } = req.body || {};
    if (!model || !role) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'model and role are required' });
    }
    const col = await getComboCol();
    const existing = await col.findOne({ model, role, isActive: { $ne: false } });
    if (existing) {
      return res.status(409).json({ code: 'CONFLICT', message: `Combination ${model}/${role} already exists` });
    }
    const now = new Date();
    const doc = {
      _id:                  uuidv4(),
      combinationId:        uuidv4(),
      model, role,
      description:          description || `${model} — ${role}`,
      productDefinitionId:  productDefinitionId || null,
      nodeViewDescriptorId: nodeViewDescriptorId || null,
      isActive:             true,
      createdAt:            now,
      updatedAt:            now,
      createdBy:            req.user?.userId || 'admin',
    };
    await col.insertOne(doc);
    console.log(`[device-type-combinations] Created ${model}/${role}`);
    return res.status(201).json(toApi(doc));
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── PUT /:id — update ─────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const col = await getComboCol();
    const doc = await col.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ code: 'NOT_FOUND', message: 'Combination not found' });
    const { model, role, description, productDefinitionId, nodeViewDescriptorId, isActive } = req.body || {};
    // Check uniqueness if model/role are changing
    if ((model && model !== doc.model) || (role && role !== doc.role)) {
      const conflict = await col.findOne({ model: model || doc.model, role: role || doc.role, _id: { $ne: req.params.id } });
      if (conflict) {
        return res.status(409).json({ code: 'CONFLICT', message: `Combination ${model || doc.model}/${role || doc.role} already exists` });
      }
    }
    const update = {
      ...(model               !== undefined ? { model }               : {}),
      ...(role                !== undefined ? { role }                : {}),
      ...(description         !== undefined ? { description }         : {}),
      ...(productDefinitionId !== undefined ? { productDefinitionId } : {}),
      ...(nodeViewDescriptorId !== undefined ? { nodeViewDescriptorId } : {}),
      ...(isActive            !== undefined ? { isActive }            : {}),
      updatedAt: new Date(),
    };
    await col.updateOne({ _id: req.params.id }, { $set: update });
    const updated = await col.findOne({ _id: req.params.id });
    return res.json(toApi(updated));
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── DELETE /:id — soft-delete ─────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const col = await getComboCol();
    const doc = await col.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ code: 'NOT_FOUND', message: 'Combination not found' });
    await col.updateOne({ _id: req.params.id }, { $set: { isActive: false, updatedAt: new Date() } });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────
function toApi(doc) {
  return {
    id:                   doc._id,
    combinationId:        doc.combinationId || doc._id,
    model:                doc.model,
    role:                 doc.role,
    description:          doc.description,
    productDefinitionId:  doc.productDefinitionId,
    nodeViewDescriptorId: doc.nodeViewDescriptorId,
    isActive:             doc.isActive !== false,
    createdAt:            doc.createdAt,
    updatedAt:            doc.updatedAt,
    createdBy:            doc.createdBy,
  };
}

// ── Shared helper (used by provision.stub and devices.stub) ───────────────────
/**
 * Write a device type change audit entry directly to MongoDB
 * (bypasses the HTTP layer — used in server-side provision/update flows).
 */
async function writeAuditEntry(entry) {
  try {
    const col = await getAuditCol();
    await col.insertOne({ _id: uuidv4(), ...entry, changedAt: entry.changedAt || new Date() });
  } catch (e) {
    console.warn('[device-type-combinations] audit write failed:', e.message);
  }
}

/**
 * Append a status transition to the device's statusHistory array.
 */
async function appendStatusHistory(devicesCol, serialNumber, status, reason, changedBy = 'system') {
  try {
    const entry = { status, reason: reason || null, changedBy, timestamp: new Date() };
    await devicesCol.updateOne(
      { $or: [{ _id: serialNumber }, { serialNumber }] },
      {
        $set:  { status, updatedAt: new Date() },
        $push: { statusHistory: { $each: [entry], $slice: -50 } }, // keep last 50 transitions
      },
    );
  } catch (e) {
    console.warn('[device-type-combinations] status history write failed:', e.message);
  }
}

/**
 * Resolve the best-matching combination for a (model, role/genericDeviceType) pair.
 * Returns the combination doc or null.
 */
async function resolveCombination(model, role) {
  try {
    const col = await getComboCol();
    if (model && role) {
      const exact = await col.findOne({ model, role, isActive: { $ne: false } });
      if (exact) return exact;
    }
    if (role) {
      const byRole = await col.findOne({ role, isActive: { $ne: false } });
      if (byRole) return byRole;
    }
    return null;
  } catch { return null; }
}

module.exports = router;
module.exports.writeAuditEntry      = writeAuditEntry;
module.exports.appendStatusHistory  = appendStatusHistory;
module.exports.resolveCombination   = resolveCombination;
module.exports.getComboCol          = getComboCol;

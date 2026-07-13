'use strict';

/**
 * Device write stub — handles POST/PUT/DELETE for /api/v1/devices.
 * Also handles GET /api/v1/devices to merge Java inventory results (BTS/CPE)
 * with IDU devices that only exist in MongoDB (ubrnms_inventory).
 */
const express  = require('express');
const mongoose = require('mongoose');
const http     = require('http');
const router   = express.Router();

const MONGO_URI  = process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubr_nms';
const COLLECTION = 'devices';

// Derive inventory DB URI (ubrnms_inventory) from the main MONGO_URI
function buildInvUri() {
  const base = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongodb:27017/ubrnms';
  return base.replace(/\/[^/?]+(\?|$)/, '/ubrnms_inventory$1');
}

let _col    = null;
let _invCol = null;
let _invConn = null;

async function getCol() {
  if (_col) return _col;
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection(COLLECTION);
    return _col;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _col = conn.db.collection(COLLECTION);
  return _col;
}

async function getInvCol() {
  if (_invCol) return _invCol;
  if (!_invConn) {
    _invConn = await mongoose.createConnection(buildInvUri(), { serverSelectionTimeoutMS: 5000 }).asPromise();
  }
  _invCol = _invConn.db.collection('devices');
  return _invCol;
}

getCol().catch((err) => console.error('[devices-stub] MongoDB connect failed:', err.message));
getInvCol().catch((err) => console.error('[devices-stub] Inventory MongoDB connect failed:', err.message));

/** Fetch a page from the Java inventory service (internal call) */
function fetchFromJava(query) {
  const invUrl = process.env.INVENTORY_SERVICE_URL || 'http://nms-inventory:8082';
  const qs = new URLSearchParams(query).toString();
  const url = new URL(`/api/v1/devices${qs ? '?' + qs : ''}`, invUrl);
  return new Promise((resolve, reject) => {
    http.get(url.href, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve([]); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Java inventory timeout')));
  });
}

/** Normalise an IDU MongoDB doc to the same shape as Java inventory devices */
function normaliseIdu(doc) {
  return {
    id:              doc.serialNumber || String(doc._id),
    deviceId:        doc.serialNumber || String(doc._id),
    serialNumber:    doc.serialNumber || String(doc._id),
    name:            doc.name || doc.serialNumber || String(doc._id),
    deviceType:      'IDU',
    model:           doc.model || 'IDU',
    status:          doc.status || 'UNKNOWN',
    ipAddress:       doc.ipAddress  || null,
    macAddress:      doc.macAddress || null,
    latitude:        doc.latitude   || null,
    longitude:       doc.longitude  || null,
    firmwareVersion: doc.firmwareVersion || null,
    manufacturer:    doc.manufacturer   || 'Senao',
    organizationId:  doc.organizationId || null,
    tags:            doc.tags || [],
    uptimeSeconds:   doc.uptimeSeconds || 0,
    createdAt:       doc.createdAt || null,
    updatedAt:       doc.updatedAt || null,
  };
}

// ── GET /api/v1/devices — merge Java inventory + MongoDB IDU devices ──────────
router.get('/', async (req, res, next) => {
  const { deviceType, limit = '100', page = '0', ...rest } = req.query || {};
  const typeUpper = (deviceType || '').toUpperCase();

  try {
    // If caller explicitly wants IDU only — serve directly from MongoDB
    if (typeUpper === 'IDU') {
      const col = await getInvCol();
      const docs = await col.find({ deviceType: { $regex: 'IDU', $options: 'i' } }).limit(500).toArray();
      return res.json(docs.map(normaliseIdu));
    }

    // Otherwise fetch from Java inventory (BTS/CPE)
    const javaQuery = { limit, page, ...(deviceType ? { deviceType } : {}), ...rest };
    let javaDevices = [];
    try {
      const raw = await fetchFromJava(javaQuery);
      javaDevices = Array.isArray(raw) ? raw : (raw.content || raw.data || raw.devices || []);
    } catch (err) {
      console.warn('[devices-stub] Java inventory fetch failed, returning empty BTS/CPE list:', err.message);
    }

    // Append IDU devices only when no deviceType filter (or no filter at all)
    let iduDevices = [];
    if (!typeUpper) {
      try {
        const col = await getInvCol();
        const docs = await col.find({ deviceType: { $regex: 'IDU', $options: 'i' } }).limit(500).toArray();
        iduDevices = docs.map(normaliseIdu);
      } catch (err) {
        console.warn('[devices-stub] IDU MongoDB fetch failed:', err.message);
      }
    }

    return res.json([...javaDevices, ...iduDevices]);
  } catch (err) {
    console.error('[devices-stub] GET /devices error:', err.message);
    // Fall through to Java proxy on unexpected error
    next();
  }
});

// ── POST /api/v1/devices — Create a new device ───────────────────────────────
router.post('/', async (req, res) => {
  try {
    const col = await getCol();
    const body = req.body || {};

    if (!body.serialNumber) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'serialNumber is required' });
    }
    if (!body.deviceType) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'deviceType is required' });
    }

    // Enforce model derivation
    const TYPE_MODEL = { BTS: 'A60', CPE: 'A61', IDU: 'IDU' };
    const model = TYPE_MODEL[body.deviceType] || body.model || body.deviceType;

    const now = new Date();
    const doc = {
      _id:             body.serialNumber,   // use serial as natural key
      id:              body.serialNumber,
      deviceId:        body.serialNumber,
      serialNumber:    body.serialNumber,
      name:            body.name || body.deviceName || body.serialNumber,
      deviceType:      body.deviceType,
      model,
      status:          body.status || 'PROVISIONING',
      ipAddress:       body.ipAddress  || null,
      macAddress:      body.macAddress || null,
      latitude:        body.latitude   || null,
      longitude:       body.longitude  || null,
      firmwareVersion: body.firmwareVersion || null,
      manufacturer:    body.manufacturer    || 'Senao',
      organizationId:  body.organizationId  || null,
      networkId:       body.networkId       || null,
      tags:            body.tags || [],
      channel:         body.channel || null,
      channelBandwidth: body.channelBandwidth || null,
      uptimeSeconds:   0,
      createdAt:       now,
      updatedAt:       now,
      createdBy:       req.user?.username || 'admin',
    };

    // Upsert by serialNumber to avoid duplicate key errors
    await col.replaceOne({ _id: doc._id }, doc, { upsert: true });

    console.log(`[devices-stub] Created device: ${doc.serialNumber} (${doc.deviceType}/${doc.model})`);
    res.status(201).json(doc);
  } catch (e) {
    console.error('[devices-stub] POST /devices error:', e.message);
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── PUT /api/v1/devices/:id — Update a device ────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const col = await getCol();
    const id  = req.params.id;
    const updates = { ...req.body, updatedAt: new Date() };
    delete updates._id;
    delete updates.id;

    const result = await col.findOneAndUpdate(
      { $or: [{ _id: id }, { id }, { serialNumber: id }, { deviceId: id }] },
      { $set: updates },
      { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: `Device '${id}' not found` });
    res.json(result);
  } catch (e) {
    console.error('[devices-stub] PUT /devices error:', e.message);
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── DELETE /api/v1/devices/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const col = await getCol();
    const id  = req.params.id;
    const result = await col.deleteOne(
      { $or: [{ _id: id }, { id }, { serialNumber: id }, { deviceId: id }] }
    );
    if (result.deletedCount === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: `Device '${id}' not found` });
    }
    res.status(204).send();
  } catch (e) {
    console.error('[devices-stub] DELETE /devices error:', e.message);
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── PUT /api/v1/devices/:id/tags ─────────────────────────────────────────────
router.put('/:id/tags', async (req, res) => {
  try {
    const col = await getCol();
    const id  = req.params.id;
    const { tags } = req.body || {};
    const result = await col.findOneAndUpdate(
      { $or: [{ _id: id }, { id }, { serialNumber: id }, { deviceId: id }] },
      { $set: { tags: tags || [], updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: `Device '${id}' not found` });
    res.json(result);
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

module.exports = router;

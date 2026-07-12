'use strict';

/**
 * Device write stub — handles POST/PUT/DELETE for /api/v1/devices.
 * GET requests are NOT handled here (they pass through to the Java inventory service).
 * Writes go directly to MongoDB because the Java inventory service's write
 * endpoints fail when Kafka is down (it tries to publish events).
 *
 * Mounted BEFORE the proxy routes in app.js.
 */
const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const MONGO_URI  = process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubr_nms';
const COLLECTION = 'devices';

let _col = null;

async function getCol() {
  if (_col) return _col;
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection(COLLECTION);
    return _col;
  }
  // Use the shared ubr_nms database (same as Java inventory service)
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _col = conn.db.collection(COLLECTION);
  return _col;
}

getCol().catch((err) => console.error('[devices-stub] MongoDB connect failed:', err.message));

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

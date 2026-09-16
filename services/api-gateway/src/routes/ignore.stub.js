'use strict';

/**
 * Discovery Ignore stub — persists "ignored" host IPs so admins can suppress
 * devices from the discovery results without provisioning them.
 *
 * Endpoints:
 *   GET    /api/v1/discovery/ignore          — list all ignored IPs
 *   POST   /api/v1/discovery/ignore          — add one or more IPs to the ignore list
 *   DELETE /api/v1/discovery/ignore/:ip      — remove an IP from the ignore list (un-ignore)
 *
 * Storage: MongoDB collection `ubrnms.ignored_devices`.
 * The collection schema is intentionally thin — just IP + metadata.
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI
  || process.env.MONGO_URL
  || 'mongodb://mongodb:27017/ubr_nms';

let _col = null;

async function getIgnoredCol() {
  if (_col) return _col;
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection('ignored_devices');
    return _col;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _col = conn.db.collection('ignored_devices');
  return _col;
}

getIgnoredCol().catch((err) =>
  console.error('[ignore-stub] MongoDB connect failed:', err.message),
);

/** GET /api/v1/discovery/ignore — returns [{ip, ignoredAt, ignoredBy},...] */
async function listIgnored(req, res) {
  try {
    const col = await getIgnoredCol();
    const docs = await col.find({}).toArray();
    res.json(docs.map((d) => ({
      ip:         d.ip,
      ignoredAt:  d.ignoredAt,
      ignoredBy:  d.ignoredBy ?? 'admin',
      reason:     d.reason ?? '',
    })));
  } catch (err) {
    console.error('[ignore-stub] listIgnored error:', err.message);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err.message });
  }
}

/**
 * POST /api/v1/discovery/ignore
 * Body: { ips: string[], reason?: string }  OR  { ip: string, reason?: string }
 *
 * Upserts by IP so repeated ignores are idempotent.
 */
async function addIgnored(req, res) {
  try {
    const body = req.body || {};
    // Accept both { ip: '1.2.3.4' } and { ips: ['1.2.3.4', '5.6.7.8'] }
    const rawIps = body.ips ?? (body.ip ? [body.ip] : []);
    if (!Array.isArray(rawIps) || rawIps.length === 0) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'ips array is required' });
    }

    const col = await getIgnoredCol();
    const now = new Date().toISOString();
    const actor = req.user?.username ?? 'admin';

    await Promise.all(rawIps.map((ip) => {
      const doc = {
        ip,
        ignoredAt: now,
        ignoredBy: actor,
        reason:    body.reason ?? '',
      };
      return col.replaceOne({ ip }, doc, { upsert: true });
    }));

    res.status(201).json({ ignored: rawIps, ignoredAt: now });
  } catch (err) {
    console.error('[ignore-stub] addIgnored error:', err.message);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err.message });
  }
}

/**
 * DELETE /api/v1/discovery/ignore/:ip
 * Un-ignores a single IP address.
 * The IP in the path parameter may be URL-encoded.
 */
async function removeIgnored(req, res) {
  try {
    const ip = decodeURIComponent(req.params.ip || '').trim();
    if (!ip) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'ip path parameter is required' });
    }
    const col = await getIgnoredCol();
    const result = await col.deleteOne({ ip });
    if (result.deletedCount === 0) {
      // Idempotent — IP wasn't in the ignore list, treat as success
      return res.json({ unignored: ip, wasPresent: false });
    }
    res.json({ unignored: ip, wasPresent: true });
  } catch (err) {
    console.error('[ignore-stub] removeIgnored error:', err.message);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err.message });
  }
}

module.exports = { listIgnored, addIgnored, removeIgnored };

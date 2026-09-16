'use strict';

/**
 * Provision stub — intercepts POST /api/v1/discovery/runs/:runId/provision
 * before the discovery-service proxy.
 *
 * Why here and not in the discovery-service?
 * In dev, the discovery-service would need to call the Java inventory-service
 * to create devices, but that service is Kafka-dependent and often unavailable.
 * The API gateway already has MongoDB access (same store as devices.stub.js) and
 * can write provisioned devices directly so they appear in inventory and topology
 * without needing the full Java stack.
 *
 * In production, the discovery-service provision endpoint talks directly to the
 * Java inventory-service over the internal Docker network and bypasses this stub.
 */

const mongoose      = require('mongoose');
const topologyStub  = require('./topology.stub');

const MONGO_URI  = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongo:27017/ubrnms';
const COLLECTION = 'devices';

let _col = null;

async function getDevicesCol() {
  if (_col) return _col;
  // Prefer the existing mongoose connection used by the gateway (avoids duplicate connections).
  if (mongoose.connection.readyState === 1) {
    _col = mongoose.connection.db.collection(COLLECTION);
    return _col;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _col = conn.db.collection(COLLECTION);
  return _col;
}

// Eagerly connect so the first provision request isn't slow.
getDevicesCol().catch((err) =>
  console.error('[provision-stub] MongoDB connect failed:', err.message),
);

/** Map discovery device type → hardware model string (mirrors devices.stub.js). */
const TYPE_MODEL = { BTS: 'A60', CPE: 'A61', IDU: 'IDU' };

/**
 * Writes a single ProvisionHost to MongoDB and returns the result object.
 * Upserts by serialNumber so re-provisioning the same device is idempotent.
 *
 * @param {object} host  One element from req.body.hosts
 * @param {object} col   Mongoose Collection handle
 * @returns {{ ip, deviceId, serialNumber, status, error? }}
 */
async function provisionOne(host, col) {
  const {
    ip, deviceType, serialNumber, macAddress,
    networkId, vendor, model, sysName, sysLocation,
    sysObjectID, sysDescr, latitude, longitude,
  } = host;

  if (!ip || !serialNumber || !deviceType) {
    return { ip, deviceId: '', serialNumber, status: 'failed', error: 'ip, serialNumber, and deviceType are required' };
  }

  const validTypes = ['BTS', 'CPE', 'IDU'];
  if (!validTypes.includes(deviceType)) {
    return { ip, deviceId: serialNumber, serialNumber, status: 'failed', error: `Invalid deviceType '${deviceType}'. Must be BTS, CPE, or IDU` };
  }

  try {
    const now          = new Date();
    const derivedModel = TYPE_MODEL[deviceType] || model || deviceType;
    const deviceName   = sysName || `${deviceType}-${ip.replace(/\./g, '-')}`;

    const doc = {
      _id:              serialNumber,
      id:               serialNumber,
      deviceId:         serialNumber,
      serialNumber,
      name:             deviceName,
      deviceName,
      deviceType,
      model:            derivedModel,
      // Provisioned via SNMP discovery → ONLINE immediately for admin-initiated provision.
      status:           'ONLINE',
      ipAddress:        ip,
      macAddress:       macAddress || null,
      latitude:         (latitude != null && !isNaN(latitude)) ? parseFloat(latitude) : null,
      longitude:        (longitude != null && !isNaN(longitude)) ? parseFloat(longitude) : null,
      networkId:        networkId || null,
      manufacturer:     vendor    || 'Unknown',
      sysName:          sysName   || null,
      sysLocation:      sysLocation || null,
      sysObjectID:      sysObjectID || null,
      sysDescr:         sysDescr  || null,
      // Discovery metadata so inventory UI can surface how it was found.
      discoveryParadigm: 'SNMP',
      tags:             ['snmp-discovered'],
      uptimeSeconds:    0,
      createdAt:        now,
      updatedAt:        now,
    };

    // ── IP + hostname uniqueness (spec requirement) ────────────────────────
    // Only one active provisioned record may exist for a given IP+hostname pair.
    // If a record already exists for this IP with the same hostname AND a different
    // serial number, reject the request with a 409 — the admin must deprovision
    // the existing device before re-provisioning it with a new serial.
    //
    // If the hostname differs (device was replaced), clean up the old record and
    // allow the new one through (the old serial is considered stale).
    const existingForIp = await col.findOne({ ipAddress: ip, _id: { $ne: serialNumber } });
    if (existingForIp) {
      const existingHostname = existingForIp.sysName || existingForIp.name || '';
      const incomingHostname = deviceName;
      if (existingHostname === incomingHostname) {
        // Same IP + same hostname → duplicate; reject.
        return {
          ip,
          deviceId: '',
          serialNumber,
          status: 'failed',
          error: `A provisioned record already exists for IP ${ip} with hostname '${existingHostname}' (serial: ${existingForIp._id}). Deprovision it first.`,
        };
      }
      // Different hostname → stale record for the same IP (device was replaced).
      const removed = await col.deleteMany({ ipAddress: ip, _id: { $ne: serialNumber } });
      if (removed.deletedCount > 0) {
        console.log(`[provision-stub] Cleaned up ${removed.deletedCount} stale entries for IP ${ip} (hostname changed)`);
      }
    }

    // Upsert by serialNumber (_id) — idempotent for re-provisioning the same serial.
    await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    console.log(`[provision-stub] Provisioned ${serialNumber} (${deviceType}) @ ${ip}`);

    return { ip, deviceId: serialNumber, serialNumber, status: 'provisioned' };
  } catch (err) {
    console.error(`[provision-stub] Failed to provision ${ip}:`, err.message);
    return { ip, deviceId: '', serialNumber, status: 'failed', error: err.message };
  }
}

/**
 * Factory that returns a middleware handler — accepts the gateway config object
 * so it can be extended later (e.g. to forward to Java inventory in production).
 *
 * @param {object} _config  Gateway config (unused for now, reserved for forward-compat)
 * @returns Express request handler
 */
function createProvisionHandler(_config) {
  return async function provisionHandler(req, res) {
    const { runId } = req.params;
    const { hosts } = req.body || {};

    if (!Array.isArray(hosts) || hosts.length === 0) {
      return res.status(400).json({
        code:    'VALIDATION_ERROR',
        message: 'Request body must contain a non-empty "hosts" array',
      });
    }

    // Guard against runaway payloads.
    if (hosts.length > 500) {
      return res.status(400).json({
        code:    'VALIDATION_ERROR',
        message: `Too many hosts — maximum 500 per request, got ${hosts.length}`,
      });
    }

    let col;
    try {
      col = await getDevicesCol();
    } catch (err) {
      console.error('[provision-stub] Cannot reach MongoDB:', err.message);
      return res.status(503).json({ code: 'DB_UNAVAILABLE', message: 'Device store unavailable' });
    }

    // Provision all hosts, collecting individual results (partial failure is allowed).
    const results = await Promise.all(hosts.map((h) => provisionOne(h, col)));

    const provisioned = results.filter((r) => r.status === 'provisioned').length;
    const failed      = results.filter((r) => r.status === 'failed').length;

    console.log(`[provision-stub] Run ${runId}: ${provisioned} provisioned, ${failed} failed`);

    // Invalidate topology cache so the next GET /api/v1/topology picks up new devices immediately.
    if (provisioned > 0) {
      topologyStub.bustTopologyCache();
    }

    // 207 Multi-Status when some succeeded and some failed; 201 on full success.
    const status = failed > 0 && provisioned > 0 ? 207 : failed > 0 ? 422 : 201;
    return res.status(status).json({ results, provisioned, failed });
  };
}

module.exports = { createProvisionHandler };

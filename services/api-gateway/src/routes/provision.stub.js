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
const live          = require('../live/liveParameters');

const MONGO_URI      = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongo:27017/ubrnms';
const PRODUCTDEF_URI = (process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongo:27017/ubrnms')
                          .replace(/\/[^/?]+(\?|$)/, '/ubrnms_productdef$1');
const COLLECTION = 'devices';

let _col        = null;
let _fregCol    = null;
let _fregConn   = null;

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

/** Returns the fingerprint_registry_entries collection from ubrnms_productdef. */
async function getFingerprintCol() {
  if (_fregCol) return _fregCol;
  if (!_fregConn) {
    _fregConn = await mongoose.createConnection(PRODUCTDEF_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  }
  _fregCol = _fregConn.db.collection('fingerprint_registry_entries');
  return _fregCol;
}

/**
 * Given a sysDescr string, query the BANNER fingerprint registry to find a
 * matching product definition.  Returns { vendor, model, productDefinitionId }
 * or null when no fingerprint matches.
 */
async function resolveBannerFingerprint(sysDescr) {
  if (!sysDescr) return null;
  try {
    const col     = await getFingerprintCol();
    const banners = await col.find({ fingerprintType: 'BANNER' }).toArray();
    for (const entry of banners) {
      try {
        if (new RegExp(entry.fingerprintValue, 'i').test(sysDescr)) {
          return {
            vendor:              entry.vendor,
            model:               entry.model,
            productDefinitionId: entry.productDefinitionId,
          };
        }
      } catch {
        // Invalid regex in registry — skip
      }
    }
  } catch (err) {
    console.warn('[provision-stub] Fingerprint registry lookup failed:', err.message);
  }
  return null;
}

/**
 * Resolves a device against the same sources discovery classifies with, so a
 * type discovery reported (e.g. RADIO for an EOC device) is also accepted here:
 *   1. BANNER entries in the gateway's MongoDB registry (sysDescr regex)
 *   2. The product-definition service registry — SNMP OID prefix on sysObjectID,
 *      or sysDescr pattern (this is where uploaded definitions actually live)
 *   3. The gateway's built-in vendor OID map (classifyByOid's legacy layer)
 * Returns { vendor, model, productDefinitionId, paradigm } or null.
 */
async function resolveFingerprint(sysDescr, sysObjectID) {
  const banner = await resolveBannerFingerprint(sysDescr);
  if (banner) return { ...banner, paradigm: 'BANNER' };

  const oid  = (sysObjectID || '').replace(/^\./, '');
  const pick = (e, paradigm) => ({
    vendor: e.vendor, model: e.model, productDefinitionId: e.productDefinitionId, paradigm,
  });
  try {
    // Lazy require: discovery.stub requires this module at load time.
    const { fetchAllFingerprintsFromPDService, classifyByOid } = require('./discovery.stub');
    const entries = await fetchAllFingerprintsFromPDService();
    for (const e of entries) {
      const entryOid = (e.sysObjectId || '').replace(/^\./, '');
      if (e.fingerprintType === 'SNMP_OID' && oid && entryOid &&
          (oid === entryOid || oid.startsWith(entryOid + '.'))) {
        return pick(e, 'SNMP');
      }
    }
    if (sysDescr) {
      for (const e of entries) {
        if (e.fingerprintType !== 'BANNER' || !e.fingerprintValue) continue;
        try {
          if (new RegExp(e.fingerprintValue, 'i').test(sysDescr)) return pick(e, 'BANNER');
        } catch { /* invalid regex in registry — skip */ }
      }
    }
    if (oid) {
      const c = await classifyByOid(oid);
      if (c && c.productDefinitionId) return pick(c, 'SNMP');
    }
  } catch (err) {
    console.warn('[provision-stub] Registry lookup failed:', err.message);
  }
  return null;
}

// Eagerly connect so the first provision request isn't slow.
getDevicesCol().catch((err) =>
  console.error('[provision-stub] MongoDB connect failed:', err.message),
);

/**
 * SNMP credential for live parameter reads. Discovery stores the community it used on the
 * device record at the same IP; a credentialId on the host (saved credential) is honoured too.
 * A community supplied directly in the request body is intentionally not accepted.
 */
async function resolveSnmpCredential(col, host, ip) {
  const port = parseInt(host.snmpPort || host.port, 10) || 161;
  const prior = await col.findOne(
    { ipAddress: ip, snmpCommunity: { $nin: [null, ''] } },
    { projection: { snmpCommunity: 1, snmpPort: 1 } },
  );
  if (prior) return { community: prior.snmpCommunity, port: prior.snmpPort || port };
  if (host.credentialId) {
    try {
      const cred = await mongoose.connection.db.collection('snmp_credentials')
        .findOne({ _id: new mongoose.Types.ObjectId(host.credentialId) });
      if (cred && cred.community) return { community: cred.community, port };
    } catch { /* invalid id / missing collection */ }
  }
  return { community: null, port };
}

/** Map discovery device type → hardware model string (mirrors devices.stub.js). */
const TYPE_MODEL = { BTS: 'A60', CPE: 'A61', IDU: 'IDU' };

/** Device types that are always valid without a fingerprint registry match. */
const BUILTIN_TYPES = new Set(['BTS', 'CPE', 'IDU']);

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
    ip, deviceType, genericDeviceType, serialNumber, macAddress,
    networkId, vendor, model, sysName, sysLocation,
    sysObjectID, sysDescr, latitude, longitude,
    deviceRoleSource, locationSource,
    productDefinitionId: hostDefinitionId,
  } = host;

  if (!ip || !serialNumber || !deviceType) {
    return { ip, deviceId: '', serialNumber, status: 'failed', error: 'ip, serialNumber, and deviceType are required' };
  }

  // ── Banner fingerprint lookup ──────────────────────────────────────────────
  // For non-built-in device types (e.g. RADIO, EOC640, BACKHAUL) we check
  // the fingerprint registry. If sysDescr matches a BANNER fingerprint we
  // accept the device and use the registry's vendor/model metadata.
  // Built-in types (BTS/CPE/IDU) bypass the registry check.
  let fingerprintMeta = null;
  if (!BUILTIN_TYPES.has(deviceType)) {
    fingerprintMeta = await resolveFingerprint(sysDescr, sysObjectID);
    if (!fingerprintMeta) {
      // Unknown type AND no fingerprint match — reject gracefully
      return {
        ip, deviceId: serialNumber, serialNumber, status: 'failed',
        error: `Unknown deviceType '${deviceType}' with no matching fingerprint registry entry. ` +
               `Upload and activate a product definition with a sysObjectId matching '${sysObjectID || '(none)'}' ` +
               `or a sysDescrPattern matching '${sysDescr || '(none)'}'.`,
      };
    }
    console.log(`[provision-stub] Resolved ${serialNumber} (${fingerprintMeta.paradigm}: oid '${sysObjectID}', sysDescr '${sysDescr}') → productDef '${fingerprintMeta.productDefinitionId}' model '${fingerprintMeta.model}'`);
  }

  try {
    const now = new Date();

    // Prefer fingerprint registry model over caller-supplied model for banner-matched devices
    // Discovery reports "Not Available" when it could not identify vendor/model.
    const known = (v) => (v && v !== 'Not Available' ? v : null);
    const resolvedVendor = fingerprintMeta?.vendor || known(vendor) || 'Unknown';
    const resolvedModel  = fingerprintMeta?.model  || known(model) || TYPE_MODEL[deviceType] || deviceType;
    const deviceName     = sysName || `${resolvedModel}-${ip.replace(/\./g, '-')}`;
    // Discovery paradigm: SNMP for OID-matched, BANNER for pattern-matched
    const paradigm       = fingerprintMeta ? fingerprintMeta.paradigm : 'SNMP';

    // Link the device to the ACTIVE product definition (drives the Node View) and keep the SNMP
    // credential discovery used, so live values can be read from the device afterwards.
    const productDefinitionId = await live.resolveDefinitionId(
      [fingerprintMeta?.productDefinitionId, hostDefinitionId], resolvedVendor,
    );
    const snmp = await resolveSnmpCredential(col, host, ip);

    const doc = {
      _id:              serialNumber,
      id:               serialNumber,
      deviceId:         serialNumber,
      serialNumber,
      name:             deviceName,
      deviceName,
      deviceType,
      genericDeviceType: genericDeviceType || deviceType,
      model:            resolvedModel,
      productDefinitionId: productDefinitionId || null,
      ...(snmp.community ? { snmpPort: snmp.port, snmpCommunity: snmp.community } : {}),
      // Provisioned via discovery → ONLINE immediately for admin-initiated provision.
      status:           'ONLINE',
      ipAddress:        ip,
      macAddress:       macAddress || null,
      latitude:         (latitude != null && !isNaN(latitude)) ? parseFloat(latitude) : null,
      longitude:        (longitude != null && !isNaN(longitude)) ? parseFloat(longitude) : null,
      networkId:        networkId || null,
      manufacturer:     resolvedVendor,
      sysName:          sysName   || null,
      sysLocation:      sysLocation || null,
      sysObjectID:      sysObjectID || null,
      sysDescr:         sysDescr  || null,
      deviceRoleSource: deviceRoleSource || null,
      locationSource:   locationSource   || null,
      // Discovery metadata so inventory UI can surface how it was found.
      discoveryParadigm: paradigm,
      tags:             [paradigm.toLowerCase() + '-discovered'],
      uptimeSeconds:    0,
      createdAt:        now,
      updatedAt:        now,
    };

    // ── IP + hostname uniqueness (spec requirement) ────────────────────────
    // Only one ACTIVE (non-deprovisioned) provisioned record may exist for a
    // given IP+hostname pair.
    //
    // Deprovisioned records are treated as soft-deleted — they must NEVER block
    // a fresh provision of the same or a replacement device at the same IP.
    // This prevents the "previously deprovisioned" 422 loop in the UI.
    //
    // Decision matrix for existing record at same IP (different serial):
    //   • isDeprovisioned=true            → clean it up, allow new provision
    //   • active + same hostname          → reject (duplicate), user must deprovision
    //   • active + different hostname     → clean up stale record (device replaced)
    const existingForIp = await col.findOne({ ipAddress: ip, _id: { $ne: serialNumber } });
    if (existingForIp) {
      if (existingForIp.isDeprovisioned === true) {
        // Deprovisioned record — always safe to overwrite; clean it up first.
        await col.deleteMany({ ipAddress: ip, isDeprovisioned: true, _id: { $ne: serialNumber } });
        console.log(`[provision-stub] Cleared deprovisioned record for IP ${ip} — allowing re-provision`);
      } else {
        const existingHostname = existingForIp.sysName || existingForIp.name || '';
        const incomingHostname = deviceName;
        if (existingHostname === incomingHostname) {
          // Same IP + same hostname + active → genuine duplicate; reject.
          return {
            ip,
            deviceId: '',
            serialNumber,
            status: 'failed',
            error: `A provisioned record already exists for IP ${ip} with hostname '${existingHostname}' (serial: ${existingForIp._id}). Deprovision it first.`,
          };
        }
        // Different hostname → stale active record (device was replaced); clean up.
        const removed = await col.deleteMany({ ipAddress: ip, _id: { $ne: serialNumber } });
        if (removed.deletedCount > 0) {
          console.log(`[provision-stub] Cleaned up ${removed.deletedCount} stale entries for IP ${ip} (hostname changed)`);
        }
      }
    }

    // Upsert by serialNumber (_id) — idempotent for re-provisioning the same serial.
    await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    console.log(`[provision-stub] Provisioned ${serialNumber} (${deviceType}) @ ${ip} productDef=${productDefinitionId || 'none'}`);

    // First live read straight away (fire-and-forget) so the Node View has data when opened.
    if (productDefinitionId) live.refreshDevice(doc).catch(() => {});

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

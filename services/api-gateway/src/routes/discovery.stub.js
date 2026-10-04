'use strict';

/**
 * Discovery stub — handles auto-scan flows in the dev environment.
 *
 * Routes:
 *   POST /api/v1/discovery/scans          – start a new auto-discovery scan (banner/demo)
 *   GET  /api/v1/discovery/scans          – list past scans
 *   GET  /api/v1/discovery/scans/:scanId  – get scan status / results
 *   POST /api/v1/discovery/snmp-probe     – REAL SNMP probe any agent (iReasoning / nms-snmpsim)
 *   POST /api/v1/demo/seed                – directly seed demo devices (shortcut)
 *
 * How auto-scan works:
 *   1. Caller supplies { subnets, definitionId? } (or we scan a default range)
 *   2. We query fingerprint_registry_entries for BANNER entries
 *   3. We generate simulated "discovered" hosts whose sysDescr matches a BANNER pattern
 *   4. We write those hosts to ubrnms.devices via the same provisionOne() logic
 *   5. Response includes the full list of provisioned device records
 *
 * How snmp-probe works:
 *   POST /api/v1/discovery/snmp-probe
 *   Body: { targets: ["host:port", ...], community?: "public", version?: "2c" }
 *   - Sends SNMP v2c GetRequest for MIB-II system group OIDs to each target
 *   - Uses Node.js built-in dgram (no extra npm packages)
 *   - Resolves BANNER fingerprints for product definition matching
 *   - Provisions matched devices into MongoDB as real discovered inventory
 */

const express    = require('express');
const dgram      = require('dgram');
const http       = require('http');
const mongoose   = require('mongoose');
const { createProvisionHandler } = require('./provision.stub');
const router     = express.Router();

// ── Product-definition service URL (for fingerprint registry lookups) ─────────
// Inside Docker network: product-definition-service:8093
// Local dev / test: localhost:8093
const PD_SERVICE_URL = process.env.FINGERPRINT_REGISTRY_URL || 'http://product-definition-service:8093';

/**
 * Fetch ALL fingerprint registry entries from the Java product-definition service.
 * Returns an array of normalised fingerprint objects:
 *   { fingerprintType: 'SNMP_OID'|'BANNER', fingerprintValue: string, productDefinitionId: string }
 * Falls back to empty array on any error.
 */
let _pdRegistryCache   = null;
let _pdRegistryCachedAt = 0;
const PD_REGISTRY_TTL_MS = 60_000;

async function fetchAllFingerprintsFromPDService() {
  if (_pdRegistryCache && Date.now() - _pdRegistryCachedAt < PD_REGISTRY_TTL_MS) {
    return _pdRegistryCache;
  }
  return new Promise((resolve) => {
    const url = `${PD_SERVICE_URL}/internal/fingerprint-registry`;
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const entries = Array.isArray(parsed) ? parsed : (parsed.entries || []);
          // Normalise Java PascalCase wire format → gateway camelCase format
          const normalised = [];
          for (const e of entries) {
            // Support both Java PascalCase wire format (legacy InternalRegistryController)
            // and Spring Boot default camelCase JSON (FingerprintRegistryEntry @Document).
            const defId = e.productDefinitionId || e.ProductDefinitionID || '';
            if (!defId) continue;
            const oidPrefix = (e.SNMPOIDPrefix || '').replace(/^\./, '');
            const oidExact  = (e.SNMPOIDExact  || '').replace(/^\./, '');
            const sysOid    = (e.fingerprintValue || e.sysObjectId || oidPrefix || oidExact || '').replace(/^\./, '');
            const banner    = e.SSHBannerSubstring || (e.fingerprintType === 'BANNER' ? e.fingerprintValue : '') || '';
            const vendor    = e.vendor    || e.Vendor || '';
            const model     = e.model     || e.Model  || '';
            // deviceType and GPS come from the uploaded Product Definition (new fields)
            const deviceType  = e.deviceType  || null;
            const defaultLat  = e.defaultLatitude  != null ? parseFloat(e.defaultLatitude)  : null;
            const defaultLon  = e.defaultLongitude != null ? parseFloat(e.defaultLongitude) : null;
            const base = { productDefinitionId: defId, vendor, model, deviceType, defaultLatitude: defaultLat, defaultLongitude: defaultLon };
            // Prefer prefix match; fall back to exact match / sysOid from camelCase format
            if (oidPrefix) {
              normalised.push({ ...base, fingerprintType: 'SNMP_OID', fingerprintValue: oidPrefix, sysObjectId: oidPrefix });
            } else if (oidExact) {
              normalised.push({ ...base, fingerprintType: 'SNMP_OID', fingerprintValue: oidExact,  sysObjectId: oidExact  });
            } else if (sysOid && e.fingerprintType === 'SNMP_OID') {
              normalised.push({ ...base, fingerprintType: 'SNMP_OID', fingerprintValue: sysOid,    sysObjectId: sysOid    });
            }
            if (banner) {
              normalised.push({ ...base, fingerprintType: 'BANNER', fingerprintValue: banner });
            }
          }
          _pdRegistryCache   = normalised;
          _pdRegistryCachedAt = Date.now();
          resolve(normalised);
        } catch (parseErr) {
          console.warn('[discovery-stub] Failed to parse PD registry response:', parseErr.message);
          resolve([]);
        }
      });
    }).on('error', (err) => {
      console.warn('[discovery-stub] PD registry fetch failed:', err.message);
      resolve([]);
    });
  });
}

/**
 * Fetch fingerprints for a specific productDefinitionId — queries PD service first,
 * falls back to MongoDB fingerprint_registry_entries.
 */
async function fetchCallerFingerprints(definitionId, mongoFallback) {
  // Try PD service (authoritative source)
  const all = await fetchAllFingerprintsFromPDService();
  const matched = all.filter((e) => e.productDefinitionId === definitionId);
  if (matched.length > 0) {
    console.log(`[discovery-stub] PD-service fingerprints for '${definitionId}': ${matched.length} entry(s)`);
    return matched;
  }
  // Fall back to MongoDB fingerprint_registry_entries (legacy seed data)
  try {
    const col = mongoFallback || await getFingerprintCol();
    const mongoEntries = await col.find({ productDefinitionId: definitionId }).toArray();
    console.log(`[discovery-stub] MongoDB fingerprints for '${definitionId}': ${mongoEntries.length} entry(s)`);
    return mongoEntries;
  } catch (mongoErr) {
    console.error(`[discovery-stub] ❌ MongoDB fingerprint fallback failed for '${definitionId}':`, mongoErr.message);
    return [];
  }
}

// ── Test-network SNMP port overrides (module-level) ───────────────────────────
// Simulators on snmp-test-net (10.10.10.0/24) listen on non-standard SNMP ports.
// Java discovery hardcodes port 161 and can't reach these directly.
// The gateway auto-bypasses Java for these IPs and uses these port mappings.
const TEST_SNMP_PORT_MAP = {
  '10.10.10.25': 1161,  // nms-snmpsim  — generic MIB-II / Cisco walk
  '10.10.10.26': 1162,  // nms-eoc-bts  — EOC Configurations_GUI BTS
  '10.10.10.27': 1163,  // nms-eoc-cpe  — EOC Configurations_GUI CPE
};

// ── Multi-port host expansion ─────────────────────────────────────────────────
// When a hostname is entered without an explicit port (e.g. "host.docker.internal"),
// expand it to all known simulator ports so SNMP Network Discovery behaves the
// same as Quick SNMP Discovery which uses explicit host:port notation.
const MULTI_PORT_HOST_MAP = {
  'host.docker.internal': [1162, 1163, 1161], // BTS, CPE, snmpsim
};

// ── Minimal SNMP v2c BER encoder/decoder (pure Node.js, no libs) ──────────────

function tlv(tag, val) {
  const n = val.length;
  if (n < 128) return Buffer.concat([Buffer.from([tag, n]), val]);
  if (n < 256) return Buffer.concat([Buffer.from([tag, 0x81, n]), val]);
  return Buffer.concat([Buffer.from([tag, 0x82, n >> 8, n & 0xFF]), val]);
}

function encodeInt(val) {
  if (val === 0) return Buffer.from([0x00]);
  const bytes = [];
  let n = val;
  while (n > 0) { bytes.unshift(n & 0xFF); n >>= 8; }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return Buffer.from(bytes);
}

function encodeOid(dotted) {
  const parts = dotted.replace(/^\./, '').split('.').map(Number);
  const result = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 128) { result.push(p); }
    else {
      const enc = [];
      let n = p;
      while (n) { enc.unshift(n & 0x7f); n >>= 7; }
      for (let i = 0; i < enc.length - 1; i++) enc[i] |= 0x80;
      result.push(...enc);
    }
  }
  return Buffer.from(result);
}

/**
 * Build an SNMP GetRequest PDU.
 * @param {string} community  - SNMP community string
 * @param {string[]} oids     - OID list in dotted notation
 * @param {string} [version]  - 'v1' | 'v2c' (default 'v2c')
 */
function buildGetRequest(community, oids, version = 'v2c') {
  const varbinds = oids.map(oid =>
    tlv(0x30, Buffer.concat([tlv(0x06, encodeOid(oid)), tlv(0x05, Buffer.alloc(0))]))
  );
  const varbindList = tlv(0x30, Buffer.concat(varbinds));
  const pdu = tlv(0xa0, Buffer.concat([
    tlv(0x02, encodeInt(Math.floor(Math.random() * 0xffff))),  // requestId
    tlv(0x02, Buffer.from([0x00])),  // errorStatus
    tlv(0x02, Buffer.from([0x00])),  // errorIndex
    varbindList,
  ]));
  // version byte: SNMPv1 = 0, SNMPv2c = 1
  const versionByte = version === 'v1' ? 0x00 : 0x01;
  return tlv(0x30, Buffer.concat([
    tlv(0x02, Buffer.from([versionByte])),
    tlv(0x04, Buffer.from(community, 'ascii')),
    pdu,
  ]));
}

/** Read a single BER TLV at `pos`. Returns { tag, value:Buffer, next:number }. */
function readTlv(buf, pos) {
  const tag = buf[pos++];
  let len;
  const lb = buf[pos++];
  if (lb < 0x80) { len = lb; }
  else if (lb === 0x81) { len = buf[pos++]; }
  else { len = (buf[pos++] << 8) | buf[pos++]; }
  return { tag, value: buf.slice(pos, pos + len), next: pos + len };
}

/** Decode an OID byte buffer to dotted-string notation. */
function decodeOidBytes(ob) {
  if (!ob || ob.length === 0) return '';
  const f = ob[0];
  let s = `${Math.floor(f / 40)}.${f % 40}`;
  let i = 1;
  while (i < ob.length) {
    let v = 0; let b;
    do { b = ob[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && i < ob.length);
    s += '.' + v;
  }
  return s;
}

/** Parse a raw SNMP v2c response buffer and extract { '.oid': 'value' } pairs. */
function parseSnmpResponse(buf) {
  const result = {};
  try {
    // outer SEQUENCE
    const outer = readTlv(buf, 0);
    let pos = 0;
    // version INTEGER — skip entirely
    const ver = readTlv(outer.value, pos); pos = ver.next;
    // community OCTET STRING — skip entirely
    const comm = readTlv(outer.value, pos); pos = comm.next;
    // PDU (GetResponse = 0xa2)
    const pdu = readTlv(outer.value, pos);
    if ((pdu.tag & 0xe0) !== 0xa0) return result; // not a PDU
    let pp = 0;
    // requestId, errorStatus, errorIndex — skip 3 INTEGERs
    for (let i = 0; i < 3; i++) { const t = readTlv(pdu.value, pp); pp = t.next; }
    // varbind list SEQUENCE
    const vbList = readTlv(pdu.value, pp);
    let vp = 0;
    while (vp < vbList.value.length) {
      const vb = readTlv(vbList.value, vp); vp = vb.next;
      // each varbind is SEQUENCE { OID, value }
      let ip = 0;
      const oidTlv = readTlv(vb.value, ip); ip = oidTlv.next;
      if (oidTlv.tag !== 0x06) continue;
      const oidStr = decodeOidBytes(oidTlv.value);
      const valTlv = readTlv(vb.value, ip);
      let valStr = '';
      if (valTlv.tag === 0x04) {
        valStr = valTlv.value.toString('utf8').replace(/\0/g, '').trim();
      } else if (valTlv.tag === 0x06) {
        valStr = decodeOidBytes(valTlv.value);
      } else if (valTlv.tag === 0x02 || valTlv.tag === 0x41 || valTlv.tag === 0x43) {
        let n = 0; for (const b of valTlv.value) n = (n * 256) + b; valStr = String(n);
      } else {
        valStr = valTlv.value.toString('hex');
      }
      result['.' + oidStr] = valStr;
    }
  } catch { /* partial parse OK */ }
  return result;
}

/**
 * Send a real SNMP v1/v2c GetRequest and return parsed MIB-II system group values.
 * @param {string} host
 * @param {number} port
 * @param {string} community
 * @param {number} [timeoutMs]
 * @param {string} [version]  - 'v1' | 'v2c'
 */
function snmpGet(host, port, community, timeoutMs = 4000, version = 'v2c') {
  return new Promise((resolve, reject) => {
    const SYSTEM_OIDS = [
      '1.3.6.1.2.1.1.1.0',  // sysDescr
      '1.3.6.1.2.1.1.2.0',  // sysObjectID
      '1.3.6.1.2.1.1.4.0',  // sysContact
      '1.3.6.1.2.1.1.5.0',  // sysName
      '1.3.6.1.2.1.1.6.0',  // sysLocation
    ];
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error(`SNMP timeout → ${host}:${port}`)); }, timeoutMs);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      const parsed = parseSnmpResponse(msg);
      resolve({
        sysDescr:    parsed['.1.3.6.1.2.1.1.1.0'] || null,
        sysObjectID: parsed['.1.3.6.1.2.1.1.2.0'] || null,
        sysContact:  parsed['.1.3.6.1.2.1.1.4.0'] || null,
        sysName:     parsed['.1.3.6.1.2.1.1.5.0'] || null,
        sysLocation: parsed['.1.3.6.1.2.1.1.6.0'] || null,
        raw: parsed,
      });
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    const pkt = buildGetRequest(community, SYSTEM_OIDS, version);
    sock.send(pkt, 0, pkt.length, port, host);
  });
}

/**
 * Returns true when the device MIB data matches at least one fingerprint entry
 * for the caller-selected product definition template.
 *
 * Matching rules (any hit = included):
 *   SNMP_OID  — device sysObjectID starts with the registered OID prefix
 *   BANNER    — device sysDescr matches the registered regex pattern
 *
 * When entries is empty (template has no fingerprints or none are activated),
 * returns true so all responding devices are included (safe fallback).
 */
function matchesTemplateFingerprints(mib, entries) {
  if (!entries || entries.length === 0) return true; // no fingerprint constraint → accept all
  const deviceOid = (mib.sysObjectID || '').replace(/^\./, '');
  for (const entry of entries) {
    if (entry.fingerprintType === 'SNMP_OID') {
      const oidVal = (entry.sysObjectId || entry.fingerprintValue || '').replace(/^\./, '');
      if (oidVal && deviceOid && deviceOid.startsWith(oidVal)) return true;
    }
    if (entry.fingerprintType === 'BANNER') {
      try {
        if (entry.fingerprintValue && new RegExp(entry.fingerprintValue, 'i').test(mib.sysDescr || '')) return true;
      } catch { /* bad regex — ignore */ }
    }
  }
  return false;
}

/**
 * Registry-driven OID classification.
 *
 * Priority:
 *   1. Fingerprint registry (SNMP_OID entries from activated product definitions)
 *      — longest-prefix match on sysObjectId so uploading a new definition is
 *        enough to make a new vendor discoverable. NO code change required.
 *   2. Legacy hardcoded map (fallback for devices that have no product definition
 *      uploaded yet — Cisco, Juniper, etc. work out-of-the-box).
 *
 * Cached for 30 s so the first discovery after a definition is activated picks
 * up the new entries without a gateway restart.
 */
let _snmpOidEntries    = null;   // cached entries from fingerprint_registry_entries
let _snmpOidCachedAt   = 0;
const SNMP_OID_TTL_MS  = 30_000; // 30 s

async function classifyByOid(sysObjectID) {
  if (!sysObjectID) return {};
  const oid = sysObjectID.startsWith('.') ? sysObjectID.slice(1) : sysObjectID;

  // ── Layer 1: fingerprint registry (product-definition driven, zero-code) ───
  try {
    if (!_snmpOidEntries || Date.now() - _snmpOidCachedAt > SNMP_OID_TTL_MS) {
      const col = await getFingerprintCol();
      _snmpOidEntries  = await col.find({ fingerprintType: 'SNMP_OID' }).toArray();
      _snmpOidCachedAt = Date.now();
      console.log(`[discovery-stub] OID registry refreshed — ${_snmpOidEntries.length} SNMP_OID entries`);
    }

    let bestLen  = 0;
    let bestEntry = null;
    for (const entry of _snmpOidEntries) {
      // sysObjectId in the registry may have a leading dot; normalise before comparing
      const entryOid = (entry.sysObjectId || entry.fingerprintValue || '').replace(/^\./, '');
      if (entryOid && oid.startsWith(entryOid) && entryOid.length > bestLen) {
        bestLen  = entryOid.length;
        bestEntry = entry;
      }
    }
    if (bestEntry) {
      return {
        vendor:              bestEntry.vendor  || 'Unknown',
        model:               bestEntry.model   || 'SNMP Device',
        genericDeviceType:   bestEntry.deviceType || bestEntry.genericDeviceType || 'SWITCH',
        productDefinitionId: bestEntry.productDefinitionId || null,
        // GPS from the uploaded Product Definition (set during registry build if definition had <location>)
        defaultLatitude:     bestEntry.defaultLatitude  != null ? parseFloat(bestEntry.defaultLatitude)  : null,
        defaultLongitude:    bestEntry.defaultLongitude != null ? parseFloat(bestEntry.defaultLongitude) : null,
      };
    }
  } catch (regErr) {
    console.warn('[discovery-stub] OID registry lookup failed, falling back to hardcoded map:', regErr.message);
  }

  // ── Layer 2: hardcoded legacy map (fallback for known vendors without a PD) ─
  if (oid.startsWith('1.3.6.1.4.1.9.'))     return { vendor: 'Cisco',    model: 'IOS Switch',       genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.2636.'))  return { vendor: 'Juniper',  model: 'JunOS Device',     genericDeviceType: 'ROUTER' };
  if (oid.startsWith('1.3.6.1.4.1.2272.'))  return { vendor: 'Nortel',   model: 'ERS Switch',       genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.4526.'))  return { vendor: 'Netgear',  model: 'Smart Switch',     genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.3764.'))  return { vendor: 'EOC',      model: 'EOC640',           genericDeviceType: 'RADIO', productDefinitionId: 'EOC640'             };
  if (oid.startsWith('1.3.6.1.4.1.52619.')) return { vendor: 'EOC',      model: 'Configurations_GUI', genericDeviceType: 'RADIO', productDefinitionId: 'Configurations_GUI' };
  if (oid.startsWith('1.3.6.1.4.1.41112.')) return { vendor: 'Ubiquiti', model: 'UniFi',            genericDeviceType: 'RADIO' };
  return { vendor: 'Unknown', model: 'SNMP Device', genericDeviceType: 'SWITCH' };
}

// ── MongoDB helpers ────────────────────────────────────────────────────────────

const MONGO_URI      = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongo:27017/ubrnms';
const PRODUCTDEF_URI = MONGO_URI.replace(/\/[^/?]+(\?|$)/, '/ubrnms_productdef$1');

let _devicesCol  = null;
let _fregCol     = null;
let _fregConn    = null;
let _scansCol    = null;

async function getDevicesCol() {
  if (_devicesCol) return _devicesCol;
  if (mongoose.connection.readyState === 1) {
    _devicesCol = mongoose.connection.db.collection('devices');
    return _devicesCol;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _devicesCol = conn.db.collection('devices');
  return _devicesCol;
}

async function getScansCol() {
  if (_scansCol) return _scansCol;
  if (mongoose.connection.readyState === 1) {
    _scansCol = mongoose.connection.db.collection('discovery_scans');
    return _scansCol;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _scansCol = conn.db.collection('discovery_scans');
  return _scansCol;
}

async function getFingerprintCol() {
  if (_fregCol) return _fregCol;
  if (!_fregConn) {
    _fregConn = await mongoose.createConnection(PRODUCTDEF_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  }
  _fregCol = _fregConn.db.collection('fingerprint_registry_entries');
  return _fregCol;
}

// ── SNMP Credential storage ───────────────────────────────────────────────────
// Credentials are stored in the main MongoDB (ubrnms DB) as `snmp_credentials`.
// Sensitive fields (community, authKey, privKey) are stored encrypted in production;
// in dev/stub mode they are stored as-is (plaintext) for simplicity.
let _credCol = null;
async function getCredentialCol() {
  if (_credCol) return _credCol;
  if (mongoose.connection.readyState === 1) {
    _credCol = mongoose.connection.db.collection('snmp_credentials');
    return _credCol;
  }
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  _credCol = conn.db.collection('snmp_credentials');
  return _credCol;
}

// ── GET /credentials — list all SNMP credentials (redacted) ──────────────────
router.get('/credentials', async (req, res) => {
  try {
    const col  = await getCredentialCol();
    const docs = await col.find({}).sort({ createdAt: -1 }).toArray();
    return res.json(docs.map((d) => ({
      id:             String(d._id),
      name:           d.name || 'Unnamed',
      version:        d.version || 'SNMP_V2C',
      communityMasked: d.community ? d.community.slice(0, 2) + '****' : undefined,
      createdAt:      d.createdAt,
    })));
  } catch (e) {
    console.error('[discovery-stub] credential list failed:', e.message);
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── POST /credentials — create a new SNMP credential ─────────────────────────
router.post('/credentials', async (req, res) => {
  const { name, version = 'SNMP_V2C', community, authKey, privKey, authProtocol, privProtocol } = req.body || {};
  if (!name) return res.status(400).json({ code: 'BAD_REQUEST', message: 'name is required' });
  if ((version === 'SNMP_V1' || version === 'SNMP_V2C') && !community) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'community is required for SNMPv1/v2c' });
  }
  try {
    const col = await getCredentialCol();
    const doc = {
      name, version, community: community || null,
      authKey: authKey || null, privKey: privKey || null,
      authProtocol: authProtocol || null, privProtocol: privProtocol || null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const result = await col.insertOne(doc);
    console.log(`[discovery-stub] Credential created: ${name} (${version})`);
    return res.status(201).json({
      id: String(result.insertedId),
      name, version,
      communityMasked: community ? community.slice(0, 2) + '****' : undefined,
      createdAt: doc.createdAt,
    });
  } catch (e) {
    console.error('[discovery-stub] credential create failed:', e.message);
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── DELETE /credentials/:id — remove a credential ────────────────────────────
router.delete('/credentials/:id', async (req, res) => {
  try {
    const { ObjectId } = mongoose.mongo;
    const col = await getCredentialCol();
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ code: 'DB_ERROR', message: e.message });
  }
});

// ── Demo device templates keyed by fingerprint pattern ────────────────────────

/**
 * Given the list of active BANNER fingerprint entries, build a set of simulated
 * host discoveries that will match those patterns.
 * This is what the "discovery agent" would find if it ran SSH/HTTP probes on
 * a real EOC640 network segment.
 */
function buildDemoHosts(bannerEntries, subnet = '10.100.1') {
  const hosts = [];
  const seen  = new Set();

  for (const entry of bannerEntries) {
    const pattern = entry.fingerprintValue || '';
    const pd      = entry.productDefinitionId || 'eoc-eoc640';
    const vendor  = entry.vendor  || 'EOC';
    const model   = entry.model   || 'EOC640';

    // Build a representative sysDescr string that matches the stored regex
    let sysDescr = `${model} Wireless Unit v2.1.3`;
    if (/Configurations_GUI/i.test(pattern)) {
      sysDescr = `Configurations_GUI v2.1.3 (${model})`;
    } else if (/EOC[-_]/i.test(pattern)) {
      sysDescr = `EOC-640 Wireless v2.1.3`;
    }

    // Skip duplicates within same run (BTS + CPE may share definition)
    if (!seen.has(pd + ':BTS')) {
      seen.add(pd + ':BTS');
      hosts.push({
        ip:           `${subnet}.50`,
        serialNumber: `${model}-BTS-DEMO-001`,
        deviceType:   'RADIO',
        sysDescr,
        sysName:      `${model}-BTS-DEMO-001`,
        sysLocation:  'Demo Site A – Roof',
        vendor,
        model,
        latitude:   37.7749,
        longitude: -122.4194,
        firmwareVersion: '2.1.3',
        manufacturer:    vendor,
        // tags will be added by provisionOne
      });
    }
    if (!seen.has(pd + ':CPE')) {
      seen.add(pd + ':CPE');
      hosts.push({
        ip:           `${subnet}.51`,
        serialNumber: `${model}-CPE-DEMO-001`,
        deviceType:   'RADIO',
        sysDescr,
        sysName:      `${model}-CPE-DEMO-001`,
        sysLocation:  'Demo Site A – Pole',
        vendor,
        model,
        latitude:   37.7750,
        longitude: -122.4190,
        firmwareVersion: '2.1.3',
        manufacturer:    vendor,
      });
    }
  }

  // Always include at least 2 demo devices even if no fingerprints are defined yet
  if (hosts.length === 0) {
    hosts.push(
      {
        ip: `${subnet}.50`, serialNumber: 'EOC640-BTS-DEMO-001',
        deviceType: 'RADIO', sysDescr: 'Configurations_GUI v2.1.3 (EOC640)',
        sysName: 'EOC640-BTS-DEMO-001', vendor: 'EOC', model: 'EOC640',
        latitude: 37.7749, longitude: -122.4194, firmwareVersion: '2.1.3', manufacturer: 'EOC',
      },
      {
        ip: `${subnet}.51`, serialNumber: 'EOC640-CPE-DEMO-001',
        deviceType: 'RADIO', sysDescr: 'Configurations_GUI v2.1.3 (EOC640)',
        sysName: 'EOC640-CPE-DEMO-001', vendor: 'EOC', model: 'EOC640',
        latitude: 37.7750, longitude: -122.4190, firmwareVersion: '2.1.3', manufacturer: 'EOC',
      }
    );
  }
  return hosts;
}

// ── Reusable: provision hosts directly into MongoDB ────────────────────────────

async function provisionHostsDirect(hosts, scansCol, scanId) {
  const devicesCol = await getDevicesCol();
  const fregCol    = await getFingerprintCol();

  // Load BANNER fingerprints once
  let banners = [];
  try {
    banners = await fregCol.find({ fingerprintType: 'BANNER' }).toArray();
  } catch { /* registry may be empty */ }

  const results = [];
  const now     = new Date();

  for (const host of hosts) {
    const { ip, serialNumber, deviceType, sysDescr, sysName, sysLocation, vendor, model,
            latitude, longitude, firmwareVersion, manufacturer } = host;

    // Banner fingerprint resolution
    let resolvedVendor = vendor || 'EOC';
    let resolvedModel  = model  || 'EOC640';
    let productDefinitionId = null;

    for (const entry of banners) {
      try {
        if (new RegExp(entry.fingerprintValue, 'i').test(sysDescr || '')) {
          resolvedVendor       = entry.vendor || resolvedVendor;
          resolvedModel        = entry.model  || resolvedModel;
          productDefinitionId  = entry.productDefinitionId;
          break;
        }
      } catch { /* bad regex */ }
    }

    const deviceName = sysName || `${resolvedModel}-${ip.replace(/\./g, '-')}`;
    const doc = {
      _id:              serialNumber,
      id:               serialNumber,
      deviceId:         serialNumber,
      serialNumber,
      name:             deviceName,
      deviceName,
      deviceType:       deviceType || 'RADIO',
      model:            resolvedModel,
      productDefinitionId,
      status:           'ONLINE',
      ipAddress:        ip,
      latitude:         latitude  != null ? parseFloat(latitude)  : null,
      longitude:        longitude != null ? parseFloat(longitude) : null,
      manufacturer:     resolvedVendor,
      sysName:          sysName      || null,
      sysLocation:      sysLocation  || null,
      sysDescr:         sysDescr     || null,
      firmwareVersion:  firmwareVersion || '2.1.3',
      discoveryParadigm: productDefinitionId ? 'BANNER' : 'MANUAL',
      tags:             ['banner-discovered', 'auto-scan', 'eoc640'],
      uptimeSeconds:    Math.floor(Math.random() * 86400),
      createdAt:        now,
      updatedAt:        now,
    };

    try {
      await devicesCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
      console.log(`[discovery-stub] Provisioned ${serialNumber} (${doc.deviceType}) @ ${ip} → ${productDefinitionId || 'no-def'}`);
      results.push({ ip, serialNumber, status: 'provisioned', productDefinitionId });
    } catch (err) {
      console.error(`[discovery-stub] Failed to provision ${serialNumber}:`, err.message);
      results.push({ ip, serialNumber, status: 'failed', error: err.message });
    }
  }

  // Bust topology cache
  try { require('./topology.stub').bustTopologyCache(); } catch { /* ignore */ }

  return results;
}

// ── Route handlers ─────────────────────────────────────────────────────────────

// In-memory store for synthetic (ICMP-bypass) discovery runs so GET /runs/:runId
// and GET /runs/:runId/results can return results without going to the Java service.
const syntheticRuns = new Map();   // runId → { status, scope, createdAt, devices }

/**
 * POST /api/v1/discovery/runs
 *
 * Intercepts discovery run creation ONLY when the request includes icmpBypass:true
 * (or when all scope entries are explicit hostnames/host:port that the Java ICMP sweep
 * cannot reach).  All other requests fall through (next()) to the Java nms-discovery service.
 *
 * ICMP-bypass mode:
 *   - Uses the same SNMP-GET logic as /snmp-probe (no ping required)
 *   - Returns a synthetic run in the same shape as the Java service (status=COMPLETED)
 *   - GET /runs/:runId and GET /runs/:runId/results are also intercepted for synthetic runs
 *
 * This allows "Start New Discovery" to work for Docker containers, simulators,
 * and any host:port target where ICMP is blocked.
 */
router.post('/runs', async (req, res, next) => {
  const body = req.body || {};
  const {
    scope             = [],
    icmpBypass        = false,
    community:        bodyCommunity = 'public',
    credentialId,
    protocol          = 'SNMP_V2C',
    timeoutSeconds    = 5,
    productDefinitionId: callerDefinitionId = null,
  } = body;

  // ── Resolve community string from credentialId if provided ────────────────
  // credentialId takes priority; fall back to direct community string input.
  let community = bodyCommunity;
  if (credentialId) {
    try {
      const credCol = await getCredentialCol();
      const { ObjectId } = require('mongoose').mongo;
      const cred = await credCol.findOne({ _id: new ObjectId(credentialId) });
      if (cred && cred.community) {
        community = cred.community;
        console.log(`[discovery-stub] Resolved credentialId ${credentialId} → community=[masked]`);
      }
    } catch (credErr) {
      console.warn('[discovery-stub] credentialId lookup failed:', credErr.message, '— using body community');
    }
  }

  // ── Scope field normaliser ────────────────────────────────────────────────
  // The frontend sends { type:'IP'|'CIDR'|'SEED', value:'...' } (parseScopeInput).
  // Older gateway/Java code uses { type:'SINGLE_IP'|'HOSTNAME'|'CIDR', ip/cidr/hostname:'...' }.
  // Normalise both shapes into a consistent { type, ip, cidr, hostname } representation.
  const normalisedScope = Array.isArray(scope) ? scope.map((e) => {
    if (typeof e === 'string') return { type: 'SINGLE_IP', ip: e };
    const val = e.value || e.ip || e.hostname || e.cidr || '';
    const t = e.type || '';
    if (t === 'IP'   || t === 'SINGLE_IP') return { ...e, type: 'SINGLE_IP', ip:  val };
    if (t === 'SEED' || t === 'HOSTNAME')  return { ...e, type: 'HOSTNAME',  hostname: val };
    if (t === 'CIDR')                      return { ...e, type: 'CIDR',      cidr: val };
    // Unknown type — guess by format
    if (val.includes('/')) return { ...e, type: 'CIDR', cidr: val };
    return { ...e, type: 'SINGLE_IP', ip: val };
  }) : [];

  // Detect hostname-style scope entries (host.docker.internal, explicit :port, or non-CIDR hostnames)
  const hasHostname = normalisedScope.some((e) =>
    (e.type === 'HOSTNAME') ||
    (e.type === 'SINGLE_IP' && (e.ip || '').includes(':'))
  );

  // Auto-bypass for any scope entry that targets the snmp-test-net (10.10.10.x).
  // Those containers run SNMP on non-standard ports and Java discovery can't reach
  // them via ICMP anyway — route directly through the gateway SNMP-bypass path.
  const isTestNetScope = normalisedScope.some((e) => {
    const ip = e.ip || e.hostname || '';
    return /^10\.10\.10\.\d+$/.test(ip) || (e.type === 'CIDR' && (e.cidr || '').startsWith('10.10.10.'));
  });

  // Single-IP targets (real devices) are also routed through the gateway bypass path.
  // This ensures:
  //   - Custom community strings (credentialId or direct) are honoured
  //   - SNMP probe works even when ICMP is blocked by the device's firewall
  //   - Java discovery service (which ignores the community param) is NOT used for single IPs
  // Only pure CIDR subnet scans are forwarded to the Java service.
  const isSingleIpOnly = normalisedScope.length > 0 &&
    normalisedScope.every(e => e.type === 'SINGLE_IP' && !(e.ip || '').includes(':'));

  // isRealIpTarget: single IP that is not a Docker simulator (real device with SNMP)
  const isRealIpTarget = isSingleIpOnly && !isTestNetScope;

  if (!icmpBypass && !hasHostname && !isTestNetScope && !isSingleIpOnly) {
    // Only CIDR subnet scans go to the Java nms-discovery service
    return next();
  }

  // ── Gateway SNMP probe: run SNMP-only discovery (with optional ICMP for real IPs) ──
  const runId   = `bypass-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startAt = new Date().toISOString();
  console.log(`[discovery-stub] SNMP-probe run ${runId} — scope=${JSON.stringify(scope)} community=[${community === 'public' ? 'public' : 'custom'}] realIp=${isRealIpTarget}`);

  // Flatten normalised scope to host:port strings
  const targets = [];

  /** Expand a CIDR (e.g. "10.10.10.0/24") → array of usable host IPs */
  function expandCidr(cidr) {
    const [base, maskStr] = (cidr || '').split('/');
    const mask = parseInt(maskStr, 10);
    if (!base || isNaN(mask) || mask < 16 || mask > 30) return base ? [base] : [];
    const parts = base.split('.').map(Number);
    const baseInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
    const size = 1 << (32 - mask);
    const ips = [];
    for (let i = 1; i < size - 1; i++) { // skip network (0) and broadcast (last)
      const n = (baseInt & ~(size - 1)) + i;
      ips.push(`${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`);
    }
    return ips;
  }

  for (const entry of normalisedScope) {
    if (entry.type === 'HOSTNAME') {
      const hostname = entry.hostname || '';
      if (hostname.includes(':')) {
        // Already has an explicit port — use as-is (e.g. host.docker.internal:1162)
        targets.push(hostname);
      } else if (MULTI_PORT_HOST_MAP[hostname]) {
        // Known multi-port host (e.g. host.docker.internal) — expand to all simulator ports
        // so "SNMP Network Discovery" finds all devices, same as Quick SNMP Discovery
        MULTI_PORT_HOST_MAP[hostname].forEach(p => targets.push(`${hostname}:${p}`));
      } else {
        targets.push(hostname);
      }
    } else if (entry.type === 'SINGLE_IP') {
      targets.push(entry.ip);
    } else if (entry.type === 'CIDR') {
      // Expand CIDR to individual IPs (guard: limit to /16–/30 to avoid huge ranges)
      expandCidr(entry.cidr || '').forEach(ip => targets.push(ip));
    }
  }

  const snmpProtoVersion = (protocol || '').includes('V1') ? 'v1' : 'v2c';

  // Pre-load caller definition metadata + ALL its fingerprint entries for device filtering
  let callerDefMeta = null;
  let callerFingerprintEntries = []; // used to FILTER results to only matching devices
  if (callerDefinitionId) {
    callerDefMeta = { productDefinitionId: callerDefinitionId };
    // Fetch from PD service (authoritative) with MongoDB fallback
    callerFingerprintEntries = await fetchCallerFingerprints(callerDefinitionId);
    const sample = callerFingerprintEntries[0];
    if (sample) callerDefMeta = {
      productDefinitionId: callerDefinitionId,
      vendor:           sample.vendor || null,
      model:            sample.model  || null,
      // deviceType and GPS come from the uploaded definition — flow through from registry
      deviceType:       sample.deviceType       || null,
      defaultLatitude:  sample.defaultLatitude  != null ? parseFloat(sample.defaultLatitude)  : null,
      defaultLongitude: sample.defaultLongitude != null ? parseFloat(sample.defaultLongitude) : null,
    };
    if (callerFingerprintEntries.length === 0) {
      console.warn(`[discovery-stub] ⚠️  No fingerprints found for template '${callerDefinitionId}' — filter will pass all devices`);
    }
  }

  // Load BANNER fingerprints for auto-classification (used when no template is selected)
  let banners = [];
  try {
    const fregCol = await getFingerprintCol();
    banners = await fregCol.find({ fingerprintType: 'BANNER' }).toArray();
  } catch { /* empty registry is OK */ }

  const hosts   = [];
  const errors  = [];
  const skipped = []; // devices that responded but didn't match the selected template

  await Promise.all(targets.map(async (target) => {
    const [host, rawPort] = target.includes(':') ? [target.split(':')[0], parseInt(target.split(':')[1], 10)] : [target, NaN];
    const port = isNaN(rawPort) ? (TEST_SNMP_PORT_MAP[host] || 161) : rawPort;
    try {
      const mib = await snmpGet(host, port, community, (timeoutSeconds || 5) * 1000, snmpProtoVersion);
      // ── Template filter ────────────────────────────────────────────────────
      // When a product definition template is selected, only include devices whose
      // OID or sysDescr matches the template's activated fingerprints.
      // Devices that respond to SNMP but don't match are excluded from results
      // (counted in `skipped`) so the operator sees only relevant devices.
      if (callerFingerprintEntries.length > 0 && !matchesTemplateFingerprints(mib, callerFingerprintEntries)) {
        console.log(`[discovery-stub] ⛔ ${host}:${port} (OID: ${mib.sysObjectID}) excluded — no fingerprint match for template '${callerDefinitionId}'`);
        skipped.push({ target: `${host}:${port}`, oid: mib.sysObjectID, sysDescr: (mib.sysDescr || '').substring(0, 80) });
        return; // don't provision, don't add to hosts
      }

      const oidClass = await classifyByOid(mib.sysObjectID);
      let vendor  = oidClass.vendor  || 'Unknown';
      let model   = oidClass.model   || 'SNMP Device';
      let generic = oidClass.genericDeviceType || 'SWITCH';
      let defId   = oidClass.productDefinitionId || null;
      // GPS from the Product Definition uploaded by the operator
      let pdLat   = oidClass.defaultLatitude  ?? null;
      let pdLon   = oidClass.defaultLongitude ?? null;

      for (const b of banners) {
        try {
          if (new RegExp(b.fingerprintValue, 'i').test(mib.sysDescr || '')) {
            vendor  = b.vendor || vendor;
            model   = b.model  || model;
            defId   = b.productDefinitionId;
            generic = b.genericDeviceType || b.deviceType || 'RADIO';
            if (b.defaultLatitude  != null) pdLat = parseFloat(b.defaultLatitude);
            if (b.defaultLongitude != null) pdLon = parseFloat(b.defaultLongitude);
            break;
          }
        } catch { /* bad regex */ }
      }

      // Apply caller-selected template for matching devices
      if (callerDefMeta) {
        defId   = callerDefMeta.productDefinitionId;
        if (callerDefMeta.vendor)           vendor = callerDefMeta.vendor;
        if (callerDefMeta.model)            model  = callerDefMeta.model;
        if (callerDefMeta.deviceType)       generic = callerDefMeta.deviceType;
        if (callerDefMeta.defaultLatitude  != null) pdLat = callerDefMeta.defaultLatitude;
        if (callerDefMeta.defaultLongitude != null) pdLon = callerDefMeta.defaultLongitude;
      }

      const serial = mib.sysName
        ? mib.sysName.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 64)
        : `snmp-${host.replace(/\./g, '-')}-${port}`;

      // Provision to inventory — direct MongoDB upsert (same pattern as snmp-probe route)
      // NOTE: ipAddress MUST use displayIp (host:port when port ≠ 161) so the inventory
      // cross-reference in the results view (inventoryDeviceMap.get(result.ip)) succeeds.
      // Using bare `host` here was the root cause of "Provision Device" reappearing on
      // already-provisioned devices after a new discovery run.
      const displayIp = port !== 161 ? `${host}:${port}` : host;
      try {
        const devicesCol = await getDevicesCol();
        const now = new Date();
        const doc = {
          _id:              serial,
          id:               serial,
          deviceId:         serial,
          serialNumber:     serial,
          name:             mib.sysName || serial,
          deviceName:       mib.sysName || serial,
          deviceType:       generic === 'RADIO' ? 'RADIO' : null,
          genericDeviceType: generic,
          model,
          manufacturer:     vendor,
          productDefinitionId: defId,
          status:           'ONLINE',
          ipAddress:        displayIp,
          snmpPort:         port,
          snmpCommunity:    community,
          // GPS — sourced from the Product Definition uploaded by the operator.
          // Falls back to null if no definition was selected or it had no location block.
          latitude:         pdLat,
          longitude:        pdLon,
          sysDescr:         mib.sysDescr,
          sysObjectID:      mib.sysObjectID,
          sysName:          mib.sysName,
          sysLocation:      mib.sysLocation,
          sysContact:       mib.sysContact,
          discoveryParadigm: defId ? 'BANNER' : 'SNMP',
          tags:             isRealIpTarget ? ['snmp-discovered', 'real-device'] : ['snmp-discovered', 'icmp-bypass'],
          createdAt:        now,
          updatedAt:        now,
        };
        await devicesCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
        console.log(`[discovery-stub] bypass provisioned ${serial} (${generic}) @ ${host}:${port} defId=${defId}`);
        try { require('./topology.stub').bustTopologyCache(); } catch { /* ignore */ }
      } catch (provErr) {
        console.warn(`[discovery-stub] bypass provision failed for ${serial}: ${provErr.message}`);
      }

      // displayIp is already computed above (before provisioning) — reuse it here.
      // serialNumber MUST be included so inventoryDeviceMap.get(result.serialNumber)
      // succeeds in the frontend cross-reference, even when the ipAddress lookup misses.
      hosts.push({
        ip:               displayIp,
        serialNumber:     serial,       // ← was missing; causes "Provision Device" to re-appear
        port,
        icmpStatus:       isRealIpTarget ? 'not_attempted' : 'bypassed',
        snmpStatus:       'success',
        sysName:          mib.sysName,
        sysDescr:         mib.sysDescr,
        sysObjectID:      mib.sysObjectID,
        sysLocation:      mib.sysLocation,
        sysContact:       mib.sysContact,
        vendor, model,
        genericDeviceType: generic,
        productDefinitionId: defId,
        macAddress:       null,
        discoveryMethod:  'ICMP_BYPASS',
        // GPS sourced from the Product Definition's location block (uploaded config file).
        // Passed to the provisioning modal so operators see pre-filled coordinates
        // from their network planning document rather than having to enter manually.
        defaultLatitude:  pdLat,
        defaultLongitude: pdLon,
      });
      console.log(`[discovery-stub] bypass ✅ ${host}:${port} vendor=${vendor} defId=${defId}`);
    } catch (err) {
      console.warn(`[discovery-stub] bypass ❌ ${host}:${port} → ${err.message}`);
      errors.push({ target, error: err.message });
      const displayIpFail = port !== 161 ? `${host}:${port}` : host;
      hosts.push({
        ip: displayIpFail, port, icmpStatus: isRealIpTarget ? 'not_attempted' : 'bypassed', snmpStatus: 'failed',
        sysName: null, sysDescr: null, sysObjectID: null,
        sysLocation: null, sysContact: null, vendor: null, model: null,
        genericDeviceType: null, productDefinitionId: null, macAddress: null,
        discoveryMethod: 'ICMP_BYPASS',
      });
    }
  }));

  const skipMsg = skipped.length > 0
    ? ` — ${skipped.length} device(s) excluded (OID/banner did not match template '${callerDefinitionId}')`
    : '';
  const run = {
    runId,
    status:          'COMPLETED',
    scope:           scope,
    normalizedScope: scope,
    createdBy:       req.user?.sub || 'admin',
    createdAt:       startAt,
    completedAt:     new Date().toISOString(),
    validationSummary: `ICMP-bypass scan of ${targets.length} target(s)${skipMsg}`,
    icmpBypass:      true,
    hosts,
    errors,
    skipped,          // devices that responded but didn't match the selected template
  };
  if (skipped.length > 0) {
    console.log(`[discovery-stub] Template filter '${callerDefinitionId}': ${hosts.length} matched, ${skipped.length} excluded`);
  }
  syntheticRuns.set(runId, run);

  // Return in the same shape as Java createDiscoveryRun (status COMPLETED immediately)
  res.status(201).json({
    runId,
    status:          'COMPLETED',
    normalizedScope: scope,
    createdBy:       run.createdBy,
    createdAt:       startAt,
    validationSummary: run.validationSummary,
  });
});

/**
 * GET /api/v1/discovery/runs/:runId
 * Serves synthetic (ICMP-bypass) run status; falls through for Java-managed runs.
 */
router.get('/runs/:runId', (req, res, next) => {
  const run = syntheticRuns.get(req.params.runId);
  if (!run) return next();
  res.json({
    runId:           run.runId,
    status:          run.status,
    normalizedScope: run.normalizedScope,
    createdBy:       run.createdBy,
    createdAt:       run.createdAt,
    completedAt:     run.completedAt,
    validationSummary: run.validationSummary,
    icmpBypass:      true,
    hostCount:       run.hosts.length,
  });
});

/**
 * GET /api/v1/discovery/runs/:runId/results
 * Returns host results for synthetic ICMP-bypass runs; falls through for Java runs.
 */
router.get('/runs/:runId/results', (req, res, next) => {
  const run = syntheticRuns.get(req.params.runId);
  if (!run) return next();
  res.json(run.hosts);
});

/**
 * POST /api/v1/discovery/runs/:runId/provision
 * For ICMP-bypass runs, devices are already provisioned to MongoDB during discovery.
 * This handler returns a success response so the frontend Provision button works.
 * Falls through to Java for real runs.
 */
router.post('/runs/:runId/provision', (req, res, next) => {
  const run = syntheticRuns.get(req.params.runId);
  if (!run) return next();
  // Devices were auto-provisioned into MongoDB during the bypass discovery run.
  const hosts = req.body?.hosts || run.hosts.map((h) => ({ ip: h.ip }));
  console.log(`[discovery-stub] provision request for bypass run ${req.params.runId} — ${hosts.length} host(s) already in DB`);
  res.json({
    provisioned: hosts.length,
    failed:      0,
    results:     hosts.map((h) => ({
      ip:     h.ip || h,
      status: 'provisioned',
    })),
  });
});

/**
 * POST /api/v1/discovery/scans
 * Body: { subnets?: string[], definitionId?: string }
 * Triggers a simulated auto-discovery scan, provisions matching devices,
 * and returns the scan record with results.
 */
router.post('/scans', async (req, res) => {
  const { subnets = ['10.100.1.0/24'], definitionId } = req.body || {};
  const scanId  = `scan-${Date.now()}`;
  const startAt = new Date();

  console.log(`[discovery-stub] Starting scan ${scanId} subnets=${JSON.stringify(subnets)}`);

  try {
    // 1. Load BANNER fingerprints
    let bannerEntries = [];
    try {
      const fregCol = await getFingerprintCol();
      const query   = definitionId
        ? { fingerprintType: 'BANNER', productDefinitionId: definitionId }
        : { fingerprintType: 'BANNER' };
      bannerEntries = await fregCol.find(query).toArray();
      console.log(`[discovery-stub] Loaded ${bannerEntries.length} BANNER fingerprint entries`);
    } catch (err) {
      console.warn('[discovery-stub] Fingerprint registry unavailable:', err.message);
    }

    // 2. Build simulated discovered hosts
    const subnet    = (subnets[0] || '10.100.1.0/24').replace(/\.0\/\d+$/, '').replace(/\/\d+$/, '');
    const demoHosts = buildDemoHosts(bannerEntries, subnet);

    // 3. Provision them
    const results      = await provisionHostsDirect(demoHosts, null, scanId);
    const provisioned  = results.filter((r) => r.status === 'provisioned').length;
    const failed       = results.filter((r) => r.status === 'failed').length;
    const endAt        = new Date();
    const durationMs   = endAt - startAt;

    // 4. Store scan record
    const scanRecord = {
      _id:         scanId,
      id:          scanId,
      status:      failed > 0 && provisioned === 0 ? 'FAILED' : 'COMPLETED',
      subnets,
      definitionId: definitionId || null,
      hostsScanned:  demoHosts.length,
      hostsMatched:  provisioned,
      hostsFailed:   failed,
      results,
      startedAt:   startAt,
      completedAt: endAt,
      durationMs,
      triggeredBy: req.user?.username || 'admin',
    };
    try {
      const scansCol = await getScansCol();
      await scansCol.replaceOne({ _id: scanId }, scanRecord, { upsert: true });
    } catch { /* scan persistence failure is non-fatal */ }

    const httpStatus = failed > 0 && provisioned === 0 ? 422 : provisioned > 0 ? 201 : 200;
    return res.status(httpStatus).json({
      message: `Scan complete — ${provisioned} device(s) provisioned, ${failed} failed`,
      scan: scanRecord,
    });

  } catch (err) {
    console.error('[discovery-stub] Scan failed:', err.message);
    return res.status(500).json({ code: 'SCAN_ERROR', message: err.message });
  }
});

/**
 * GET /api/v1/discovery/scans
 * Returns list of past scans (most recent first, max 50).
 */
router.get('/scans', async (req, res) => {
  try {
    const col  = await getScansCol();
    const docs = await col.find({}).sort({ startedAt: -1 }).limit(50).toArray();
    return res.json(docs);
  } catch (err) {
    return res.json([]); // graceful: return empty list if DB unavailable
  }
});

/**
 * GET /api/v1/discovery/scans/:scanId
 */
router.get('/scans/:scanId', async (req, res) => {
  try {
    const col = await getScansCol();
    const doc = await col.findOne({ _id: req.params.scanId });
    if (!doc) return res.status(404).json({ code: 'NOT_FOUND', message: 'Scan not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ code: 'DB_ERROR', message: err.message });
  }
});

/**
 * POST /api/v1/discovery/snmp-probe
 *
 * Real SNMP v2c probe against one or more targets (iReasoning, nms-snmpsim, etc.)
 *
 * Body:
 *   {
 *     targets:   ["172.30.0.15:1161", "192.168.65.254:161"],  // host:port pairs
 *     community: "public",    // SNMP community string (default: "public")
 *     provision: true         // if true, write discovered devices to MongoDB (default: true)
 *   }
 *
 * Returns:
 *   {
 *     probed: number,
 *     discovered: number,
 *     devices: [{ ip, port, sysName, sysDescr, vendor, model, deviceType, status, productDefinitionId }]
 *   }
 *
 * Quick test from terminal:
 *   curl -s -X POST http://localhost:3100/api/v1/discovery/snmp-probe \
 *     -H 'Content-Type: application/json' \
 *     -H 'Authorization: Bearer <token>' \
 *     -d '{"targets":["172.30.0.15:1161"],"community":"public"}'
 */
router.post('/snmp-probe', async (req, res) => {
  const {
    targets      = ['172.30.0.15:1161'],
    community    = 'public',
    provision    = true,
    // snmpVersion mirrors the UI dropdown: 'SNMP_V1' | 'SNMP_V2C' (default v2c)
    snmpVersion  = 'SNMP_V2C',
    // productDefinitionId: caller-supplied definition (from Device Template picker).
    // When set, ALL responding devices are tagged with this definition — vendor/device independent.
    // OID classification and banner matching are still attempted but this acts as the override/fallback.
    productDefinitionId: callerDefinitionId = null,
  } = req.body || {};

  // Normalise to the internal 'v1' | 'v2c' format used by snmpGet()
  const snmpProtoVersion = snmpVersion === 'SNMP_V1' ? 'v1' : 'v2c';

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'targets array required' });
  }

  // Expand known multi-port hosts entered without a port (e.g. "host.docker.internal").
  // This prevents a SNMP timeout when the user types the hostname without specifying
  // which simulator port (1161/1162/1163) to hit — instead we probe all known ports.
  const expandedTargets = [];
  for (const t of targets) {
    if (!t.includes(':') && MULTI_PORT_HOST_MAP[t]) {
      MULTI_PORT_HOST_MAP[t].forEach((p) => expandedTargets.push(`${t}:${p}`));
    } else {
      expandedTargets.push(t);
    }
  }

  if (expandedTargets.length > 20) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'max 20 targets per probe' });
  }

  console.log(`[snmp-probe] Probing ${expandedTargets.length} target(s): ${expandedTargets.join(', ')}`);

  // ── Pre-load caller-specified definition: metadata + ALL fingerprints for device filtering ──
  // When a template is selected, only devices whose OID/sysDescr matches its fingerprints
  // are included in results. Non-matching devices are excluded (counted in `skipped`).
  let callerDefMeta = null;
  let callerFingerprintEntries = []; // all fingerprints for the selected template
  if (callerDefinitionId) {
    // Fetch from PD service (authoritative) with MongoDB fallback
    callerFingerprintEntries = await fetchCallerFingerprints(callerDefinitionId);
    const sample = callerFingerprintEntries[0];
    callerDefMeta = sample
      ? { productDefinitionId: callerDefinitionId, vendor: sample.vendor, model: sample.model }
      : { productDefinitionId: callerDefinitionId };
    if (callerFingerprintEntries.length === 0) {
      console.warn(`[snmp-probe] ⚠️  No fingerprints found for template '${callerDefinitionId}' — filter will pass all devices`);
    } else {
      console.log(`[snmp-probe] Template '${callerDefinitionId}': ${callerFingerprintEntries.length} fingerprint(s) loaded → ${JSON.stringify(callerDefMeta)}`);
    }
  }

  // Load ALL BANNER fingerprints for auto-classification (used when no template is selected)
  let banners = [];
  try {
    const fregCol = await getFingerprintCol();
    banners = await fregCol.find({ fingerprintType: 'BANNER' }).toArray();
  } catch { /* registry empty is OK */ }

  const discoveredHosts = [];
  const errors          = [];
  const skipped         = []; // responded to SNMP but didn't match the selected template

  // Probe all targets in parallel (using expandedTargets so multi-port hosts like
  // "host.docker.internal" are resolved to individual host:port pairs first)
  await Promise.all(expandedTargets.map(async (target) => {
    const [host, rawPort] = target.includes(':') ? [target.split(':')[0], parseInt(target.split(':')[1], 10)] : [target, NaN];
    const port = isNaN(rawPort) ? (TEST_SNMP_PORT_MAP[host] || 161) : rawPort;
    try {
      const mib = await snmpGet(host, port, community, 5000, snmpProtoVersion);
      console.log(`[snmp-probe] ✅ ${host}:${port} → sysName=${mib.sysName} sysDescr=${(mib.sysDescr||'').substring(0,50)}`);

      // ── Template filter ────────────────────────────────────────────────────
      // When a product definition template is selected, only return devices whose
      // OID or sysDescr actually matches the template's fingerprints.
      // This ensures selecting "Acme Networks X9000" only returns Acme devices,
      // not every device that happens to respond to SNMP on the given scope.
      if (callerFingerprintEntries.length > 0 && !matchesTemplateFingerprints(mib, callerFingerprintEntries)) {
        console.log(`[snmp-probe] ⛔ ${host}:${port} (OID: ${mib.sysObjectID}) excluded — no fingerprint match for template '${callerDefinitionId}'`);
        skipped.push({ target: `${host}:${port}`, oid: mib.sysObjectID, sysDescr: (mib.sysDescr || '').substring(0, 80) });
        return; // exclude from results
      }

      // Classification priority (highest → lowest):
      //   1. Caller-supplied productDefinitionId (vendor-independent — user chose the definition)
      //   2. BANNER fingerprint match from the activated fingerprint registry
      //   3. OID enterprise prefix — registry-driven first, then hardcoded fallback (classifyByOid)
      const oidClass = await classifyByOid(mib.sysObjectID);
      let resolvedVendor  = oidClass.vendor  || 'Unknown';
      let resolvedModel   = oidClass.model   || 'SNMP Device';
      let resolvedGeneric = oidClass.genericDeviceType || 'SWITCH';
      // Start with OID-based productDefinitionId
      let productDefinitionId = oidClass.productDefinitionId || null;

      // Level 2: BANNER fingerprint match
      for (const entry of banners) {
        try {
          if (new RegExp(entry.fingerprintValue, 'i').test(mib.sysDescr || '')) {
            resolvedVendor       = entry.vendor || resolvedVendor;
            resolvedModel        = entry.model  || resolvedModel;
            productDefinitionId  = entry.productDefinitionId;
            resolvedGeneric      = entry.genericDeviceType || 'RADIO';
            break;
          }
        } catch { /* bad regex */ }
      }

      // Level 1 (highest priority): caller-specified definition overrides everything
      if (callerDefMeta) {
        productDefinitionId = callerDefMeta.productDefinitionId;
        if (callerDefMeta.vendor) resolvedVendor = callerDefMeta.vendor;
        if (callerDefMeta.model)  resolvedModel  = callerDefMeta.model;
      }

      const serialNumber = mib.sysName
        ? mib.sysName.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 64)
        : `snmp-${host.replace(/\./g, '-')}-${port}`;

      discoveredHosts.push({
        ip:                 host,
        port,
        serialNumber,
        sysDescr:           mib.sysDescr,
        sysObjectID:        mib.sysObjectID,
        sysName:            mib.sysName,
        sysLocation:        mib.sysLocation,
        sysContact:         mib.sysContact,
        vendor:             resolvedVendor,
        model:              resolvedModel,
        genericDeviceType:  resolvedGeneric,
        deviceType:         resolvedGeneric === 'RADIO' ? 'RADIO' : null,
        productDefinitionId,
        discoveryMethod:    callerDefinitionId ? 'DEFINITION_PROBE' : 'SNMP_V2C',
      });
    } catch (err) {
      console.warn(`[snmp-probe] ❌ ${host}:${port} → ${err.message}`);
      errors.push({ target, error: err.message });
    }
  }));

  // Optionally provision into MongoDB
  let provisionResults = [];
  if (provision && discoveredHosts.length > 0) {
    const devicesCol = await getDevicesCol();
    const now = new Date();
    for (const h of discoveredHosts) {
      const doc = {
        _id:              h.serialNumber,
        id:               h.serialNumber,
        deviceId:         h.serialNumber,
        serialNumber:     h.serialNumber,
        name:             h.sysName || h.serialNumber,
        deviceName:       h.sysName || h.serialNumber,
        deviceType:       h.deviceType,
        genericDeviceType: h.genericDeviceType,
        model:            h.model,
        manufacturer:     h.vendor,
        productDefinitionId: h.productDefinitionId,
        status:           'ONLINE',
        ipAddress:        h.ip,
        snmpPort:         h.port,
        snmpCommunity:    community,
        sysDescr:         h.sysDescr,
        sysObjectID:      h.sysObjectID,
        sysName:          h.sysName,
        sysLocation:      h.sysLocation,
        sysContact:       h.sysContact,
        discoveryParadigm: h.productDefinitionId ? 'BANNER' : 'SNMP',
        tags:             ['snmp-discovered', 'real-snmp-probe'],
        createdAt:        now,
        updatedAt:        now,
      };
      try {
        await devicesCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
        console.log(`[snmp-probe] Provisioned ${h.serialNumber} (${h.genericDeviceType}) @ ${h.ip}:${h.port}`);
        provisionResults.push({ serialNumber: h.serialNumber, status: 'provisioned' });
      } catch (err) {
        provisionResults.push({ serialNumber: h.serialNumber, status: 'failed', error: err.message });
      }
    }
    // Bust topology cache
    try { require('./topology.stub').bustTopologyCache(); } catch { /* ignore */ }
  }

  if (skipped.length > 0) {
    console.log(`[snmp-probe] Template filter '${callerDefinitionId}': ${discoveredHosts.length} matched, ${skipped.length} excluded`);
  }

  return res.status(discoveredHosts.length > 0 ? 200 : 207).json({
    probed:     expandedTargets.length,
    discovered: discoveredHosts.length,
    skipped:    skipped.length,    // devices that responded but didn't match the selected template
    errors:     errors.length,
    devices:    discoveredHosts.map((h) => ({
      ip:                 h.ip,
      port:               h.port,
      sysName:            h.sysName,
      sysDescr:           (h.sysDescr || '').substring(0, 120),
      sysObjectID:        h.sysObjectID,
      sysLocation:        h.sysLocation,
      vendor:             h.vendor,
      model:              h.model,
      genericDeviceType:  h.genericDeviceType,
      productDefinitionId: h.productDefinitionId,
      provisioned:        provision,
    })),
    errorDetails:  errors,
    skippedDetails: skipped,  // diagnostic: which devices were excluded and why
  });
});

module.exports = router;

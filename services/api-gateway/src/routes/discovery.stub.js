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
const mongoose   = require('mongoose');
const { createProvisionHandler } = require('./provision.stub');
const router     = express.Router();

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

/** Map sysObjectID enterprise OID prefix → vendor/model/deviceType */
function classifyByOid(sysObjectID) {
  if (!sysObjectID) return {};
  const oid = sysObjectID;
  if (oid.startsWith('1.3.6.1.4.1.9.'))    return { vendor: 'Cisco',    model: 'IOS Switch',  genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.2636.')) return { vendor: 'Juniper',  model: 'JunOS Device', genericDeviceType: 'ROUTER' };
  if (oid.startsWith('1.3.6.1.4.1.2272.')) return { vendor: 'Nortel',   model: 'ERS Switch',   genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.4526.')) return { vendor: 'Netgear',  model: 'Smart Switch',  genericDeviceType: 'SWITCH' };
  if (oid.startsWith('1.3.6.1.4.1.3764.')) return { vendor: 'EOC',      model: 'EOC640',        genericDeviceType: 'RADIO'  };
  if (oid.startsWith('1.3.6.1.4.1.41112.'))return { vendor: 'Ubiquiti', model: 'UniFi',         genericDeviceType: 'RADIO'  };
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
  } = req.body || {};

  // Normalise to the internal 'v1' | 'v2c' format used by snmpGet()
  const snmpProtoVersion = snmpVersion === 'SNMP_V1' ? 'v1' : 'v2c';

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'targets array required' });
  }
  if (targets.length > 20) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'max 20 targets per probe' });
  }

  console.log(`[snmp-probe] Probing ${targets.length} target(s): ${targets.join(', ')}`);

  // Load BANNER fingerprints once for classification
  let banners = [];
  try {
    const fregCol = await getFingerprintCol();
    banners = await fregCol.find({ fingerprintType: 'BANNER' }).toArray();
  } catch { /* registry empty is OK */ }

  const discoveredHosts = [];
  const errors          = [];

  // Probe all targets in parallel
  await Promise.all(targets.map(async (target) => {
    const [host, rawPort] = target.includes(':') ? [target.split(':')[0], parseInt(target.split(':')[1], 10)] : [target, 161];
    const port = isNaN(rawPort) ? 161 : rawPort;
    try {
      const mib = await snmpGet(host, port, community, 5000, snmpProtoVersion);
      console.log(`[snmp-probe] ✅ ${host}:${port} → sysName=${mib.sysName} sysDescr=${(mib.sysDescr||'').substring(0,50)}`);

      // Classify by OID first, then override with BANNER fingerprint match
      const oidClass = classifyByOid(mib.sysObjectID);
      let resolvedVendor  = oidClass.vendor  || 'Unknown';
      let resolvedModel   = oidClass.model   || 'SNMP Device';
      let resolvedGeneric = oidClass.genericDeviceType || 'SWITCH';
      let productDefinitionId = null;

      for (const entry of banners) {
        try {
          if (new RegExp(entry.fingerprintValue, 'i').test(mib.sysDescr || '')) {
            resolvedVendor       = entry.vendor || resolvedVendor;
            resolvedModel        = entry.model  || resolvedModel;
            productDefinitionId  = entry.productDefinitionId;
            resolvedGeneric      = 'RADIO'; // BANNER matches are always radio in this system
            break;
          }
        } catch { /* bad regex */ }
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
        discoveryMethod:    'SNMP_V2C',
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

  return res.status(discoveredHosts.length > 0 ? 200 : 207).json({
    probed:     targets.length,
    discovered: discoveredHosts.length,
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
    errorDetails: errors,
  });
});

module.exports = router;

'use strict';

/**
 * Device facts — inventory data collected from the device at discovery time.
 *
 * Unlike the Node View (which shows ONLY what the uploaded product definition declares),
 * the inventory record is filled with everything the device reports about itself that has a
 * well-defined meaning:
 *   • standard MIBs   — system group (uptime, contact), IF-MIB (interfaces, MAC addresses,
 *                       speed, status), IP-MIB (management address → management MAC)
 *   • vendor profiles — a short, curated list of vendor objects whose meaning has been
 *                       confirmed against the device itself (serial, firmware, hardware and
 *                       bootloader version, model name)
 *
 * Deliberately NOT collected: the vendor subtree as a whole. It contains values with no
 * documented meaning and secrets (SNMP communities, SNMPv3 keys, passwords).
 */

const { walkSubtree } = require('./snmpWalk');

const SYS  = '.1.3.6.1.2.1.1';
const IFT  = '.1.3.6.1.2.1.2.2.1';
const IFX  = '.1.3.6.1.2.1.31.1.1.1';
const IPA  = '.1.3.6.1.2.1.4.20.1';

/**
 * Vendor object profiles keyed by enterprise prefix. Every OID here was cross-checked against
 * the vendor's own web UI (see docs/definition-driven-live-node-view.md).
 * Placeholder values reported by the device ("-NA-", "") are ignored.
 */
const VENDOR_FACT_PROFILES = [
  {
    enterprise: '.1.3.6.1.4.1.52619', // EOC Networks (UBR series)
    facts: {
      serialNumber:     '.1.3.6.1.4.1.52619.1.2.3.1.0',
      firmwareVersion:  '.1.3.6.1.4.1.52619.1.2.2.4.0',
      hardwareVersion:  '.1.3.6.1.4.1.52619.1.2.3.9.0',
      bootloaderVersion:'.1.3.6.1.4.1.52619.1.2.3.15.0',
      modelName:        '.1.3.6.1.4.1.52619.1.2.3.16.0',
    },
  },
];

const IF_ADMIN = { 1: 'up', 2: 'down', 3: 'testing' };
const IF_OPER  = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

const PLACEHOLDER = /^(-?na-?|n\/a|none|null|\*+)?$/i;
const clean = (v) => { const t = (v == null ? '' : String(v)).trim(); return PLACEHOLDER.test(t) ? null : t; };

/** "88dc971fe21d" → "88:dc:97:1f:e2:1d"; empty / all-zero → null. */
function formatMac(hex) {
  if (!hex || hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/../g).join(':').toLowerCase();
}

/** "10.0.150.88" → "net-10-0-150" (same convention provisioning uses). */
function networkIdFor(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip || '');
  return m ? `net-${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Turn raw walk results into inventory facts.
 * @param {Array<{oid:string,value:string,hex?:string}>} varbinds  concatenated walks
 * @param {{ managementIp?: string, sysObjectID?: string }} ctx
 */
function parseFacts(varbinds, { managementIp, sysObjectID } = {}) {
  const byOid = new Map(varbinds.map((v) => [v.oid, v]));
  const val = (oid) => byOid.get(oid)?.value;

  // ── standard: system group ────────────────────────────────────────────────
  const ticks = parseInt(val(`${SYS}.3.0`), 10);
  const facts = {
    uptimeSeconds: Number.isFinite(ticks) ? Math.floor(ticks / 100) : null,
    sysContact:    clean(val(`${SYS}.4.0`)),
  };

  // ── standard: IF-MIB (+ ifXTable names) ───────────────────────────────────
  const rows = new Map(); // ifIndex → row
  const row = (i) => { if (!rows.has(i)) rows.set(i, { index: i }); return rows.get(i); };
  for (const v of varbinds) {
    let m;
    if ((m = v.oid.startsWith(`${IFT}.`) && /^\.(\d+)\.(\d+)$/.exec(v.oid.slice(IFT.length)))) {
      const [, col, idx] = m; const r = row(Number(idx));
      if (col === '2') r.name = r.name || clean(v.value);
      else if (col === '3') r.type = Number(v.value);
      else if (col === '5') r.speedBps = Number(v.value);
      else if (col === '6') r.macAddress = formatMac(v.hex);
      else if (col === '7') r.adminStatus = IF_ADMIN[Number(v.value)] || String(v.value);
      else if (col === '8') r.operStatus = IF_OPER[Number(v.value)] || String(v.value);
    } else if ((m = v.oid.startsWith(`${IFX}.`) && /^\.(\d+)\.(\d+)$/.exec(v.oid.slice(IFX.length)))) {
      const [, col, idx] = m; const r = row(Number(idx));
      if (col === '1') r.name = clean(v.value) || r.name;          // ifName
      else if (col === '15') r.speedBps = Number(v.value) * 1e6;   // ifHighSpeed (Mbps)
    }
  }

  // ── standard: IP-MIB ipAddrTable → addresses per interface ────────────────
  const addrs = []; // { address, ifIndex, netmask }
  for (const v of varbinds) {
    const m = v.oid.startsWith(`${IPA}.`) && /^\.(\d+)\.((?:\d+\.){3}\d+)$/.exec(v.oid.slice(IPA.length));
    if (!m) continue;
    const [, col, ip] = m;
    let a = addrs.find((x) => x.address === ip);
    if (!a) { a = { address: ip }; addrs.push(a); }
    if (col === '2') a.ifIndex = Number(v.value);
    if (col === '3') a.netmask = v.value;
  }
  for (const a of addrs) if (rows.has(a.ifIndex)) (row(a.ifIndex).ipAddresses ||= []).push(a.address);

  const interfaces = [...rows.values()]
    .filter((r) => r.name)
    .map((r) => ({
      index: r.index, name: r.name, type: r.type ?? null,
      speedMbps: r.speedBps ? Math.round(r.speedBps / 1e6) : null,
      macAddress: r.macAddress || null,
      adminStatus: r.adminStatus || null, operStatus: r.operStatus || null,
      ipAddresses: r.ipAddresses || [],
    }))
    .sort((a, b) => a.index - b.index);
  facts.interfaces = interfaces;
  facts.ipAddresses = addrs.map(({ address, netmask, ifIndex }) => ({ address, netmask: netmask || null, ifIndex: ifIndex ?? null }));

  // management MAC = MAC of the interface that carries the management address
  const mgmt = addrs.find((a) => a.address === managementIp);
  const mgmtIf = mgmt && interfaces.find((i) => i.index === mgmt.ifIndex);
  facts.macAddress = mgmtIf?.macAddress || null;
  facts.managementInterface = mgmtIf?.name || null;

  // ── vendor profile ─────────────────────────────────────────────────────────
  const oid = `.${String(sysObjectID || '').replace(/^\./, '')}`;
  const profile = VENDOR_FACT_PROFILES.find((p) => oid === p.enterprise || oid.startsWith(`${p.enterprise}.`));
  if (profile) {
    for (const [field, o] of Object.entries(profile.facts)) {
      const v = clean(val(o));
      if (v) facts[field] = v;
    }
  }
  return facts;
}

/** Walk exactly the subtrees parseFacts needs (read-only). Never throws. */
async function collectDeviceFacts({ host, port = 161, community, managementIp, sysObjectID }) {
  const vendorRoots = [];
  const oid = `.${String(sysObjectID || '').replace(/^\./, '')}`;
  const profile = VENDOR_FACT_PROFILES.find((p) => oid === p.enterprise || oid.startsWith(`${p.enterprise}.`));
  if (profile) vendorRoots.push(...Object.values(profile.facts));

  const varbinds = [];
  const opts = { host, port, community, timeoutMs: 3000, retries: 1, overallTimeoutMs: 20000 };
  try {
    for (const root of [`${SYS}`, IFT, IFX, IPA]) {
      varbinds.push(...await walkSubtree({ ...opts, rootOid: root }).catch(() => []));
    }
    // vendor scalars: walk each one's parent so the .0 instance is returned
    for (const o of vendorRoots) {
      const parent = o.replace(/\.\d+$/, '');
      varbinds.push(...await walkSubtree({ ...opts, rootOid: parent }).catch(() => []));
    }
  } catch { /* partial facts are fine */ }
  if (!varbinds.length) return null;
  return parseFacts(varbinds, { managementIp: managementIp || host, sysObjectID });
}

/** Fields written onto the device (inventory) record, plus the same set read back for carry-over. */
const INVENTORY_FIELDS = [
  'macAddress', 'firmwareVersion', 'hardwareVersion', 'bootloaderVersion', 'modelName',
  'uptimeSeconds', 'sysContact', 'interfaces', 'ipAddresses', 'managementInterface',
  'reportedSerialNumber', 'factsCollectedAt',
];

/** Map collected facts to inventory-record fields (only those the device actually reported). */
function inventoryFields(facts, now = new Date()) {
  if (!facts) return {};
  const out = {};
  const f = { ...facts, reportedSerialNumber: facts.serialNumber };
  for (const k of INVENTORY_FIELDS) {
    const v = f[k];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  out.factsCollectedAt = now;
  return out;
}

module.exports = { collectDeviceFacts, parseFacts, formatMac, networkIdFor, inventoryFields, INVENTORY_FIELDS, VENDOR_FACT_PROFILES };

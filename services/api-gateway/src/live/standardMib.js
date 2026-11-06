'use strict';

/**
 * Standard-MIB fallback — real values from MIBs every SNMP agent serves, for fields whose vendor OID answers with
 * a placeholder (see firmwareQuirks.js). Vendor- and device-independent: a definition declares, per parameter,
 *
 *     <fallback source="ip.netmask"/>      <fallback source="mgmt.mtu"/>
 *
 * and this module answers it from IP-MIB / IF-MIB.
 *
 * FOOTPRINT: single GETs only — never a table walk. These radios' agents are small, and after interface / process /
 * address table walks the lab units' agents lost interfaces and processes (ifNumber 25 → 2). One cached read per
 * device per minute: at most 3 GETs, through the per-device gate.
 *
 * Sources
 *   ip.address   the management address, confirmed by ipAdEntAddr.<address>
 *   ip.netmask   ipAdEntNetMask.<address>
 *   ip.gateway   ipRouteNextHop.0.0.0.0 (default route)
 *   mgmt.mtu     ifMtu of the interface that carries the management address (ipAdEntIfIndex.<address>)
 */

const { runExclusive } = require('./snmpGate');

const TTL_MS = 60_000;
const cache = new Map();   // 'host:port' → { at, data }

const O = {
  addr:    (ip) => `.1.3.6.1.2.1.4.20.1.1.${ip}`,
  ifIndex: (ip) => `.1.3.6.1.2.1.4.20.1.2.${ip}`,
  mask:    (ip) => `.1.3.6.1.2.1.4.20.1.3.${ip}`,
  gateway: '.1.3.6.1.2.1.4.21.1.7.0.0.0.0',
  ifMtu:   (i) => `.1.3.6.1.2.1.2.2.1.4.${i}`,
};

/** One GET request for several OIDs → { oid: value } (missing / error varbinds are left out). */
function snmpGet({ host, port = 161, community, oids }) {
  const snmp = require('net-snmp');
  return runExclusive(host, port, () => new Promise((resolve) => {
    const session = snmp.createSession(host, community, { port, retries: 2, timeout: 2500, version: snmp.Version2c });
    const done = (out) => { try { session.close(); } catch { /* closed */ } resolve(out); };
    session.on('error', () => done({}));
    session.get(oids.map((o) => o.replace(/^\./, '')), (err, vbs) => {
      if (err || !vbs) return done({});
      const out = {};
      for (const vb of vbs) if (!snmp.isVarbindError(vb)) out[`.${vb.oid}`] = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
      return done(out);
    });
  }));
}

async function read({ host, port = 161, community }, io = snmpGet) {
  const key = `${host}:${port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const first = await io({ host, port, community, oids: [O.addr(host), O.mask(host), O.ifIndex(host), O.gateway] });
  const data = { address: first[O.addr(host)] || null, mask: first[O.mask(host)] || null, gateway: null, mtu: null };
  const gw = first[O.gateway];
  data.gateway = gw && gw !== '0.0.0.0' ? gw : null;
  const idx = first[O.ifIndex(host)];
  if (idx) {
    const second = await io({ host, port, community, oids: [O.ifMtu(idx)] });
    data.mtu = second[O.ifMtu(idx)] || null;
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** The value a fallback spec yields from `data`, as a precomputed instance, or undefined. */
function valueFor(spec, data) {
  if (!spec || !data) return undefined;
  const pick = { 'ip.address': data.address, 'ip.netmask': data.mask, 'ip.gateway': data.gateway, 'mgmt.mtu': data.mtu }[spec.source];
  return pick ? [{ index: '', raw: String(pick), display: String(pick), src: 'standard-mib' }] : undefined;
}

/** Fill entries that declare a fallback and have no real value yet. Returns how many were filled. */
async function overlay(entries, mapped, { host, port, community }, io) {
  const wanting = entries.filter((e) => e.fallback && e.fallback.source &&
    !(mapped.get(`${e.groupId}::${e.parameterId}`) || []).some((i) => !i.placeholder));
  if (!wanting.length) return 0;
  let data;
  try { data = await read({ host, port, community }, io); } catch { return 0; }
  let filled = 0;
  for (const e of wanting) {
    const v = valueFor(e.fallback, data);
    if (v) { mapped.set(`${e.groupId}::${e.parameterId}`, v); filled += 1; }
  }
  return filled;
}

module.exports = { read, valueFor, overlay, snmpGet };

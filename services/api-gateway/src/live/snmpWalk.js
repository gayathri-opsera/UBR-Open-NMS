'use strict';

/**
 * Read-only SNMP subtree walk (v2c) used to pull live parameter values from a device.
 *
 * Only GET-NEXT/GET-BULK requests are issued — nothing here can write to a device.
 * Values are returned as plain strings so callers never deal with Buffers:
 *   OCTET STRING → UTF-8 text when printable, otherwise space-separated hex
 *   everything else → String(value)
 */

const snmp = require('net-snmp');
const { runExclusive } = require('./snmpGate');

const TEXT_OK = /^[\x09\x0a\x0d\x20-\x7e]*$/;

/** Convert a net-snmp varbind value to its display string. */
function valueToString(vb) {
  const v = vb.value;
  if (Buffer.isBuffer(v)) {
    const text = v.toString('utf8');
    if (TEXT_OK.test(text)) return text;
    return Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }
  return v == null ? '' : String(v);
}

/**
 * Walk the subtree rooted at `rootOid`.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=161]
 * @param {string} opts.community
 * @param {string} opts.rootOid            e.g. ".1.3.6.1.4.1.52619.1.1"
 * @param {number} [opts.timeoutMs=3000]   per-request timeout
 * @param {number} [opts.retries=1]
 * @param {number} [opts.maxRepetitions=25]
 * @param {number} [opts.overallTimeoutMs=30000]
 * @returns {Promise<Array<{ oid: string, value: string, hex?: string }>>}  OIDs always carry a leading dot
 */
function walkSubtreeUngated({
  host, port = 161, community, rootOid,
  timeoutMs = 3000, retries = 1, maxRepetitions = 25, overallTimeoutMs = 30000,
}) {
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(host, community, {
      port, retries, timeout: timeoutMs, version: snmp.Version2c,
    });
    const out = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { session.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(out);
    };
    const guard = setTimeout(
      () => finish(Object.assign(new Error(`SNMP walk timed out after ${overallTimeoutMs} ms`), { code: 'WALK_TIMEOUT' })),
      overallTimeoutMs,
    );

    session.on('error', (err) => finish(err));

    const root = rootOid.startsWith('.') ? rootOid.slice(1) : rootOid;
    session.subtree(
      root,
      maxRepetitions,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue; // noSuchObject / endOfMibView
          const item = { oid: `.${vb.oid}`, value: valueToString(vb) };
          // keep the raw bytes of OCTET STRINGs (needed for MAC addresses, which may look like text)
          if (Buffer.isBuffer(vb.value)) item.hex = vb.value.toString('hex');
          out.push(item);
        }
      },
      (err) => finish(err || null),
    );
  });
}

/**
 * Walk the subtree rooted at `rootOid` — one operation at a time per device (see snmpGate.js).
 * The overall timeout starts when the walk actually begins, not while it waits its turn.
 */
function walkSubtree(opts) {
  return runExclusive(opts.host, opts.port || 161, () => walkSubtreeUngated(opts));
}

/**
 * Read specific OIDs with plain SNMP GET (batched), one operation at a time per device.
 *
 * Needed because some agents cannot be walked in places (GETNEXT/GETBULK skips a subtree or answers the
 * same OID forever — e.g. the UBR655 management scalars `…123.1.2.1.N.0`) although a GET of the exact
 * instance works. Read-only. Never rejects: a batch that times out is skipped, so a fallback can never
 * turn a successful poll into a failed one. Varbind errors (noSuchObject / noSuchInstance) are dropped.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=161]
 * @param {string} opts.community
 * @param {string[]} opts.oids  full instance OIDs (leading dot optional), e.g. '.1.3.6…1.2.1.2.0'
 * @param {number} [opts.batchSize=8]
 * @returns {Promise<Array<{ oid: string, value: string, hex?: string }>>}  OIDs always carry a leading dot
 */
function getOids({ host, port = 161, community, oids, timeoutMs = 3000, retries = 1, batchSize = 8, overallTimeoutMs = 20000 }) {
  const wanted = Array.from(new Set((oids || []).map((o) => String(o).replace(/^\./, '')).filter(Boolean)));
  if (!wanted.length) return Promise.resolve([]);
  return runExclusive(host, port, () => new Promise((resolve) => {
    const session = snmp.createSession(host, community, { port, retries, timeout: timeoutMs, version: snmp.Version2c });
    const out = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try { session.close(); } catch { /* already closed */ }
      resolve(out);
    };
    const guard = setTimeout(finish, overallTimeoutMs);
    session.on('error', finish);

    const batches = [];
    for (let i = 0; i < wanted.length; i += batchSize) batches.push(wanted.slice(i, i + batchSize));
    const next = () => {
      const batch = batches.shift();
      if (!batch) return finish();
      session.get(batch, (err, varbinds) => {
        if (!err) {
          for (const vb of varbinds || []) {
            if (snmp.isVarbindError(vb)) continue;
            const item = { oid: `.${vb.oid}`, value: valueToString(vb) };
            if (Buffer.isBuffer(vb.value)) item.hex = vb.value.toString('hex');
            out.push(item);
          }
        }
        next();
      });
    };
    next();
  }));
}

/**
 * One SNMP GET (sysUpTime) used as a liveness probe — deliberately NOT gated (see snmpGate.js): it is one tiny GET and must not queue behind a walk.
 * @returns {Promise<{ online: boolean, rttMs: number|null, uptime: string|null, error?: string }>}
 */
function probeDevice({ host, port = 161, community, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const session = snmp.createSession(host, community, { port, retries: 1, timeout: timeoutMs, version: snmp.Version2c });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { session.close(); } catch { /* closed */ } resolve(r); };
    session.on('error', (e) => finish({ online: false, rttMs: null, uptime: null, error: e.message }));
    session.get(['1.3.6.1.2.1.1.3.0'], (err, vbs) => {
      if (err) return finish({ online: false, rttMs: null, uptime: null, error: err.message });
      const vb = vbs && vbs[0];
      if (!vb || snmp.isVarbindError(vb)) return finish({ online: false, rttMs: null, uptime: null, error: 'no sysUpTime' });
      finish({ online: true, rttMs: Date.now() - started, uptime: String(vb.value) });
    });
  });
}

/** True when the error means the device could not be reached (as opposed to a bad community, etc.). */
function isUnreachable(err) {
  const name = (err && (err.name || err.code || '')).toString();
  const msg = ((err && err.message) || '').toLowerCase();
  return name === 'RequestTimedOutError' || name === 'WALK_TIMEOUT' ||
    msg.includes('timed out') || msg.includes('timeout') ||
    msg.includes('ehostunreach') || msg.includes('enetunreach') || msg.includes('econnrefused');
}

module.exports = { walkSubtree, getOids, probeDevice, valueToString, isUnreachable };

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
function walkSubtree({
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

/** True when the error means the device could not be reached (as opposed to a bad community, etc.). */
function isUnreachable(err) {
  const name = (err && (err.name || err.code || '')).toString();
  const msg = ((err && err.message) || '').toLowerCase();
  return name === 'RequestTimedOutError' || name === 'WALK_TIMEOUT' ||
    msg.includes('timed out') || msg.includes('timeout') ||
    msg.includes('ehostunreach') || msg.includes('enetunreach') || msg.includes('econnrefused');
}

module.exports = { walkSubtree, valueToString, isUnreachable };

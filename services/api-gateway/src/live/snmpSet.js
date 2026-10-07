'use strict';

/**
 * SNMP SET (v2c) for Node View "Apply".
 *
 * Unlike snmpWalk.js this module WRITES to a device, so it is deliberately narrow:
 *   - it needs an explicit write community (never the read community, never guessed);
 *   - every target OID is read first — a missing instance is rejected, and the value is
 *     encoded with the ASN.1 type the device itself reports for that OID;
 *   - one request per OID, so a failure is attributed to the exact parameter.
 */

const defaultSnmp = require('net-snmp');

/** Write community for a device: its own, else the deployment-wide one; null when neither is set. */
function writeCommunityFor(device, env = process.env) {
  const c = (device && device.snmpWriteCommunity) || env.SNMP_WRITE_COMMUNITY || '';
  return c ? String(c) : null;
}

function encode(snmp, type, value) {
  const T = snmp.ObjectType;
  switch (type) {
    case T.Integer:
    case T.Integer32:
    case T.Gauge:
    case T.Gauge32:
    case T.Unsigned32:
    case T.Counter:
    case T.Counter32:
    case T.TimeTicks: {
      if (!/^-?\d+$/.test(value)) throw new Error('device expects a whole number');
      return parseInt(value, 10);
    }
    case T.OctetString: return Buffer.from(value, 'utf8');
    case T.IpAddress: return value;
    default: throw new Error(`unsupported SNMP type ${type}`);
  }
}

const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=161]
 * @param {string} opts.community      WRITE community
 * @param {Array<{oid:string,value:string}>} opts.items
 * @param {object} [opts.snmp]         injectable net-snmp (tests)
 * @returns {Promise<Array<{oid:string, ok:boolean, error?:string}>>}  one result per item, in order
 */
async function setValues({ host, port = 161, community, items, snmp = defaultSnmp, timeoutMs = 4000 }) {
  if (!community) throw Object.assign(new Error('no SNMP write community configured'), { code: 'WRITE_NOT_CONFIGURED' });
  const session = snmp.createSession(host, community, { port, retries: 1, timeout: timeoutMs, version: snmp.Version2c });
  const results = [];
  try {
    for (const { oid, value } of items) {
      const dotless = oid.replace(/^\./, '');
      try {
        const [current] = await call((cb) => session.get([dotless], cb));
        if (!current || snmp.isVarbindError(current)) throw new Error('this instance does not exist on the device');
        const encoded = encode(snmp, current.type, String(value));
        const [written] = await call((cb) => session.set([{ oid: dotless, type: current.type, value: encoded }], cb));
        if (written && snmp.isVarbindError(written)) throw new Error(snmp.varbindError(written));
        results.push({ oid, ok: true });
      } catch (err) {
        results.push({ oid, ok: false, error: err.message });
      }
    }
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
  return results;
}

module.exports = { setValues, writeCommunityFor };

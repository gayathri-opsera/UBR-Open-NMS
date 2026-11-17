'use strict';

/**
 * Validation for the admin "snmpget through the NMS" tool: GET only, a bounded list of well-formed numeric OIDs.
 * The device's credential is used server-side and is never part of a response.
 */
const MAX_OIDS = 60;

function parseOids(body) {
  const raw = body && body.oids;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: 'oids must be a non-empty array of numeric OIDs' };
  if (raw.length > MAX_OIDS) return { ok: false, message: `at most ${MAX_OIDS} OIDs per request` };
  const oids = [];
  for (const o of raw) {
    const s = String(o).trim();
    if (!/^\.?\d+(\.\d+){2,}$/.test(s)) return { ok: false, message: `not a numeric OID: ${s.slice(0, 40)}` };
    oids.push(`.${s.replace(/^\./, '')}`);
  }
  return { ok: true, oids: Array.from(new Set(oids)) };
}

function isAdmin(role) { const r = String(role || '').toLowerCase(); return r === 'admin' || r === 'superadmin'; }

module.exports = { parseOids, isAdmin, MAX_OIDS };

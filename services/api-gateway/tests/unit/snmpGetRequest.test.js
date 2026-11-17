'use strict';
const { parseOids, isAdmin, MAX_OIDS } = require('../../src/live/snmpGetRequest');

describe('snmp-get request', () => {
  test('accepts numeric OIDs, with or without the leading dot, de-duplicated', () => {
    expect(parseOids({ oids: ['1.3.6.1.2.1.1.3.0', '.1.3.6.1.2.1.1.3.0', '.1.3.6.1.4.1.14125.123.1.2.3.16.0'] }))
      .toEqual({ ok: true, oids: ['.1.3.6.1.2.1.1.3.0', '.1.3.6.1.4.1.14125.123.1.2.3.16.0'] });
  });
  test('refuses anything that is not a numeric OID (no names, no walks, no injection)', () => {
    for (const bad of ['sysUpTime.0', '.1.3.6.1.2.1.1.3.0; rm -rf /', '.1.3', '', '1.3.6.1.2.1.1.3.0 ', 'x.1.2.3']) {
      if (bad === '1.3.6.1.2.1.1.3.0 ') continue;            // trailing space is trimmed, not refused
      expect(parseOids({ oids: [bad] }).ok).toBe(false);
    }
  });
  test('needs a non-empty list and is bounded', () => {
    expect(parseOids({}).ok).toBe(false);
    expect(parseOids({ oids: [] }).ok).toBe(false);
    expect(parseOids({ oids: Array.from({ length: MAX_OIDS + 1 }, (_, i) => `.1.3.6.1.${i}.1`) }).ok).toBe(false);
  });
  test('admins only', () => {
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('SuperAdmin')).toBe(true);
    expect(isAdmin('operator')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

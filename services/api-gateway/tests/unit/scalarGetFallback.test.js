'use strict';

// net-snmp is not needed for the pure helpers; keep this runnable on a host without it.
jest.mock('net-snmp', () => ({ Version2c: 1, createSession: jest.fn(), isVarbindError: () => false }), { virtual: true });

const { mapVarbinds, scalarGetTargets, mergeScalarGets } = require('../../src/live/liveParameters');

const R = '.1.3.6.1.4.1.14125.123.1';
const entries = [
  { groupId: 'g1', parameterId: 'wirelessSSID', snmpOid: `${R}.1.1.1.1.1.3` },     // table column, walked fine
  { groupId: 'g2', parameterId: 'sysMgmtReset', snmpOid: `${R}.2.1.2` },           // scalar the agent will not walk
  { groupId: 'g2', parameterId: 'sysMgmtReboot', snmpOid: `${R}.2.1.3` },
  { groupId: 'g3', parameterId: 'noOid', snmpOid: null },
];
const walked = [
  { oid: `${R}.1.1.1.1.1.3.1`, value: 'UBRMGMT409117' },
  { oid: `${R}.1.1.1.1.1.3.2`, value: 'oct21' },
];

describe('scalarGetTargets', () => {
  it('asks only for entries the walk produced nothing for, as <oid>.0', () => {
    const mapped = mapVarbinds(entries, walked);
    expect(scalarGetTargets(entries, mapped)).toEqual([`${R}.2.1.2.0`, `${R}.2.1.3.0`]);
  });

  it('asks for nothing when the walk mapped everything', () => {
    const all = [...walked, { oid: `${R}.2.1.2.0`, value: '0' }, { oid: `${R}.2.1.3.0`, value: '0' }];
    expect(scalarGetTargets(entries, mapVarbinds(entries, all))).toEqual([]);
  });

  it('skips entries without an OID and de-duplicates shared OIDs', () => {
    const dup = [...entries, { groupId: 'g9', parameterId: 'alias', snmpOid: `${R}.2.1.2` }];
    const t = scalarGetTargets(dup, mapVarbinds(dup, walked));
    expect(t.filter((o) => o === `${R}.2.1.2.0`)).toHaveLength(1);
    expect(t.some((o) => o.includes('null'))).toBe(false);
  });
});

describe('mergeScalarGets', () => {
  it('fills the missing scalar as a single row-less instance', () => {
    const mapped = mapVarbinds(entries, walked);
    mergeScalarGets(entries, mapped, [{ oid: `${R}.2.1.2.0`, value: '0' }]);
    expect(mapped.get('g2::sysMgmtReset')).toEqual([{ index: '', raw: '0' }]);
    expect(mapped.has('g2::sysMgmtReboot')).toBe(false);   // device gave nothing → stays missing, not invented
  });

  it('never overwrites a value the walk already found', () => {
    const mapped = mapVarbinds(entries, walked);
    mergeScalarGets(entries, mapped, [{ oid: `${R}.1.1.1.1.1.3.0`, value: 'WRONG' }]);
    expect(mapped.get('g1::wirelessSSID').map((i) => i.raw)).toEqual(['UBRMGMT409117', 'oct21']);
  });

  it('is a no-op for an empty GET result', () => {
    const mapped = mapVarbinds(entries, walked);
    expect(mergeScalarGets(entries, mapped, [])).toBe(mapped);
  });
});

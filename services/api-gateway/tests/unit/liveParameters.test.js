'use strict';

/**
 * Unit tests for src/live/liveParameters.js — the pure parts that turn an activated
 * Product Definition registry + an SNMP walk into the Node View payload.
 * Fixtures mirror the real EOC UBR655 (enterprise 52619): per-radio table rows (.1/.2/.3)
 * and scalar (.0) objects.
 */

const {
  normOid, walkRoots, mapVarbinds, resolveDisplay, groupEntries, buildCurrentResponse,
} = require('../../src/live/liveParameters');

const E = '.1.3.6.1.4.1.52619';

const entry = (o) => ({
  _id: o._id, groupId: 'radio', parameterId: o.parameterId, displayName: o.displayName || o.parameterId,
  dataType: 'enum', snmpOid: o.snmpOid, enumValues: o.enumValues, subGroup: 'properties',
  displayOrder: o.displayOrder || 0, uiVisibleTo: undefined,
});

const entries = [
  entry({ _id: 'a1', parameterId: 'linktype', snmpOid: `${E}.1.1.1.1.1.35`, enumValues: ['PTP(1)', 'PTMP(3)'], displayOrder: 2 }),
  entry({ _id: 'a2', parameterId: 'ssid', snmpOid: `${E}.1.1.1.1.1.3`, displayOrder: 1 }),
  { ...entry({ _id: 'a3', parameterId: 'ipAddress', snmpOid: `${E}.1.1.2.2.0` }), groupId: 'network', subGroup: 'ip_configuration' },
  entry({ _id: 'a4', parameterId: 'ofdma', snmpOid: null }),           // no OID in the definition
  entry({ _id: 'a5', parameterId: 'missingOnDevice', snmpOid: `${E}.1.1.9.9.9` }),
];

const walk = [
  { oid: `${E}.1.1.1.1.1.3.1`, value: 'UBRMGMT' },
  { oid: `${E}.1.1.1.1.1.3.2`, value: 'UBR655_R17' },
  { oid: `${E}.1.1.1.1.1.35.2`, value: '3' },
  { oid: `${E}.1.1.1.1.1.35.1`, value: '1' },
  { oid: `${E}.1.1.1.1.1.350.1`, value: 'not-ours' },   // longer arc that merely starts with "35"
  { oid: `${E}.1.1.2.2.0`, value: '10.0.150.88' },
];

describe('normOid', () => {
  it('adds the leading dot and rejects blanks / "None"', () => {
    expect(normOid('1.3.6')).toBe('.1.3.6');
    expect(normOid('.1.3.6')).toBe('.1.3.6');
    expect(normOid('None')).toBeNull();
    expect(normOid('')).toBeNull();
    expect(normOid(null)).toBeNull();
  });
});

describe('walkRoots', () => {
  it('walks one common prefix per enterprise root', () => {
    expect(walkRoots([`${E}.1.1.1.1.1.35`, `${E}.1.1.2.2.0`])).toEqual([`${E}.1.1`]);
  });
  it('splits different enterprises into separate walks', () => {
    expect(walkRoots([`${E}.1.1.1.1`, `${E}.1.1.1.2`, '.1.3.6.1.4.1.2021.10.1.3', '.1.3.6.1.4.1.2021.10.1.4']))
      .toEqual([`${E}.1.1.1`, '.1.3.6.1.4.1.2021.10.1']);
  });
  it('walks the parent when every OID is the same leaf', () => {
    expect(walkRoots([`${E}.1.1.2.2.0`])).toEqual([`${E}.1.1.2.2`]);
  });
});

describe('mapVarbinds', () => {
  const mapped = mapVarbinds(entries, walk);

  it('keeps the SNMP row index of table columns', () => {
    expect(mapped.get('radio::ssid')).toEqual([
      { index: '1', raw: 'UBRMGMT' }, { index: '2', raw: 'UBR655_R17' },
    ]);
  });
  it('does not confuse an OID with a longer one that shares its digits', () => {
    expect(mapped.get('radio::linktype').map((i) => i.raw).sort()).toEqual(['1', '3']);
  });
  it('treats a trailing .0 as a scalar (empty index)', () => {
    expect(mapped.get('network::ipAddress')).toEqual([{ index: '', raw: '10.0.150.88' }]);
  });
  it('never invents values for parameters without an OID or without a device value', () => {
    expect(mapped.has('radio::ofdma')).toBe(false);
    expect(mapped.has('radio::missingOnDevice')).toBe(false);
  });
  it('assigns one OID to every parameter that declares it', () => {
    const shared = [
      { ...entries[1], _id: 'x1', parameterId: 'p1', snmpOid: `${E}.1.1.1.1.1.3` },
      { ...entries[1], _id: 'x2', parameterId: 'p2', snmpOid: `${E}.1.1.1.1.1.3` },
    ];
    const m = mapVarbinds(shared, walk);
    expect(m.get('radio::p1')).toHaveLength(2);
    expect(m.get('radio::p2')).toHaveLength(2);
  });
});

describe('resolveDisplay', () => {
  it('maps an integer to the definition label with the matching "(n)" suffix', () => {
    expect(resolveDisplay({ enumValues: ['Enable(0)', 'Disable(1)'] }, '1')).toBe('Disable(1)');
  });
  it('returns the raw value when nothing matches or there is no enum', () => {
    expect(resolveDisplay({ enumValues: ['Enable(0)'] }, '7')).toBe('7');
    expect(resolveDisplay({}, 'abc')).toBe('abc');
  });
  it('matches a label that is already the raw value', () => {
    expect(resolveDisplay({ enumValues: ['HT20', 'HT80'] }, 'HT80')).toBe('HT80');
  });
});

describe('groupEntries', () => {
  it('keeps definition order for groups and sorts parameters by displayOrder', () => {
    const g = groupEntries(entries);
    expect(g.map((x) => x.groupId)).toEqual(['radio', 'network']);
    expect(g[0].params.slice(0, 2).map((p) => p.parameterId)).toEqual(['ssid', 'linktype']);
  });
});

describe('buildCurrentResponse', () => {
  const definition = { productDefinitionId: 'eoc-configurations-gui', registryVersion: '4', entries };
  const device = { _id: 'EOC655' };
  const now = new Date('2026-10-05T10:00:30Z');
  const values = Array.from(mapVarbinds(entries, walk).entries()).map(([k, instances]) => {
    const [groupId, parameterId] = k.split('::');
    return { groupId, parameterId, instances };
  });
  const doc = { collectedAt: new Date('2026-10-05T10:00:00Z'), pollStatus: 'OK', values };

  const res = buildCurrentResponse({ device, definition, doc, now });
  const param = (id) => res.data.groups.flatMap((g) => g.parameters).find((p) => p.parameterId === id);

  it('exposes exactly the definition parameters', () => {
    expect(res.data.groups.flatMap((g) => g.parameters).map((p) => p.parameterId).sort())
      .toEqual(['ipAddress', 'linktype', 'missingOnDevice', 'ofdma', 'ssid']);
  });
  it('returns table values as ordered instances with resolved enum labels', () => {
    expect(param('linktype').isTable).toBe(true);
    expect(param('linktype').instances.map((i) => [i.index, i.display])).toEqual([['1', 'PTP(1)'], ['2', 'PTMP(3)']]);
    expect(param('linktype').freshnessState).toBe('FRESH');
  });
  it('returns scalars without an index', () => {
    expect(param('ipAddress')).toMatchObject({ isTable: false, value: '10.0.150.88', readStatus: 'SUCCESS' });
  });
  it('reports a parameter without an OID as UNMAPPED, not as a value', () => {
    expect(param('ofdma')).toMatchObject({ readStatus: 'UNMAPPED', freshnessState: 'UNMAPPED', value: null });
  });
  it('reports an OID the device does not have as NO_SUCH_OBJECT', () => {
    expect(param('missingOnDevice')).toMatchObject({ readStatus: 'NO_SUCH_OBJECT', value: null });
  });
  it('marks values STALE once the last successful poll is old', () => {
    const late = buildCurrentResponse({ device, definition, doc, now: new Date('2026-10-05T10:10:00Z') });
    const p = late.data.groups.flatMap((g) => g.parameters).find((x) => x.parameterId === 'ssid');
    expect(p.freshnessState).toBe('STALE');
  });
  it('keeps the last values and surfaces the error when the device is unreachable', () => {
    const down = buildCurrentResponse({
      device, definition, now,
      doc: { ...doc, pollStatus: 'UNREACHABLE', pollError: 'timed out' },
    });
    const p = down.data.groups.flatMap((g) => g.parameters).find((x) => x.parameterId === 'ssid');
    expect(down.data).toMatchObject({ pollStatus: 'UNREACHABLE', pollError: 'timed out' });
    expect(p.value).toBe('UBRMGMT');
    expect(p.freshnessState).toBe('STALE');
  });
  it('reports NOT_POLLED with no values before the first poll', () => {
    const fresh = buildCurrentResponse({ device, definition, doc: null, now });
    expect(fresh.data.pollStatus).toBe('NOT_POLLED');
    expect(fresh.data.groups[0].parameters.find((p) => p.parameterId === 'ssid').value).toBeNull();
  });
});

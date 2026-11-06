'use strict';

jest.mock('../../src/models/uiDescriptor.model', () => ({}), { virtual: true });
jest.mock('../../src/models/nodeViewWireframe.model', () => ({ NodeViewWireframe: {}, invalidateCache: jest.fn() }), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'x' }), { virtual: true });
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), { virtual: true });
jest.mock('../../src/live/uiXmlGenerator', () => ({ generateUiXml: () => '' }), { virtual: true });
jest.mock('net-snmp', () => ({ Version2c: 1, createSession: jest.fn(), isVarbindError: () => false }), { virtual: true });

const { descriptorToWireframe, liveRefreshFor } = require('../../src/routes/uiBuilder.routes');
const { isLiveEntry } = require('../../src/live/liveParameters');

const f = (over) => ({ fieldId: 'f', elementType: 'field-label', mibObject: 'x', oid: '.1.2.3', access: 'read-only', order: 0, ...over });
const wf = (sections) => descriptorToWireframe({ screenName: 'S', sections: sections.map((s, i) => ({ sectionId: `s${i}`, title: `T${i}`, order: i, ...s })) });

describe('section live refresh is carried into the wireframe, but only where it is safe', () => {
  it('keeps the interval for a read-only section', () => {
    const w = wf([{ liveRefreshSeconds: 5, fields: [f({ mibObject: 'ethernetTxPPS' }), f({ mibObject: 'ethernetRxPPS' })] }]);
    expect(w.groups[0].liveRefreshSeconds).toBe(5);
  });

  it('drops it when ANY field in the section is writable', () => {
    const w = wf([{ liveRefreshSeconds: 5, fields: [f({ mibObject: 'a' }), f({ mibObject: 'b', access: 'read-write' })] }]);
    expect(w.groups[0].liveRefreshSeconds).toBeNull();
  });

  it('is off by default and for 0 / junk values', () => {
    expect(wf([{ fields: [f({})] }]).groups[0].liveRefreshSeconds).toBeNull();
    expect(liveRefreshFor({ liveRefreshSeconds: 0 }, [{ readOnly: true }])).toBeNull();
    expect(liveRefreshFor({ liveRefreshSeconds: 'abc' }, [{ readOnly: true }])).toBeNull();
    expect(liveRefreshFor({ liveRefreshSeconds: -3 }, [{ readOnly: true }])).toBeNull();
  });

  it('clamps to 2..300 seconds so a lab agent is never hammered', () => {
    expect(liveRefreshFor({ liveRefreshSeconds: 1 }, [{ readOnly: true }])).toBe(2);
    expect(liveRefreshFor({ liveRefreshSeconds: 9999 }, [{ readOnly: true }])).toBe(300);
    expect(liveRefreshFor({ liveRefreshSeconds: 7.4 }, [{ readOnly: true }])).toBe(7);
  });

  it('is independent per section', () => {
    const w = wf([
      { liveRefreshSeconds: 2, fields: [f({ mibObject: 'assocRxRate' })] },
      { fields: [f({ mibObject: 'serial' })] },
    ]);
    expect(w.groups.map((g) => g.liveRefreshSeconds)).toEqual([2, null]);
  });
});

describe('isLiveEntry — what the gateway will read in real time', () => {
  const builder = { registryVersion: 'ui-builder' };
  it('accepts a Builder entry from a live, read-only section', () => {
    expect(isLiveEntry(builder, { liveRefreshSeconds: 5, readOnly: true })).toBe(true);
  });
  it('refuses a writable entry even if its section says live', () => {
    expect(isLiveEntry(builder, { liveRefreshSeconds: 5, readOnly: false })).toBe(false);
  });
  it('refuses a Builder entry whose section is not live', () => {
    expect(isLiveEntry(builder, { liveRefreshSeconds: 0, readOnly: true })).toBe(false);
    expect(isLiveEntry(builder, { readOnly: true })).toBe(false);
  });
  it('does not let a non-Builder definition opt in through liveRefreshSeconds', () => {
    expect(isLiveEntry({ registryVersion: '12' }, { liveRefreshSeconds: 5, readOnly: true })).toBe(false);
  });
  it('still accepts Monitor-page entries of uploaded definitions (unchanged behaviour)', () => {
    expect(isLiveEntry({ registryVersion: '12' }, { uiPage: 'Monitor' })).toBe(true);
  });
});

describe('liveGetTargets — exact-instance GETs for a live read', () => {
  const { liveGetTargets } = require('../../src/live/liveParameters');
  const entries = [
    { groupId: 'g', parameterId: 'chan', snmpOid: '.1.3.6.1.4.1.14125.123.1.1.1.1.1.23' },
    { groupId: 'g', parameterId: 'cpu', snmpOid: '.1.3.6.1.4.1.14125.123.1.2.2.13' },
  ];
  const now = Date.parse('2026-11-06T00:00:00Z');
  const fresh = (values) => ({ collectedAt: new Date(now - 30_000).toISOString(), values });
  const stored = fresh([
    { groupId: 'g', parameterId: 'chan', instances: [{ index: '1', raw: '6' }, { index: '2', raw: '140' }, { index: '3', raw: '36' }] },
    { groupId: 'g', parameterId: 'cpu', instances: [{ index: '', raw: '12' }] },
  ]);

  it('builds one GET per known row, and <oid>.0 for a scalar', () => {
    expect(liveGetTargets(entries, stored, now)).toEqual([
      '.1.3.6.1.4.1.14125.123.1.1.1.1.1.23.1', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.23.2', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.23.3',
      '.1.3.6.1.4.1.14125.123.1.2.2.13.0',
    ]);
  });
  it('returns null (=> walk) when the last poll does not cover every entry', () => {
    expect(liveGetTargets(entries, fresh([stored.values[0]]), now)).toBeNull();
    expect(liveGetTargets(entries, fresh([stored.values[0], { groupId: 'g', parameterId: 'cpu', instances: [] }]), now)).toBeNull();
  });
  it('returns null when there is no stored poll or it is stale', () => {
    expect(liveGetTargets(entries, null, now)).toBeNull();
    expect(liveGetTargets(entries, { ...stored, collectedAt: new Date(now - 10 * 60_000).toISOString() }, now)).toBeNull();
  });
});

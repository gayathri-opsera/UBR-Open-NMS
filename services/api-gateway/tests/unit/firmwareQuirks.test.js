'use strict';

const { applyFirmwareQuirks } = require('../../src/live/firmwareQuirks');

const ROOT = '.1.3.6.1.4.1.14125.123';          // re-rooted firmware (fw 1.0.0.161)
const col = (c, r = 2) => `${ROOT}.1.3.1.1.${c}.${r}`;
const entries = [4, 5, 6, 7, 8, 9, 30, 31, 32, 33].map((c) => ({ groupId: 'g', parameterId: `p${c}`, snmpOid: col(c) }));
const mapOf = (vals) => new Map(Object.entries(vals).map(([c, raw]) => [`g::p${c}`, [{ index: '', raw }]]));
const dev = { sysObjectID: ROOT };

describe('applyFirmwareQuirks', () => {
  it('derives total packets from unicast + multicast + broadcast when the agent reports 0', () => {
    const m = applyFirmwareQuirks(entries, mapOf({ 4: '0', 5: '0', 6: '5', 7: '0', 8: '1000', 9: '2000', 32: '2', 33: '0', 30: '0.00', 31: '0.00' }), dev);
    expect(m.get('g::p4')[0].raw).toBe('1007');
    expect(m.get('g::p5')[0].raw).toBe('2000');
  });

  it('withholds the always-zero throughput so the UI reports it as not exposed', () => {
    const m = applyFirmwareQuirks(entries, mapOf({ 4: '0', 5: '0', 6: '0', 7: '0', 8: '1', 9: '1', 32: '0', 33: '0', 30: '0.00', 31: '0.00' }), dev);
    expect(m.get('g::p30')[0]).toMatchObject({ raw: '0.00', placeholder: true });
    expect(m.get('g::p31')[0]).toMatchObject({ raw: '0.00', placeholder: true });
  });

  it('keeps real values untouched', () => {
    const m = applyFirmwareQuirks(entries, mapOf({ 4: '77', 5: '88', 6: '0', 7: '0', 8: '1', 9: '1', 32: '0', 33: '0', 30: '12.50', 31: '3.10' }), dev);
    expect(m.get('g::p4')[0].raw).toBe('77');
    expect(m.get('g::p30')[0].raw).toBe('12.50');
  });

  it('does nothing for a device on the original root', () => {
    const orig = entries.map((e) => ({ ...e, snmpOid: e.snmpOid.replace('.1.3.6.1.4.1.14125.123', '.1.3.6.1.4.1.52619') }));
    const m = applyFirmwareQuirks(orig, mapOf({ 4: '0', 8: '9', 30: '0.00' }), { sysObjectID: '.1.3.6.1.4.1.52619' });
    expect(m.get('g::p4')[0].raw).toBe('0');
    expect(m.has('g::p30')).toBe(true);
  });

  describe('configuration placeholders', () => {
    const cfg = (c, r = 2) => `${ROOT}.1.1.1.1.1.${c}.${r}`;
    const cEntries = [3, 4, 5].map((c) => ({ groupId: 'c', parameterId: `c${c}`, snmpOid: cfg(c) }))
      .concat([{ groupId: 'c', parameterId: 'mtu', snmpOid: `${ROOT}.1.1.5.6.1.4.2` }]);
    const m = (vals) => new Map(Object.entries(vals).map(([k, raw]) => [`c::${k}`, [{ index: '', raw }]]));

    it('withholds -1 / -NA- / 0.0.0.0 and a zero MTU on the re-rooted firmware', () => {
      const out = applyFirmwareQuirks(cEntries, m({ c3: '-NA-', c4: '-1', c5: '0.0.0.0', mtu: '0' }), dev);
      expect([...out.values()].every((l) => l.every((i) => i.placeholder === true))).toBe(true);
      expect(out.size).toBe(4);
    });

    it('also covers the management tree (system name, location, ...)', () => {
      const e = [{ groupId: 'c', parameterId: 'sys', snmpOid: `${ROOT}.1.2.2.1.0` }];
      expect(applyFirmwareQuirks(e, m({ sys: '-NA-' }), dev).get('c::sys')[0].placeholder).toBe(true);
      expect(applyFirmwareQuirks(e, m({ sys: 'UBR655' }), dev).get('c::sys')[0].raw).toBe('UBR655');
    });

    it('keeps real configuration values', () => {
      const out = applyFirmwareQuirks(cEntries, m({ c3: 'oct21', c4: '140', c5: '10.0.150.107', mtu: '1500' }), dev);
      expect(out.get('c::c3')[0].raw).toBe('oct21');
      expect(out.get('c::mtu')[0].raw).toBe('1500');
    });

    it('leaves the original-root firmware alone', () => {
      const orig = cEntries.map((e) => ({ ...e, snmpOid: e.snmpOid.replace('.1.3.6.1.4.1.14125.123', '.1.3.6.1.4.1.52619') }));
      const out = applyFirmwareQuirks(orig, m({ c3: '-NA-' }), { sysObjectID: '.1.3.6.1.4.1.52619' });
      expect(out.get('c::c3')[0].raw).toBe('-NA-');
    });
  });
});

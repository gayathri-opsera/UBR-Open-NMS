'use strict';
const { computeSource } = require('../../src/live/calcExpr');
const { headerInputs, resolveHeader, paramId, HEADER_GROUP } = require('../../src/live/headerSources');

describe('computeSource', () => {
  test('typed text', () => { expect(computeSource({ kind: 'text', text: 'UBR660' })).toEqual({ ok: true, text: 'UBR660' }); });
  test('a template drops device values into text', () => {
    const s = { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw', oid: '.1' }, { name: 'sn', oid: '.2' }] };
    expect(computeSource(s, { fw: '1.0.0-183', sn: '2641XCT000DK' })).toEqual({ ok: true, text: '1.0.0-183 SNo. 2641XCT000DK' });
  });
  test('a missing input is a failure, never a half-filled text', () => {
    const s = { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw' }, { name: 'sn' }] };
    expect(computeSource(s, { fw: '1.0.0' }).ok).toBe(false);
    expect(computeSource(s, { fw: '1.0.0', sn: '  ' }).ok).toBe(false);
  });
  test('a value map turns device codes into display text, leaving unknown codes as they are', () => {
    const s = { kind: 'template', template: '{m}', inputs: [{ name: 'm', map: { ap: 'BTS', sta: 'CPE' } }] };
    expect(computeSource(s, { m: 'ap' }).text).toBe('BTS');
    expect(computeSource(s, { m: 'sta' }).text).toBe('CPE');
    expect(computeSource(s, { m: 'mesh' }).text).toBe('mesh');
  });
  test('a calculation (uptime) formats the result', () => {
    const s = { kind: 'calc', expr: '{t} / 100', format: 'duration', inputs: [{ name: 't' }] };
    expect(computeSource(s, { t: '12695600' }).text).toBe('1d 11h 15m 56s');
    expect(computeSource(s, {}).ok).toBe(false);
  });
});

describe('header resolution per device', () => {
  const ui = {
    productName: 'sample', versionLine: 'sample 2641XCT0026K', uptime: '1d 0h',
    sources: {
      productName: { kind: 'template', template: '{m}', inputs: [{ name: 'm', oid: '.1.3.6.1.4.1.14125.123.1.2.3.16' }] },
      versionLine: { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw', oid: '.7' }, { name: 'sn', oid: '.1' }] },
      uptime: { kind: 'calc', expr: '{t}/100', format: 'duration', inputs: [{ name: 't', oid: '.1.3.6.1.2.1.1.3.0' }] },
    },
    radios: [
      { label: 'Radio 1', mode: 'BTS', up: true, modeSource: { kind: 'template', template: '{m}', inputs: [{ name: 'm', oid: '.1.1.1.1.1.2.2', map: { ap: 'BTS', sta: 'CPE' } }] }, upSource: { oid: '.1.1.1.1.1.33.2', upValues: ['0'] } },
      { label: '2.4 GHz', mode: 'AP', up: false, modeSource: { kind: 'template', template: '{m}', inputs: [{ name: 'm', oid: '.1.1.1.1.1.2.1', map: { ap: 'AP', sta: 'STA' } }] }, upSource: { oid: '.1.1.1.1.1.33.1', upValues: ['0'] } },
      { label: 'Radio 2', mode: 'BTS', up: true, modeSource: { kind: 'template', template: '{m}', inputs: [{ name: 'm', oid: '.1.1.1.1.1.2.3' }] } },
    ],
  };
  const rec = (v) => ({ value: v, instances: [] });
  const key = (path, name) => `${HEADER_GROUP}::${paramId(path, name)}`;

  test('the polled inputs are listed once each, with their OIDs', () => {
    const ins = headerInputs(ui);
    expect(ins.map((i) => i.oid)).toEqual(expect.arrayContaining(['.7', '.1', '.1.3.6.1.2.1.1.3', '.1.1.1.1.1.2.2', '.1.1.1.1.1.33.2']));
    expect(new Set(ins.map((i) => i.parameterId)).size).toBe(ins.length);
  });

  test('a CPE reports its own serial, uptime and radio roles — nothing from the design sample', () => {
    const values = {
      [key('productName', 'm')]: rec('UBR660'), [key('versionLine', 'fw')]: rec('1.0.0-183'), [key('versionLine', 'sn')]: rec('2641XCT000DK'),
      [key('uptime', 't')]: rec('8640000'),
      [key('radios.0.mode', 'm')]: rec('sta'), [key('radios.0.up', 'status')]: rec('0'),
      [key('radios.1.mode', 'm')]: rec('ap'), [key('radios.1.up', 'status')]: rec('1'),
    };
    const h = resolveHeader(ui, values);
    expect(h.versionLine).toBe('1.0.0-183 SNo. 2641XCT000DK');
    expect(h.uptime).toBe('1d 0h 0m 0s');
    expect(h.radios).toEqual([{ label: 'Radio 1', mode: 'CPE', up: true }, { label: '2.4 GHz', mode: 'AP', up: false }]);   // no Radio 2 on this device
  });

  test('no data yet: a sourced item is null (shown as "—"), never the sample text', () => {
    const h = resolveHeader(ui, {});
    expect(h.versionLine).toBeNull();
    expect(h.uptime).toBeNull();
    expect(h.radios).toEqual([]);
  });

  test('an item with no source keeps its typed text', () => {
    expect(resolveHeader({ productName: 'UBR660' }, {}).productName).toBe('UBR660');
  });
});

describe('OIDs typed with the scalar instance', () => {
  test('sysUpTime.0 is polled as the object OID (the poll adds the instance itself)', () => {
    const ins = headerInputs({ sources: { uptime: { kind: 'calc', expr: '{t}/100', inputs: [{ name: 't', oid: '.1.3.6.1.2.1.1.3.0' }] } } });
    expect(ins.map((i) => i.oid)).toEqual(['.1.3.6.1.2.1.1.3']);
  });
  test('an object OID is left alone', () => {
    expect(headerInputs({ sources: { uptime: { kind: 'calc', expr: '{t}', inputs: [{ name: 't', oid: '.1.3.6.1.2.1.1.3' }] } } })[0].oid).toBe('.1.3.6.1.2.1.1.3');
  });
});

describe('templates with calculations, fallbacks, empty markers and strip (device-UI composites)', () => {
  const ch = { kind: 'template', template: '{ch} ( [[5950 + 5*{ch}]] MHz )', fallback: '{ch}', inputs: [{ name: 'ch', map: { auto: 'Auto' } }] };
  test('Configured Channel: 77 → "77 ( 6335 MHz )", auto → "Auto"', () => {
    expect(computeSource(ch, { ch: '77' }).text).toBe('77 ( 6335 MHz )');
    expect(computeSource(ch, { ch: 'auto' }).text).toBe('Auto');
  });
  test('Active Channel from two values', () => {
    const s = { kind: 'template', template: '{c} ( {f} MHz )', inputs: [{ name: 'c' }, { name: 'f' }] };
    expect(computeSource(s, { c: '77', f: '6335' }).text).toBe('77 ( 6335 MHz )');
    expect(computeSource(s, { c: '0', f: '-1' }).ok).toBe(false);          // -1 = no value → never "0 ( -1 MHz )"
  });
  test('CPU / Memory and Speed / Duplex', () => {
    expect(computeSource({ kind: 'template', template: '( {cpu} / {mem} ) %', inputs: [{ name: 'cpu' }, { name: 'mem' }] }, { cpu: '67.60', mem: '26' }).text).toBe('( 67.60 / 26 ) %');
    expect(computeSource({ kind: 'template', template: 'Up {sp} - {du}', inputs: [{ name: 'sp' }, { name: 'du' }] }, { sp: '1000(Mbps)', du: 'full' }).text).toBe('Up 1000(Mbps) - full');
  });
  test('inline formatting: [[expr|format|decimals]]', () => {
    expect(computeSource({ kind: 'template', template: '[[{t}/100|duration]]', inputs: [{ name: 't' }] }, { t: '12695600' }).text).toBe('1d 11h 15m 56s');
    expect(computeSource({ kind: 'template', template: '[[{b}/1000000|none|2]] Mbps', inputs: [{ name: 'b' }] }, { b: '224000' }).text).toBe('0.22 Mbps');
  });
  test('empty markers are "no value" (the device shows "-"), but a real zero is a value', () => {
    for (const m of ['-1', '-NA-', 'NA', '-', '', '  ']) expect(computeSource({ kind: 'template', template: '{v}', inputs: [{ name: 'v' }] }, { v: m }).ok).toBe(false);
    expect(computeSource({ kind: 'template', template: '{v}', inputs: [{ name: 'v' }] }, { v: '0' }).text).toBe('0');
    expect(computeSource({ kind: 'template', template: '{v}', inputs: [{ name: 'v', emptyValues: [] }] }, { v: '-1' }).text).toBe('-1');   // opt out
  });
  test('strip removes a pattern, e.g. the time zone name in the clock', () => {
    const s = { kind: 'template', template: '{t}', inputs: [{ name: 't', strip: ' [A-Z]{2,4}(?= \\d{4}$)' }] };
    expect(computeSource(s, { t: 'Sun Nov 15 14:26:33 IST 2026' }).text).toBe('Sun Nov 15 14:26:33 2026');
  });
  test('derived values: a calculated field can be a template', () => {
    const { applyDerivedValues, helperId } = require('../../src/live/derivedValues');
    const groups = [{ groupId: 'g', parameters: [
      { parameterId: 'chan', valueSource: 'calc', calc: { template: '{c} ( {f} MHz )', inputs: [{ name: 'c', oid: '.1' }, { name: 'f', oid: '.2' }] } },
      { parameterId: helperId('chan', 'c'), hidden: true }, { parameterId: helperId('chan', 'f'), hidden: true }] }];
    const v = { [`g::${helperId('chan', 'c')}`]: { value: '77', instances: [] }, [`g::${helperId('chan', 'f')}`]: { value: '6335', instances: [] } };
    applyDerivedValues(groups, v);
    expect(v['g::chan'].display).toBe('77 ( 6335 MHz )');
  });
});

describe('conditional text in a template (Speed / Duplex only while the link is up)', () => {
  const sd = { kind: 'template', template: '<<st=Up|Up {sp} - {du}|Down>>', inputs: [{ name: 'st' }, { name: 'sp' }, { name: 'du' }] };
  test('up: "Up 1000(Mbps) - full"; down: "Down" even though the agent still reports a speed', () => {
    expect(computeSource(sd, { st: 'Up', sp: '1000(Mbps)', du: 'full' }).text).toBe('Up 1000(Mbps) - full');
    expect(computeSource(sd, { st: 'Down', sp: '10(Mbps)', du: 'half' }).text).toBe('Down');
  });
  test('the status missing altogether takes the else branch', () => {
    expect(computeSource(sd, { sp: '10(Mbps)', du: 'half' }).text).toBe('Down');
  });
  test('GPS: both values empty → the fallback "- -"', () => {
    const gps = { kind: 'template', template: '{lat} {lon}', fallback: '- -', inputs: [{ name: 'lat' }, { name: 'lon' }] };
    expect(computeSource(gps, { lat: '-NA-', lon: '-NA-' }).text).toBe('- -');
    expect(computeSource(gps, { lat: '12.9', lon: '77.5' }).text).toBe('12.9 77.5');
  });
});

describe('descriptor schema: emptyValues is opt-in', () => {
  test('a field that never set emptyValues does not store an empty list (which would mean "show -1 / -NA- as they are")', () => {
    const UiDescriptor = require('../../src/models/uiDescriptor.model');
    const d = new UiDescriptor({ descriptorId: 'x', screenName: 'S', sections: [{ sectionId: 's', title: 't', fields: [{ fieldId: 'f', elementType: 'field-label', label: 'L' }] }] });
    expect(d.sections[0].fields[0].emptyValues).toBeUndefined();
    const withOwn = new UiDescriptor({ descriptorId: 'y', screenName: 'S', sections: [{ sectionId: 's', title: 't', fields: [{ fieldId: 'f', elementType: 'field-label', label: 'L', emptyValues: ['0'] }] }] });
    expect(Array.from(withOwn.sections[0].fields[0].emptyValues)).toEqual(['0']);
  });
});

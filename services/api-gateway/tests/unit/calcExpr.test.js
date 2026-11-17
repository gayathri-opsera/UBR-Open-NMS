'use strict';
const { evaluate, referencedInputs, formatNumber, computeField, duration } = require('../../src/live/calcExpr');
const { applyDerivedValues, helperId } = require('../../src/live/derivedValues');

describe('calcExpr', () => {
  test('arithmetic, precedence, parentheses', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('-4 + 10 % 4')).toBe(-2);
    expect(evaluate('{a} / 100', { a: 250 })).toBe(2.5);
  });
  test('functions and comparisons', () => {
    expect(evaluate('round({x}, 1)', { x: 3.14159 })).toBe(3.1);
    expect(evaluate('max(1, {a}, 3)', { a: 9 })).toBe(9);
    expect(evaluate('if({a} > 5, 1, 0)', { a: 7 })).toBe(1);
    expect(evaluate('floor(7.9) + ceil(0.1) + abs(-2)')).toBe(10);
  });
  test('rejects anything that is not the language', () => {
    for (const bad of ['process.exit()', 'constructor', '{a', '1 +', 'foo(1)', '1; 2', '__proto__', '"x"']) {
      expect(() => evaluate(bad, { a: 1 })).toThrow();
    }
  });
  test('missing input and division by zero are errors, not NaN', () => {
    expect(() => evaluate('{a} + 1')).toThrow(/no value for \{a\}/);
    expect(() => evaluate('1 / 0')).toThrow(/division by zero/);
  });
  test('referencedInputs', () => {
    expect(referencedInputs('{up} / 100 + {x}').sort()).toEqual(['up', 'x']);
  });
  test('duration formats', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59)).toBe('59s');
    expect(duration(3 * 3600 + 5 * 60 + 7)).toBe('3h 5m 7s');
    expect(duration(86400 * 1 + 11 * 3600 + 15 * 60 + 56)).toBe('1d 11h 15m 56s');
    expect(duration(86400 + 11 * 3600 + 15 * 60 + 56, true)).toBe('1d 11h 15m');
  });
  test('other formats', () => {
    expect(formatNumber(1536, 'bytes')).toBe('1.50 KB');
    expect(formatNumber(12.345, 'percent')).toBe('12.3%');
    expect(formatNumber(2400190000, 'mbps')).toBe('2400.19 Mbps');
    expect(formatNumber(3.14159, 'none', 2)).toBe('3.14');
  });
  test('uptime from sysUpTime ticks (the motivating example)', () => {
    const spec = { expr: '{ticks} / 100', format: 'duration', inputs: [{ name: 'ticks', oid: '.1.3.6.1.2.1.1.3.0' }] };
    // 1d 11h 15m 56s = 126956 s = 12695600 ticks
    expect(computeField(spec, { ticks: '12695600' })).toEqual({ ok: true, value: 126956, text: '1d 11h 15m 56s' });
    expect(computeField(spec, { ticks: 'n/a' }).ok).toBe(false);
  });
});

describe('applyDerivedValues', () => {
  const groups = [{ groupId: 'g', parameters: [
    { parameterId: 'Product', valueSource: 'static', staticValue: 'UBR660' },
    { parameterId: 'Uptime', valueSource: 'calc', calc: { expr: '{t}/100', format: 'duration', inputs: [{ name: 't', oid: '.1.3.6.1.2.1.1.3.0' }] } },
    { parameterId: helperId('Uptime', 't'), hidden: true, snmpOid: '.1.3.6.1.2.1.1.3.0' },
  ] }];
  test('fills fixed text and calculated values', () => {
    const v = { [`g::${helperId('Uptime', 't')}`]: { value: null, instances: [{ index: '', value: '8640000' }] } };
    applyDerivedValues(groups, v);
    expect(v['g::Product'].display).toBe('UBR660');
    expect(v['g::Uptime'].display).toBe('1d 0h 0m 0s');
    expect(v['g::Uptime'].readStatus).toBe('SUCCESS');
  });
  test('a calculated field with no input value reports FAILED, never a made-up number', () => {
    const v = {};
    applyDerivedValues(groups, v);
    expect(v['g::Uptime'].freshnessState).toBe('FAILED');
    expect(v['g::Uptime'].display).toBeNull();
  });
});

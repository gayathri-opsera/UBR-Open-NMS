'use strict';
const { isPattern, expandPattern } = require('../../src/utils/scopePattern');

describe('isPattern', () => {
  test.each(['10.0.150.*', '10.0.*.*', '10.0.*', '10.*', '*.*.*.*', '10.0.150.1-50', '10.0.140-150.*',
    '10.0.150.1-10.0.150.50'])('%s is a pattern', (v) => expect(isPattern(v)).toBe(true));
  test.each(['10.0.150.1', '10.0.0.0/24', 'router.example.com', '', '10.0.150', 'a.b.c.*', '10.0.150.*/24'])(
    '%s is not', (v) => expect(isPattern(v)).toBe(false));
});

describe('expandPattern', () => {
  test('last-octet wildcard gives .1–.254 and includes .112', () => {
    const ips = expandPattern('10.0.150.*');
    expect(ips).toHaveLength(254);
    expect(ips[0]).toBe('10.0.150.1');
    expect(ips).toContain('10.0.150.112');
    expect(ips).not.toContain('10.0.150.0');
    expect(ips).not.toContain('10.0.150.255');
  });
  test('two wildcards = full /16 host set', () => expect(expandPattern('10.0.*.*')).toHaveLength(256 * 254));
  test('short form 10.0.* equals 10.0.*.*', () => expect(expandPattern('10.0.*')).toHaveLength(256 * 254));
  test('octet range inclusive', () => expect(expandPattern('10.0.150.110-113'))
    .toEqual(['10.0.150.110', '10.0.150.111', '10.0.150.112', '10.0.150.113']));
  test('range + wildcard mix', () => {
    const ips = expandPattern('10.0.149-150.*');
    expect(ips).toHaveLength(2 * 254);
    expect(ips).toContain('10.0.149.7');
    expect(ips).toContain('10.0.150.7');
  });
  test('wildcard in a middle octet', () => {
    expect(expandPattern('10.*.150.5', { max: 1000 })).toHaveLength(256);
  });
  test('full range crosses octet boundary', () => {
    expect(expandPattern('10.0.150.254-10.0.151.2'))
      .toEqual(['10.0.150.254', '10.0.150.255', '10.0.151.0', '10.0.151.1', '10.0.151.2']);
  });
  test('rejects reversed ranges', () => {
    expect(() => expandPattern('10.0.150.50-10')).toThrow(/start/);
    expect(() => expandPattern('10.0.150.9-10.0.150.1')).toThrow(/start/);
  });
  test('rejects octets above 255', () => {
    expect(() => expandPattern('10.0.150.200-300')).toThrow(/255/);
    expect(() => expandPattern('10.0.150.1-10.0.150.300')).toThrow(/255/);
  });
  test('rejects oversize expansions', () => {
    expect(() => expandPattern('10.*.*.*')).toThrow(/max/);
    expect(() => expandPattern('*.*.*.*')).toThrow(/max/);
  });
});

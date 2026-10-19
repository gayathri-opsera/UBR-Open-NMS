'use strict';
/**
 * Newer UBR650/655 firmware serves the same MIB under .1.3.6.1.4.1.14125.123 instead of
 * .1.3.6.1.4.1.52619 (verified on 10.0.150.12 / .16 vs .6). The product definition keeps describing
 * the product once; these helpers address each device under the root it really serves.
 */
const { aliasOfDevice, canonicalOid, rebaseOid, rebaseEntries } = require('../../src/live/oidAliases');

const OLD = '.1.3.6.1.4.1.52619';
const NEW = '.1.3.6.1.4.1.14125.123';

describe('canonicalOid (what discovery compares against fingerprints)', () => {
  test('a sysObjectID on the new root maps to the canonical root', () => {
    expect(canonicalOid('1.3.6.1.4.1.14125.123')).toBe(OLD);
    expect(canonicalOid('.1.3.6.1.4.1.14125.123.5')).toBe(`${OLD}.5`);
  });
  test('canonical and unrelated OIDs are only normalised', () => {
    expect(canonicalOid('1.3.6.1.4.1.52619')).toBe(OLD);
    expect(canonicalOid('1.3.6.1.4.1.9.1.1')).toBe('.1.3.6.1.4.1.9.1.1');
  });
  test('does not swallow a longer arc that merely starts with the same digits', () => {
    expect(canonicalOid('1.3.6.1.4.1.14125.1234')).toBe('.1.3.6.1.4.1.14125.1234');
  });
  test('empty input is returned as is', () => {
    expect(canonicalOid(null)).toBeNull();
    expect(canonicalOid('')).toBe('');
  });
});

describe('rebaseOid (how a device is addressed)', () => {
  test('swaps the root for a device on the new tree', () => {
    expect(rebaseOid(`${OLD}.1.2.3.1.0`, '1.3.6.1.4.1.14125.123')).toBe(`${NEW}.1.2.3.1.0`);
    expect(rebaseOid('1.3.6.1.4.1.52619.1.1.1.1.1.2.1', '.1.3.6.1.4.1.14125.123')).toBe(`${NEW}.1.1.1.1.1.2.1`);
  });
  test('leaves a canonical-root device (e.g. firmware 1.0.0.149) untouched', () => {
    expect(rebaseOid(`${OLD}.1.2.3.1.0`, '1.3.6.1.4.1.52619')).toBe(`${OLD}.1.2.3.1.0`);
  });
  test('leaves standard MIB-II OIDs and unknown devices untouched', () => {
    expect(rebaseOid('1.3.6.1.2.1.1.5.0', '1.3.6.1.4.1.14125.123')).toBe('.1.3.6.1.2.1.1.5.0');
    expect(rebaseOid(`${OLD}.1`, '1.3.6.1.4.1.9.1.1')).toBe(`${OLD}.1`);
    expect(rebaseOid(`${OLD}.1`, undefined)).toBe(`${OLD}.1`);
  });
});

describe('rebaseEntries', () => {
  const entries = [
    { parameterId: 'ssid', snmpOid: `${OLD}.1.1.1.1.1.3.2` },
    { parameterId: 'noOid', snmpOid: null },
  ];
  test('rewrites OIDs for the new-root device without mutating the registry', () => {
    const out = rebaseEntries(entries, '1.3.6.1.4.1.14125.123');
    expect(out[0].snmpOid).toBe(`${NEW}.1.1.1.1.1.3.2`);
    expect(out[1].snmpOid).toBeNull();
    expect(entries[0].snmpOid).toBe(`${OLD}.1.1.1.1.1.3.2`);
  });
  test('returns the very same array when nothing changes', () => {
    expect(rebaseEntries(entries, '1.3.6.1.4.1.52619')).toBe(entries);
  });
});

test('aliasOfDevice', () => {
  expect(aliasOfDevice('1.3.6.1.4.1.14125.123')).not.toBeNull();
  expect(aliasOfDevice('1.3.6.1.4.1.52619')).toBeNull();
  expect(aliasOfDevice(null)).toBeNull();
});

'use strict';

/**
 * Unit tests for src/live/deviceFacts.js (inventory facts collected at discovery).
 * Fixtures mirror the real EOC UBR655 at 10.0.150.88.
 */

const { parseFacts, formatMac, networkIdFor, inventoryFields } = require('../../src/live/deviceFacts');

const E = '.1.3.6.1.4.1.52619';
const SYS = '.1.3.6.1.2.1.1';
const IFT = '.1.3.6.1.2.1.2.2.1';
const IFX = '.1.3.6.1.2.1.31.1.1.1';
const IPA = '.1.3.6.1.2.1.4.20.1';

const vb = (oid, value, hex) => ({ oid, value: String(value), ...(hex ? { hex } : {}) });

const walk = [
  vb(`${SYS}.3.0`, '35809370'),                       // 4 days, 3:28:13.70 in ticks
  vb(`${SYS}.4.0`, 'bofh@example.com'),
  // ifTable: lo, eth0, eth1, br-lan (27)
  vb(`${IFT}.2.1`, 'lo'),      vb(`${IFT}.6.1`, '', ''),
  vb(`${IFT}.2.3`, 'eth0'),    vb(`${IFT}.5.3`, '1000000000'), vb(`${IFT}.6.3`, '', '88dc971fe21d'), vb(`${IFT}.7.3`, '1'), vb(`${IFT}.8.3`, '1'),
  vb(`${IFT}.2.4`, 'eth1'),    vb(`${IFT}.5.4`, '10000000'),   vb(`${IFT}.6.4`, '', '88dc971fe21e'), vb(`${IFT}.7.4`, '1'), vb(`${IFT}.8.4`, '2'),
  vb(`${IFT}.2.27`, 'br-lan'), vb(`${IFT}.6.27`, '', '88dc971fe21d'), vb(`${IFT}.8.27`, '1'),
  vb(`${IFX}.1.27`, 'br-lan'), vb(`${IFX}.15.3`, '1000'),
  // ipAddrTable
  vb(`${IPA}.2.10.0.150.88`, '27'), vb(`${IPA}.3.10.0.150.88`, '255.255.255.0'),
  vb(`${IPA}.2.127.0.0.1`, '1'),
  // vendor objects (some placeholders), plus secrets that must never be copied
  vb(`${E}.1.2.3.1.0`, '2381XC71DRXD'),
  vb(`${E}.1.2.2.4.0`, '1.0.0.149'),
  vb(`${E}.1.2.3.9.0`, 'v2.0.0'),
  vb(`${E}.1.2.3.15.0`, '1.3'),
  vb(`${E}.1.2.3.16.0`, 'UBR655'),
  vb(`${E}.1.2.13.3.0`, 'SECRET-READ-COMMUNITY'),
  vb(`${E}.1.2.13.6.0`, 'SECRET-WRITE-COMMUNITY'),
];

describe('formatMac', () => {
  it('formats 6 bytes as lower-case colon-separated hex', () => {
    expect(formatMac('88DC971FE21D')).toBe('88:dc:97:1f:e2:1d');
  });
  it('rejects empty, wrong-length and all-zero values', () => {
    expect(formatMac('')).toBeNull();
    expect(formatMac(undefined)).toBeNull();
    expect(formatMac('88dc')).toBeNull();
    expect(formatMac('000000000000')).toBeNull();
  });
});

describe('networkIdFor', () => {
  it('uses the /24 prefix, matching the provisioning convention', () => {
    expect(networkIdFor('10.0.150.88')).toBe('net-10-0-150');
    expect(networkIdFor('not-an-ip')).toBeNull();
  });
});

describe('parseFacts', () => {
  const f = parseFacts(walk, { managementIp: '10.0.150.88', sysObjectID: '1.3.6.1.4.1.52619' });

  it('takes the management MAC from the interface that carries the management IP', () => {
    expect(f.macAddress).toBe('88:dc:97:1f:e2:1d');
    expect(f.managementInterface).toBe('br-lan');
  });
  it('converts sysUpTime ticks to seconds', () => {
    expect(f.uptimeSeconds).toBe(358093);
  });
  it('reads standard system data', () => {
    expect(f.sysContact).toBe('bofh@example.com');
  });
  it('lists interfaces with MAC, speed and status; skips MAC-less ones as null', () => {
    const eth0 = f.interfaces.find((i) => i.name === 'eth0');
    expect(eth0).toMatchObject({ index: 3, macAddress: '88:dc:97:1f:e2:1d', speedMbps: 1000, adminStatus: 'up', operStatus: 'up' });
    expect(f.interfaces.find((i) => i.name === 'eth1').operStatus).toBe('down');
    expect(f.interfaces.find((i) => i.name === 'lo').macAddress).toBeNull();
    expect(f.interfaces.map((i) => i.index)).toEqual([1, 3, 4, 27]);
  });
  it('attaches IP addresses to their interface', () => {
    expect(f.interfaces.find((i) => i.name === 'br-lan').ipAddresses).toEqual(['10.0.150.88']);
    expect(f.ipAddresses).toEqual(expect.arrayContaining([{ address: '10.0.150.88', netmask: '255.255.255.0', ifIndex: 27 }]));
  });
  it('reads the curated vendor facts for the matching enterprise', () => {
    expect(f).toMatchObject({
      serialNumber: '2381XC71DRXD', firmwareVersion: '1.0.0.149',
      hardwareVersion: 'v2.0.0', bootloaderVersion: '1.3', modelName: 'UBR655',
    });
  });
  it('never copies secrets exposed in the vendor subtree', () => {
    expect(JSON.stringify(f)).not.toMatch(/SECRET/);
  });
  it('ignores vendor facts for other enterprises and drops "-NA-" placeholders', () => {
    const other = parseFacts(walk, { managementIp: '10.0.150.88', sysObjectID: '1.3.6.1.4.1.9' });
    expect(other.serialNumber).toBeUndefined();
    const na = parseFacts([...walk, vb(`${E}.1.2.3.15.0`, '-NA-')].filter((v, i, a) => !(v.oid === `${E}.1.2.3.15.0` && a.findIndex((x) => x.oid === v.oid) === i)),
      { managementIp: '10.0.150.88', sysObjectID: '1.3.6.1.4.1.52619' });
    expect(na.bootloaderVersion).toBeUndefined();
  });
  it('leaves the MAC empty when the management IP is not on any known interface', () => {
    expect(parseFacts(walk, { managementIp: '192.0.2.1' }).macAddress).toBeNull();
  });
});

describe('inventoryFields', () => {
  it('returns only fields the device reported, plus a collection timestamp', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const out = inventoryFields({ macAddress: '88:dc:97:1f:e2:1d', serialNumber: 'ABC', interfaces: [], hardwareVersion: undefined }, now);
    expect(out).toEqual({ macAddress: '88:dc:97:1f:e2:1d', reportedSerialNumber: 'ABC', factsCollectedAt: now });
  });
  it('returns nothing when no facts were collected', () => {
    expect(inventoryFields(null)).toEqual({});
  });
});

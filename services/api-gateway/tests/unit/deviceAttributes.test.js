'use strict';
/**
 * Device-reported role / GPS (JS port of discovery-service device_attributes.go).
 * The role must come from what the device says, not from guesses on sysDescr.
 */

jest.mock('../../src/live/snmpWalk', () => ({ walkSubtree: jest.fn() }));

const {
  fetchDeviceAttributes, normaliseRole, parseCoordinate, parseLocationCoordinates, matchAttributeProfile,
} = require('../../src/live/deviceAttributes');

const ROLE_OID = '.1.3.6.1.4.1.52619.1.1.1.1.1.2';
const ENUM = { 1: 'BTS', 2: 'CPE' };

describe('normaliseRole', () => {
  test.each([
    ['ap', 'BTS'], ['AP', 'BTS'], ['BTS(ap)', 'BTS'], ['access point', 'BTS'], ['master', 'BTS'],
    ['sta', 'CPE'], ['CPE(sta)', 'CPE'], ['station', 'CPE'], ['slave', 'CPE'],
    ['idu', 'IDU'], ['1', 'BTS'], ['2', 'CPE'],
  ])('%s → %s', (raw, role) => expect(normaliseRole(raw, ENUM)).toBe(role));

  test.each([['', ''], ['3', ''], ['mesh', ''], [null, ''], [undefined, '']])(
    'unrecognised %p stays empty (never guessed)', (raw, role) => expect(normaliseRole(raw, ENUM)).toBe(role));
});

describe('coordinates', () => {
  test('decimal, hemisphere suffix, NMEA and scaled integers', () => {
    expect(parseCoordinate('28.6139', 0, 90)).toBeCloseTo(28.6139);
    expect(parseCoordinate('28.6139S', 0, 90)).toBeCloseTo(-28.6139);
    expect(parseCoordinate('2836.834N', 0, 90)).toBeCloseTo(28 + 36.834 / 60);
    expect(parseCoordinate('286139000', 1e7, 90)).toBeCloseTo(28.6139);
  });
  test('out of range or non-numeric → null', () => {
    expect(parseCoordinate('95.1', 0, 90)).toBeNull();
    expect(parseCoordinate('abc', 0, 90)).toBeNull();
    expect(parseCoordinate('', 0, 90)).toBeNull();
  });
  test('sysLocation pair is parsed only when both numbers have a fraction', () => {
    expect(parseLocationCoordinates('28.6139,77.2090')).toEqual({ latitude: 28.6139, longitude: 77.209 });
    expect(parseLocationCoordinates('lat:28.61 lng:77.20')).toEqual({ latitude: 28.61, longitude: 77.2 });
    expect(parseLocationCoordinates('office')).toBeNull();
    expect(parseLocationCoordinates('Floor 2, Room 5')).toBeNull();
  });
});

describe('matchAttributeProfile', () => {
  test('matches the enterprise OID itself and anything beneath it', () => {
    expect(matchAttributeProfile('1.3.6.1.4.1.52619')).not.toBeNull();
    expect(matchAttributeProfile('.1.3.6.1.4.1.52619.1.1')).not.toBeNull();
    expect(matchAttributeProfile('1.3.6.1.4.1.526190')).toBeNull();
    expect(matchAttributeProfile('1.3.6.1.4.1.9.1.1')).toBeNull();
  });
});

describe('fetchDeviceAttributes', () => {
  const noGet = async () => ({});

  test('UBR655 reports "ap" in the radio table column → BTS, with its source OID', async () => {
    // exactly what 10.0.150.6 returns: nothing at the bare/.0 OID, "ap" at .1
    const io = {
      get: async (oids) => (oids.includes(`${ROLE_OID}.1`) ? { [`${ROLE_OID}.1`]: 'ap' } : {}),
      walk: async () => [],
    };
    const a = await fetchDeviceAttributes({ host: 'h', sysObjectID: '1.3.6.1.4.1.52619', sysLocation: 'office', io });
    expect(a.role).toBe('BTS');
    expect(a.roleSource).toBe(`snmp ${ROLE_OID}.1=ap`);
    expect(a.latitude).toBeNull();           // "office" is not a coordinate → nothing invented
  });

  test('falls back to a subtree walk when the GETs find nothing', async () => {
    const io = { get: noGet, walk: async () => [{ oid: `${ROLE_OID}.3`, value: 'sta' }] };
    const a = await fetchDeviceAttributes({ host: 'h', sysObjectID: '1.3.6.1.4.1.52619.1.2', io });
    expect(a.role).toBe('CPE');
  });

  test('vendor without a profile → no role (the caller keeps its own classification)', async () => {
    const io = { get: async () => { throw new Error('must not be called'); }, walk: async () => { throw new Error('must not be called'); } };
    const a = await fetchDeviceAttributes({ host: 'h', sysObjectID: '1.3.6.1.4.1.9.1.1', sysLocation: '', io });
    expect(a.role).toBe('');
  });

  test('SNMP failures leave the fields empty instead of throwing', async () => {
    const io = { get: async () => { throw new Error('timeout'); }, walk: async () => { throw new Error('timeout'); } };
    const a = await fetchDeviceAttributes({ host: 'h', sysObjectID: '1.3.6.1.4.1.52619', io });
    expect(a).toMatchObject({ role: '', roleSource: '', latitude: null, longitude: null, locationSource: '' });
  });

  test('GPS written into sysLocation is used and labelled as such', async () => {
    const io = { get: noGet, walk: async () => [] };
    const a = await fetchDeviceAttributes({ host: 'h', sysObjectID: '1.3.6.1.4.1.9.1.1', sysLocation: '28.6139,77.2090', io });
    expect(a).toMatchObject({ latitude: 28.6139, longitude: 77.209, locationSource: 'sysLocation' });
  });
});

describe('role from the radio-mode column (multi-radio units)', () => {
  const colOf = (root, modes) => modes.map((m, i) => ({ oid: `${root}.${i + 1}`, value: m }));
  const run = (sysObjectID, root, modes) => {
    const walk = jest.fn(async () => colOf(root, modes));
    return fetchDeviceAttributes({ host: 'h', sysObjectID, io: { get: async () => ({}), walk } }).then((a) => ({ a, walk }));
  };

  // values read off the real units: 10.0.150.6 (BTS) and 10.0.150.16 / .12 (CPEs, web UI mode "sta")
  test('all radios AP → BTS (10.0.150.6)', async () => {
    const { a } = await run('1.3.6.1.4.1.52619', ROLE_OID, ['ap', 'ap', 'ap']);
    expect(a.role).toBe('BTS');
    expect(a.roleSource).toBe(`snmp ${ROLE_OID}.1=ap (radios: 1=ap, 2=ap, 3=ap)`);
  });

  test('a station radio next to the 2.4 GHz management AP → CPE (10.0.150.16)', async () => {
    const root = '.1.3.6.1.4.1.14125.123.1.1.1.1.1.2';
    const { a } = await run('1.3.6.1.4.1.14125.123', root, ['ap', 'sta', 'ap']);
    expect(a.role).toBe('CPE');
    expect(a.roleSource).toBe(`snmp ${root}.2=sta (radios: 1=ap, 2=sta, 3=ap)`);
  });

  test('two-radio CPE (10.0.150.12)', async () => {
    const { a } = await run('1.3.6.1.4.1.14125.123', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.2', ['ap', 'sta']);
    expect(a.role).toBe('CPE');
  });

  test('a device on the re-rooted tree is asked under ITS OWN root, not the canonical one', async () => {
    const { walk } = await run('1.3.6.1.4.1.14125.123', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.2', ['ap', 'sta']);
    expect(walk).toHaveBeenCalledWith('.1.3.6.1.4.1.14125.123.1.1.1.1.1.2');
  });

  test('a lone station radio → CPE; unrecognised values → no role', async () => {
    expect((await run('1.3.6.1.4.1.52619', ROLE_OID, ['sta'])).a.role).toBe('CPE');
    expect((await run('1.3.6.1.4.1.52619', ROLE_OID, ['mesh', ''])).a.role).toBe('');
  });
});

'use strict';
/**
 * Device-published GPS: read with plain GETs, "-NA-" means "no position", and a position the device
 * publishes replaces whatever is stored (manual / map / earlier reading) while an empty reading
 * leaves the stored one alone.
 */

const mockDevices = new Map(); // _id → device doc (shared by both databases)
const mockCol = {
  findOne: jest.fn(async (f) => mockDevices.get(f._id) || null),
  updateOne: jest.fn(async (f, u) => { Object.assign(mockDevices.get(f._id), u.$set); }),
};
jest.mock('mongoose', () => ({
  ...jest.requireActual('mongoose'),
  connection: { readyState: 1, db: { collection: () => mockCol }, client: { db: () => ({ collection: () => mockCol }) } },
}));
jest.mock('../../src/live/snmpWalk', () => ({
  walkSubtree: jest.fn(), getOids: jest.fn(), probeDevice: jest.fn(), isUnreachable: jest.fn(),
}));
jest.mock('../../src/live/deviceAttributes', () => ({
  ...jest.requireActual('../../src/live/deviceAttributes'),
  fetchDeviceGps: jest.fn(),
}));

const attrs = jest.requireActual('../../src/live/deviceAttributes');
const mockedAttrs = require('../../src/live/deviceAttributes');
const { applyDeviceGps } = require('../../src/live/liveParameters');

const EOC = '1.3.6.1.4.1.14125.123';
const LAT = '.1.3.6.1.4.1.14125.123.1.2.2.5.0';
const LNG = '.1.3.6.1.4.1.14125.123.1.2.2.6.0';

describe('fetchDeviceGps', () => {
  test('reads "17.431604 N" / "78.382536 E" published by the device', async () => {
    const get = jest.fn(async () => ({ [LAT]: '17.431604 N', [LNG]: '78.382536 E' }));
    const gps = await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: 'office', get });
    expect(gps).toEqual({ latitude: 17.431604, longitude: 78.382536, locationSource: `snmp ${LAT},${LNG}` });
    expect(get).toHaveBeenCalledTimes(1);               // one GET, no walk
  });

  test('southern / western hemisphere suffixes give negative coordinates', async () => {
    const get = async () => ({ [LAT]: '33.868800 S', [LNG]: '151.209300 W' });
    const gps = await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: '', get });
    expect(gps.latitude).toBeCloseTo(-33.8688);
    expect(gps.longitude).toBeCloseTo(-151.2093);
  });

  test('the "-NA-" placeholder of a unit without a fix is no position', async () => {
    const get = async () => ({ [LAT]: '-NA-', [LNG]: '-NA-' });
    expect(await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: 'office', get })).toBeNull();
  });

  test('0,0 and out-of-range values are rejected', async () => {
    expect(await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: '', get: async () => ({ [LAT]: '0.0', [LNG]: '0.0' }) })).toBeNull();
    expect(await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: '', get: async () => ({ [LAT]: '123.4', [LNG]: '10.0' }) })).toBeNull();
  });

  test('falls back to a coordinate pair published in sysLocation', async () => {
    const get = async () => ({ [LAT]: '-NA-', [LNG]: '-NA-' });
    const gps = await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: '17.4316,78.3825', get });
    expect(gps).toMatchObject({ latitude: 17.4316, longitude: 78.3825, locationSource: 'sysLocation' });
  });

  test('uses the management.gps pair (gpsLatitude/gpsLongitude) when sysInfo has none — in the same single GET', async () => {
    const aLat = '.1.3.6.1.4.1.14125.123.1.2.7.4.0'; const aLng = '.1.3.6.1.4.1.14125.123.1.2.7.5.0';
    const get = jest.fn(async () => ({ [LAT]: '-NA-', [LNG]: '-NA-', [aLat]: '17.431604 N', [aLng]: '78.382536 E' }));
    const gps = await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: 'office', get });
    expect(gps).toEqual({ latitude: 17.431604, longitude: 78.382536, locationSource: `snmp ${aLat},${aLng}` });
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('sysInfo wins over the gps group when both are present', async () => {
    const aLat = '.1.3.6.1.4.1.14125.123.1.2.7.4.0'; const aLng = '.1.3.6.1.4.1.14125.123.1.2.7.5.0';
    const get = async () => ({ [LAT]: '10.0', [LNG]: '20.0', [aLat]: '30.0', [aLng]: '40.0' });
    expect(await attrs.fetchDeviceGps({ host: 'h', sysObjectID: EOC, sysLocation: '', get })).toMatchObject({ latitude: 10, longitude: 20 });
  });

  test('works under the legacy 52619 enterprise root too', async () => {
    const lat = '.1.3.6.1.4.1.52619.1.2.2.5.0'; const lng = '.1.3.6.1.4.1.52619.1.2.2.6.0';
    const gps = await attrs.fetchDeviceGps({ host: 'h', sysObjectID: '1.3.6.1.4.1.52619', sysLocation: '', get: async () => ({ [lat]: '10.5', [lng]: '20.5' }) });
    expect(gps).toMatchObject({ latitude: 10.5, longitude: 20.5 });
  });
});

describe('applyDeviceGps — device GPS always wins', () => {
  const device = { _id: 'SN-1', ipAddress: '10.0.150.9', snmpCommunity: 'c', sysObjectID: EOC };
  beforeEach(() => { mockDevices.clear(); jest.clearAllMocks(); });

  test('replaces a position the admin picked on the map', async () => {
    mockDevices.set('SN-1', { _id: 'SN-1', latitude: 12.0, longitude: 77.0, locationSource: 'manual' });
    mockedAttrs.fetchDeviceGps.mockResolvedValue({ latitude: 17.431604, longitude: 78.382536, locationSource: 'snmp x' });
    expect(await applyDeviceGps(device)).toBe(true);
    expect(mockDevices.get('SN-1')).toMatchObject({ latitude: 17.431604, longitude: 78.382536, locationSource: 'snmp x' });
  });

  test('replaces a position typed in by hand', async () => {
    mockDevices.set('SN-1', { _id: 'SN-1', latitude: 1, longitude: 2, locationSource: 'manual' });
    mockedAttrs.fetchDeviceGps.mockResolvedValue({ latitude: 17.4, longitude: 78.3, locationSource: 'snmp x' });
    await applyDeviceGps(device);
    expect(mockDevices.get('SN-1').latitude).toBe(17.4);
  });

  test('a device that publishes nothing leaves the manual position alone', async () => {
    mockDevices.set('SN-1', { _id: 'SN-1', latitude: 12.0, longitude: 77.0, locationSource: 'manual' });
    mockedAttrs.fetchDeviceGps.mockResolvedValue(null);
    expect(await applyDeviceGps(device)).toBe(false);
    expect(mockDevices.get('SN-1')).toMatchObject({ latitude: 12.0, longitude: 77.0, locationSource: 'manual' });
    expect(mockCol.updateOne).not.toHaveBeenCalled();
  });

  test('an unchanged reading is not written again', async () => {
    mockDevices.set('SN-1', { _id: 'SN-1', latitude: 17.4, longitude: 78.3, locationSource: 'snmp x' });
    mockedAttrs.fetchDeviceGps.mockResolvedValue({ latitude: 17.4, longitude: 78.3, locationSource: 'snmp x' });
    expect(await applyDeviceGps(device)).toBe(false);
    expect(mockCol.updateOne).not.toHaveBeenCalled();
  });
});

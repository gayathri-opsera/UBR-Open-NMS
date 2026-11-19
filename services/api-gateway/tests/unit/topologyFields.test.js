'use strict';
const { resolveTopologyEntries, topologyKeys, topologyMetrics } = require('../../src/live/topologyFields');

const E = (parameterId, extra = {}) => ({ groupId: 'g1', parameterId, ...extra });

describe('topologyFields', () => {
  test('recognises fields by name without any marking', () => {
    const m = resolveTopologyEntries(['assocLocalSignalA1', 'assocLocalSignalA2', 'assocRemoteSignalA1', 'assocLocalSNRA1', 'wirelessActiveChannel', 'wirelessChannel', 'ethernetMACAddress', 'wirelessStatsAthMACAddress'].map((p) => E(p)));
    expect(m.get('a1Rssi').map((e) => e.parameterId)).toEqual(['assocLocalSignalA1']);
    expect(m.get('snr').map((e) => e.parameterId)).toEqual(['assocLocalSNRA1']);
    expect(m.get('channel').map((e) => e.parameterId)).toEqual(['wirelessActiveChannel']);
    expect(m.get('mac').map((e) => e.parameterId)).toEqual(['ethernetMACAddress']);
    expect(m.has('ethernetSpeed')).toBe(false);
  });
  test('an explicit topologyField wins over the name rules', () => {
    const m = resolveTopologyEntries([E('rssi'), E('linkQualityX', { topologyField: 'rssi' })]);
    expect(m.get('rssi').map((e) => e.parameterId)).toEqual(['linkQualityX']);
    expect(topologyKeys([E('linkQualityX', { topologyField: 'rssi' })]).has('g1::linkQualityX')).toBe(true);
  });
  test('metrics: best signal, channel of the signal radio, no invented values', () => {
    const map = resolveTopologyEntries([E('assocLocalSignalA1'), E('assocLocalSignalA2'), E('wirelessActiveChannel'), E('ethernetMACAddress')]);
    const values = [
      { groupId: 'g1', parameterId: 'assocLocalSignalA1', instances: [{ index: '2.1', raw: '-39' }, { index: '2.2', raw: '-45' }] },
      { groupId: 'g1', parameterId: 'assocLocalSignalA2', instances: [{ index: '2.1', raw: '-28' }] },
      { groupId: 'g1', parameterId: 'wirelessActiveChannel', instances: [{ index: '1', raw: '6' }, { index: '2', raw: '140' }] },
      { groupId: 'g1', parameterId: 'ethernetMACAddress', instances: [{ index: '', raw: '00:00:00:00:00:00' }] },
    ];
    expect(topologyMetrics(map, values)).toMatchObject({ rssi: -28, a1Rssi: -39, a2Rssi: -28, snr: null, operatingChannel: '140', macAddress: null, ethernetSpeed: null });
  });
  test('device with no readings gives all-null metrics', () => {
    expect(topologyMetrics(resolveTopologyEntries([]), [])).toMatchObject({ rssi: null, snr: null, operatingChannel: null });
  });
});

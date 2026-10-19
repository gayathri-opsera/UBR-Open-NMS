'use strict';
/**
 * A definition declares its OIDs once (canonical root). For a unit that serves the tree under the
 * re-rooted prefix, reads, facts and Apply must address THAT unit's OIDs.
 */
const { definitionForDevice, mapVarbinds, walkRoots } = require('../../src/live/liveParameters');
const { parseFacts } = require('../../src/live/deviceFacts');

const OLD = '.1.3.6.1.4.1.52619';
const NEW = '.1.3.6.1.4.1.14125.123';
const NEW_SYS = '1.3.6.1.4.1.14125.123';

const definition = {
  productDefinitionId: 'eoc-ubr655', versionId: 'v1',
  entries: [
    { groupId: 'radio', parameterId: 'ssid', dataType: 'string', snmpOid: `${OLD}.1.1.1.1.1.3` },
    { groupId: 'network', parameterId: 'ip', dataType: 'string', snmpOid: `${OLD}.1.1.2.2.0` },
  ],
};

describe('definitionForDevice', () => {
  test('returns the definition untouched for a device on the canonical root', () => {
    expect(definitionForDevice(definition, { sysObjectID: '1.3.6.1.4.1.52619' })).toBe(definition);
    expect(definitionForDevice(definition, {})).toBe(definition);
  });
  test('re-addresses every OID for a new-root device, leaving the registry copy alone', () => {
    const d = definitionForDevice(definition, { sysObjectID: NEW_SYS });
    expect(d.entries.map((e) => e.snmpOid)).toEqual([`${NEW}.1.1.1.1.1.3`, `${NEW}.1.1.2.2.0`]);
    expect(definition.entries[0].snmpOid).toBe(`${OLD}.1.1.1.1.1.3`);
    expect(d.productDefinitionId).toBe('eoc-ubr655');
  });
});

describe('reading a new-root unit', () => {
  test('the walk targets the unit\'s root and the values map back onto the definition parameters', () => {
    const entries = definitionForDevice(definition, { sysObjectID: NEW_SYS }).entries;
    expect(walkRoots(entries.map((e) => e.snmpOid))).toEqual([`${NEW}.1.1`]);

    // what 10.0.150.16 returns
    const varbinds = [
      { oid: `${NEW}.1.1.1.1.1.3.1`, value: 'UBRMGMT1FE1CB' },
      { oid: `${NEW}.1.1.1.1.1.3.2`, value: 'UBR655_R17' },
      { oid: `${NEW}.1.1.2.2.0`, value: '10.0.150.16' },
    ];
    const mapped = mapVarbinds(entries, varbinds);
    expect(mapped.get('radio::ssid').map((i) => i.raw)).toEqual(['UBRMGMT1FE1CB', 'UBR655_R17']);
    expect(mapped.get('network::ip')[0].raw).toBe('10.0.150.16');
  });

  test('without the mapping the same unit would read nothing (the original Node View symptom)', () => {
    const varbinds = [{ oid: `${NEW}.1.1.1.1.1.3.2`, value: 'UBR655_R17' }];
    const mapped = mapVarbinds(definition.entries, varbinds);
    expect(mapped.get('radio::ssid') || []).toHaveLength(0);
  });
});

describe('inventory facts of a new-root unit', () => {
  test('serial, firmware, model and bootloader are read from the unit\'s own root', () => {
    const v = (oid, value) => ({ oid, value });
    const facts = parseFacts([
      v(`${NEW}.1.2.3.1.0`, '2381XC81DRK8'),
      v(`${NEW}.1.2.2.4.0`, '1.0.0.164'),
      v(`${NEW}.1.2.3.9.0`, 'v4.0.0'),
      v(`${NEW}.1.2.3.15.0`, '1.4'),
      v(`${NEW}.1.2.3.16.0`, 'UBR655-C18'),
    ], { managementIp: '10.0.150.16', sysObjectID: NEW_SYS });
    expect(facts).toMatchObject({
      serialNumber: '2381XC81DRK8', firmwareVersion: '1.0.0.164', hardwareVersion: 'v4.0.0',
      bootloaderVersion: '1.4', modelName: 'UBR655-C18',
    });
  });
  test('old-root unit unchanged', () => {
    const facts = parseFacts([{ oid: `${OLD}.1.2.3.1.0`, value: '2381XC71DRXD' }], { sysObjectID: '1.3.6.1.4.1.52619' });
    expect(facts.serialNumber).toBe('2381XC71DRXD');
  });
});

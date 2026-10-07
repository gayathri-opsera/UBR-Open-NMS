'use strict';

const { parseEnumOptions } = require('../../src/live/enumOptions');
const { planChange, validateValue, targetOid } = require('../../src/live/parameterWrite');
const { setValues, writeCommunityFor } = require('../../src/live/snmpSet');
const { buildWireframe, deduplicateIds } = require('../../src/live/wireframeBuilder');
const live = require('../../src/live/liveParameters');

describe('parseEnumOptions', () => {
  it('reads Label(raw) pairs', () => {
    expect(parseEnumOptions(['Enable(0)', 'Disable(1)'])).toEqual([
      { value: '0', label: 'Enable' }, { value: '1', label: 'Disable' },
    ]);
  });
  it('splits joined options and keeps text raw values', () => {
    expect(parseEnumOptions(['Enable(1)/Disable(0)'])).toEqual([
      { value: '1', label: 'Enable' }, { value: '0', label: 'Disable' },
    ]);
    expect(parseEnumOptions(['AES-256(psk2+ccmp-256)/None(none)']).map((o) => o.value)).toEqual(['psk2+ccmp-256', 'none']);
    expect(parseEnumOptions(['Access(1)Trunk(2)']).map((o) => o.value)).toEqual(['1', '2']);
    expect(parseEnumOptions(['0x8100(0x0081)'])).toEqual([{ value: '0x0081', label: '0x8100' }]);
  });
  it('keeps entries without a raw value as label = value and drops duplicates', () => {
    expect(parseEnumOptions(['Auto', 'Auto'])).toEqual([{ value: 'Auto', label: 'Auto' }]);
  });
  it('never invents options', () => {
    expect(parseEnumOptions(undefined)).toEqual([]);
    expect(parseEnumOptions([''])).toEqual([]);
  });
});

describe('parameter write validation', () => {
  const def = {
    entries: [
      { groupId: 'wireless', parameterId: 'radioStatus', dataType: 'ENUM', uiWidget: 'dropdown', enumValues: ['Enable(0)', 'Disable(1)'], snmpOid: '.1.3.6.1.4.1.52619.1.1.1.1.1.33', readOnly: false },
      { groupId: 'wireless', parameterId: 'maximumSus', dataType: 'INTEGER', minValue: 1, maxValue: 32, snmpOid: '.1.3.6.1.4.1.52619.1.1.1.1.1.37', readOnly: false },
      { groupId: 'network', parameterId: 'gateway', dataType: 'IPADDRESS', snmpOid: '.1.3.6.1.4.1.52619.1.1.2.4.0', readOnly: false },
      { groupId: 'wireless', parameterId: 'key', dataType: 'STRING', minValue: 8, maxValue: 63, snmpOid: '.1.3.6.1.4.1.52619.1.1.1.1.1.17', readOnly: false },
      { groupId: 'monitor', parameterId: 'crcErrors', dataType: 'STRING', snmpOid: '.1.3.6.1.4.1.52619.1.3.1.1.28', readOnly: true },
      { groupId: 'wireless', parameterId: 'ofdma', dataType: 'ENUM', uiWidget: 'dropdown', enumValues: ['Enable(1)'], readOnly: false },
    ],
  };
  const plan = (c) => planChange(def, c);

  it('accepts a declared option and addresses the instance OID', () => {
    const r = plan({ groupId: 'wireless', parameterId: 'radioStatus', instance: '2', value: '1' });
    expect(r.ok).toBe(true);
    expect(r.oid).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.33.2');
  });
  it('rejects values outside the options / range / type', () => {
    expect(plan({ groupId: 'wireless', parameterId: 'radioStatus', instance: '1', value: '7' }).ok).toBe(false);
    expect(plan({ groupId: 'wireless', parameterId: 'maximumSus', instance: '1', value: '33' }).error).toMatch(/at most 32/);
    expect(plan({ groupId: 'wireless', parameterId: 'maximumSus', instance: '1', value: 'abc' }).error).toMatch(/whole number/);
    expect(plan({ groupId: 'network', parameterId: 'gateway', instance: '', value: '10.0.0.999' }).error).toMatch(/IPv4/);
    expect(plan({ groupId: 'wireless', parameterId: 'key', instance: '1', value: 'short' }).error).toMatch(/at least 8/);
  });
  it('rejects anything the definition does not make writable', () => {
    expect(plan({ groupId: 'monitor', parameterId: 'crcErrors', instance: '1', value: '0' }).code).toBe('NOT_WRITABLE');
    expect(plan({ groupId: 'wireless', parameterId: 'ofdma', instance: '1', value: '1' }).code).toBe('NOT_WRITABLE'); // no OID
    expect(plan({ groupId: 'wireless', parameterId: 'nope', instance: '1', value: '1' }).code).toBe('UNKNOWN_PARAMETER');
    expect(plan({ groupId: 'wireless', parameterId: 'radioStatus', instance: '1; rm', value: '1' }).code).toBe('VALIDATION_ERROR');
  });
  it('addresses a scalar with .0 exactly once', () => {
    expect(targetOid({ snmpOid: '.1.3.6.1.4.1.52619.1.1.2.4.0' }, '')).toBe('.1.3.6.1.4.1.52619.1.1.2.4.0');
    expect(targetOid({ snmpOid: '.1.3.6.1.4.1.52619.1.1.2.4' }, '')).toBe('.1.3.6.1.4.1.52619.1.1.2.4.0');
  });
  it('validateValue enforces the definition even without options', () => {
    expect(validateValue({ dataType: 'STRING' }, 5)).toMatch(/string/);
  });
});

describe('snmpSet', () => {
  const T = { Integer: 2, OctetString: 4, IpAddress: 64 };
  const fakeSnmp = (typesByOid, setLog) => ({
    ObjectType: T, Version2c: 1,
    isVarbindError: (vb) => vb.type === 'err',
    varbindError: () => 'boom',
    createSession: () => ({
      get: (oids, cb) => cb(null, [typesByOid[oids[0]] ? { oid: oids[0], type: typesByOid[oids[0]] } : { oid: oids[0], type: 'err' }]),
      set: (vbs, cb) => { setLog.push(vbs[0]); cb(null, [{ oid: vbs[0].oid, type: vbs[0].type }]); },
      close: () => {},
    }),
  });

  it('refuses to run without a write community', async () => {
    await expect(setValues({ host: 'h', community: '', items: [] })).rejects.toMatchObject({ code: 'WRITE_NOT_CONFIGURED' });
  });
  it('encodes with the type the device reports and attributes failures per OID', async () => {
    const log = [];
    const snmp = fakeSnmp({ '1.2.3': T.Integer, '1.2.4': T.OctetString }, log);
    const r = await setValues({
      host: 'h', community: 'w', snmp,
      items: [{ oid: '.1.2.3', value: '7' }, { oid: '.1.2.4', value: 'abc' }, { oid: '.1.2.9', value: '1' }, { oid: '.1.2.3', value: 'x' }],
    });
    expect(r.map((x) => x.ok)).toEqual([true, true, false, false]);
    expect(log[0].value).toBe(7);
    expect(Buffer.isBuffer(log[1].value)).toBe(true);
    expect(r[2].error).toMatch(/does not exist/);
    expect(r[3].error).toMatch(/whole number/);
  });
  it('picks the write community from the device, then the environment, never the read community', () => {
    expect(writeCommunityFor({ snmpCommunity: 'ro' }, {})).toBeNull();
    expect(writeCommunityFor({ snmpWriteCommunity: 'dev' }, { SNMP_WRITE_COMMUNITY: 'env' })).toBe('dev');
    expect(writeCommunityFor({}, { SNMP_WRITE_COMMUNITY: 'env' })).toBe('env');
  });
});

describe('SNMP instance indexes', () => {
  const entry = { groupId: 'g', parameterId: 'mtu', snmpOid: '.1.5.3' };
  it('a lone .0 is a scalar (no index)', () => {
    const m = live.mapVarbinds([entry], [{ oid: '.1.5.3.0', value: '1500' }]);
    expect(m.get('g::mtu')).toEqual([{ index: '', raw: '1500' }]);
  });
  it('.0 and .1 are two rows of a table and both keep their index', () => {
    const m = live.mapVarbinds([entry], [{ oid: '.1.5.3.0', value: '1500' }, { oid: '.1.5.3.1', value: '9000' }]);
    expect(m.get('g::mtu')).toEqual([{ index: '0', raw: '1500' }, { index: '1', raw: '9000' }]);
  });
});

describe('wireframe hierarchy and ids', () => {
  const entries = [
    { groupId: 'network', groupDisplayOrder: 2, subGroup: 'ip', parameterId: 'ipAddress', displayName: 'IP Address', displayOrder: 1, snmpOid: '.1.2.0' },
    { groupId: 'network', groupDisplayOrder: 2, subGroup: 'dhcp', parameterId: 'ipAddress', displayName: 'IP Address', displayOrder: 2, snmpOid: '.1.9.0' },
    { groupId: 'wireless', groupDisplayOrder: 1, subGroup: 'properties', parameterId: 'zeta', displayName: 'Zeta', displayOrder: 1, enumValues: ['On(1)', 'Off(0)'] },
    { groupId: 'wireless', groupDisplayOrder: 1, subGroup: 'properties', parameterId: 'alpha', displayName: 'Alpha', displayOrder: 2 },
    { groupId: 'wireless', groupDisplayOrder: 1, subGroup: 'ddrs', parameterId: 'key', displayName: 'Key', displayOrder: 3 },
  ];

  it('orders groups, sub-groups and parameters as the definition does (not alphabetically)', () => {
    const { wireframe } = buildWireframe({ productDefinitionId: 'x', versionId: 'v', registryVersion: '1', entries });
    expect(wireframe.groups.map((g) => g.groupId)).toEqual(['wireless', 'network']);
    expect(wireframe.groups[0].subGroups).toEqual(['properties', 'ddrs']);
    expect(wireframe.groups[0].parameters.map((p) => p.parameterId)).toEqual(['zeta', 'alpha', 'key']);
    expect(wireframe.groups[0].parameters[0].options).toEqual([{ value: '1', label: 'On' }, { value: '0', label: 'Off' }]);
  });
  it('flags credential-like parameters as sensitive', () => {
    const { wireframe } = buildWireframe({ productDefinitionId: 'x', versionId: 'v', registryVersion: '1', entries });
    const byId = Object.fromEntries(wireframe.groups[0].parameters.map((p) => [p.parameterId, p]));
    expect(byId.key.sensitive).toBe(true);
    expect(byId.alpha.sensitive).toBe(false);
  });
  it('gives repeated ids unique, stable names', () => {
    const ids = deduplicateIds(entries.slice(0, 2)).map((p) => p.parameterId);
    expect(ids).toEqual(['ip_ipAddress', 'dhcp_ipAddress']);
  });
  it('keeps the values of same-named parameters apart (blank-IP regression)', () => {
    const unique = live.dedupeEntries(entries.slice(0, 2).map((e, i) => ({ ...e, _id: i })));
    const mapped = live.mapVarbinds(unique, [
      { oid: '.1.2.0', value: '10.0.150.88' }, { oid: '.1.9.0', value: '192.168.2.100' },
    ]);
    expect(mapped.get('network::ip_ipAddress')).toEqual([{ index: '', raw: '10.0.150.88' }]);
    expect(mapped.get('network::dhcp_ipAddress')).toEqual([{ index: '', raw: '192.168.2.100' }]);
  });
});

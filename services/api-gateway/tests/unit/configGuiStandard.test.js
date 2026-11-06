'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { parseUpload } = require('../../src/routes/descriptors.routes');
const { buildWireframe } = require('../../src/live/wireframeBuilder');
const { mapVarbinds } = require('../../src/live/liveParameters');
const { rebaseEntries } = require('../../src/live/oidAliases');

const STANDARD = path.join(__dirname, '../../../../sample-definitions/Configurations_GUI_standard.xml');
const parsed = parseUpload(fs.readFileSync(STANDARD), 'Configurations_GUI_standard.xml');
const groups = [...parsed.config.groups, ...parsed.monitor.groups];
const entries = groups.flatMap((g) => g.parameters.map((p) => ({
  ...p, groupId: g.groupId, uiPage: g.uiPage, uiParent: g.uiParent, uiTab: g.uiTab,
})));
const oidOf = (groupId, id) => (entries.find((e) => e.groupId === groupId && e.parameterId === id) || {}).snmpOid;

describe('Configurations GUI standard XML', () => {
  it('is well-formed and read as the Configurations GUI format with its declared identity', () => {
    expect(parsed.sourceFormat).toBe('config-gui');
    expect(parsed.identity).toMatchObject({ vendor: 'EOC', model: 'UBR655', productFamily: 'UBR 650/655 Series' });
    expect(parsed.identity.variants).toEqual(['UBR655', 'EOC655']);
    expect(require('../../src/routes/descriptors.routes').__declaredIdentity(fs.readFileSync(STANDARD, 'utf8')).definitionId).toBe('eoc-ubr655');
    expect(parsed.identity.matchRules[0]).toMatchObject({ field: 'sysObjectId', op: 'prefix', value: '.1.3.6.1.4.1.52619' });
  });

  it('splits each multi-row column into Radio 1 / Radio 2 / 2.4 GHz by the declared instance map', () => {
    expect(oidOf('radio24.properties', 'radio24.properties.ssid')).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.1');
    expect(oidOf('radio1.properties', 'radio1.properties.ssid')).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.2');
    expect(oidOf('radio2.properties', 'radio2.properties.ssid')).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.3');
    // link-profile table: index is radio.1 (suffix), rows 2 / 3 only (2.4 GHz has no DDRS)
    expect(oidOf('radio1.ddrs', 'radio1.ddrs.ddrsStatus')).toBe('.1.3.6.1.4.1.52619.1.1.1.2.1.3.2.1');
    expect(oidOf('radio2.ddrs', 'radio2.ddrs.ddrsStatus')).toBe('.1.3.6.1.4.1.52619.1.1.1.2.1.3.3.1');
    expect(groups.find((g) => g.groupId === 'radio24.ddrs')).toBeUndefined();
    expect(oidOf('radio1.dcs', 'radio1.dcs.dcsStatus')).toBe('.1.3.6.1.4.1.52619.1.1.1.3.1.2.2');
    expect(oidOf('radio2.vlan', 'radio2.vlan.mode')).toBe('.1.3.6.1.4.1.52619.1.1.4.18.1.3.2');
    expect(oidOf('eth1.ethernet', 'eth1.ethernet.mtu')).toBe('.1.3.6.1.4.1.52619.1.1.5.6.1.4.2');
    expect(oidOf('radio1.wireless_stats', 'radio1.wireless_stats.txPps')).toBe('.1.3.6.1.4.1.52619.1.3.1.1.34.2');
    expect(oidOf('radio2.link_stats', 'radio2.link_stats.macAddress')).toBe('.1.3.6.1.4.1.52619.1.3.3.1.3.3');
  });

  it('builds the sidebar the device UI has and leaves scalar sections alone', () => {
    const where = (id) => { const g = groups.find((x) => x.groupId === id); return [g.uiPage, g.uiParent, g.uiTab]; };
    expect(where('radio1.properties')).toEqual(['Wireless', 'Radio 1', 'Properties']);
    expect(where('radio2.dcs')).toEqual(['Wireless', 'Radio 2', 'DCS']);
    expect(where('radio24.wireless_stats')).toEqual(['Monitor', '2.4 GHz Radio', 'Wireless Stats']);
    expect(where('radio1.vlan')).toEqual(['Network', 'VLAN', 'Radio 1']);
    expect(where('network-ipconfiguration')).toEqual(['Network', 'IP Configuration', 'IPv4']);
    expect(oidOf('network-ipconfiguration', 'ipAddress')).toBe('.1.3.6.1.4.1.52619.1.1.2.2.0');
  });

  it('produces a wireframe with no validation errors (widgets the Node View understands)', () => {
    const { validationErrors } = buildWireframe({ productDefinitionId: 'gui', versionId: 'v1', entries });
    expect(validationErrors).toEqual([]);
  });

  it('fills every radio from a real-shaped walk, one value per radio (no stacked rows)', () => {
    const base = '.1.3.6.1.4.1.14125.123';            // re-rooted firmware
    const vbs = [
      { oid: `${base}.1.1.1.1.1.3.1`, value: 'mgmt-ssid' },
      { oid: `${base}.1.1.1.1.1.3.2`, value: 'oct21' },
      { oid: `${base}.1.1.1.1.1.3.3`, value: 'UBR655_R2' },
      { oid: `${base}.1.3.1.1.8.2`, value: '123456' },
    ];
    const mapped = mapVarbinds(rebaseEntries(entries, base), vbs);
    const one = (g, id) => (mapped.get(`${g}::${id}`) || []).map((i) => i.raw);
    expect(one('radio24.properties', 'radio24.properties.ssid')).toEqual(['mgmt-ssid']);
    expect(one('radio1.properties', 'radio1.properties.ssid')).toEqual(['oct21']);
    expect(one('radio2.properties', 'radio2.properties.ssid')).toEqual(['UBR655_R2']);
    expect(one('radio1.wireless_stats', 'radio1.wireless_stats.txUnicastPackets')).toEqual(['123456']);
  });

  it('still reads the original single-module client file unchanged (backward compatible)', () => {
    const src = '<Wireless>\n<Properties>\n<parameter name="SSID" id="ssid"><dataType>string</dataType><uiWidget>textfield</uiWidget><oid>.1.3.6.1.4.1.52619.1.1.1.1.1.3</oid><readOnly>false</readOnly></parameter>\n</Properties>\n</Wireless>';
    const p = parseUpload(Buffer.from(src), 'old.xml');
    expect(p.config.groups).toHaveLength(1);
    expect(p.config.groups[0].groupId).toBe('wireless-properties');
    expect(p.config.groups[0].parameters[0].snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3');
  });

  it('has unique parameter ids across radios and numeric limits (no validator errors or duplicate-id warnings)', () => {
    const ids = entries.map((e) => `${e.groupId}::${e.parameterId}`);
    const seen = new Set(); const dup = [];
    for (const e of entries) { if (seen.has(e.parameterId)) dup.push(e.parameterId); seen.add(e.parameterId); }
    expect(dup).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    const key = entries.find((e) => e.parameterId === 'radio1.properties.key');
    expect(key.minValue).toBe(8);
    expect(key.maxValue).toBe(63);
  });

  it('gives Ethernet speed an Auto Negotiation(0) choice so raw 0 reads as a label, not a bare number', () => {
    const speed = entries.find((e) => e.parameterId === 'eth1.ethernet.speedDuplex');
    expect(speed.enumValues).toEqual(expect.arrayContaining(['Auto Negotiation(0)', '100-Full(4)', '1000-Full(5)', '2500-Full(7)']));
    const { resolveDisplay } = require('../../src/live/liveParameters');
    expect(resolveDisplay(speed, '0')).toBe('Auto Negotiation(0)');
  });

  it('numbers parameters from 1 so the first one (Radio status) is not sorted to the end', () => {
    const g = groups.find((x) => x.groupId === 'radio1.properties');
    expect(g.parameters[0].displayName).toBe('Radio status');
    expect(g.parameters.map((p) => p.displayOrder)).toEqual(g.parameters.map((_, i) => i + 1));
    expect(entries.filter((e) => e.groupId === 'network-ipconfiguration')[0].displayOrder).toBe(1);
  });
});

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { parseUpload } = require('../../src/routes/descriptors.routes');
const { buildWireframe } = require('../../src/live/wireframeBuilder');

const FILE = path.join(__dirname, '../../../../sample-definitions/ubr655-descriptor.xml');
const parsed = parseUpload(fs.readFileSync(FILE), 'ubr655-descriptor.xml');

// Same shape the activate handler writes to parameter_registry_entries.
const entries = [...parsed.config.groups, ...parsed.monitor.groups].flatMap((g) =>
  g.parameters.map((p) => ({
    productDefinitionId: 'ubr655', versionId: 'v1', ...p, groupId: g.groupId,
    groupDisplayOrder: g.displayOrder, uiPage: g.uiPage, uiParent: g.uiParent, uiTab: g.uiTab,
  })));

const { wireframe, validationErrors } = buildWireframe({ productDefinitionId: 'ubr655', versionId: 'v1', entries });
const tree = {};
for (const g of wireframe.groups) ((tree[g.uiPage] ||= {})[g.uiParent] ||= []).push(g.uiTab);
const param = (id) => entries.find((e) => e.parameterId === id);

describe('ubr655-descriptor.xml', () => {
  it('parses and carries the declared sidebar placement', () => {
    expect(parsed.isNmsFormat).toBe(false);
    expect(parsed.identity.matchRules[0]).toMatchObject({ field: 'sysObjectId', value: '.1.3.6.1.4.1.52619' });
    expect(parsed.config.groups.every((g) => g.uiPage && g.uiParent && g.uiTab)).toBe(true);
  });

  it('builds Radio 1 / Radio 2 / 2.4 GHz under Wireless', () => {
    expect(Object.keys(tree.Wireless)).toEqual(['Radio 1', 'Radio 2', '2.4 GHz Radio']);
    expect(tree.Wireless['Radio 1']).toEqual(['Properties', 'DDRS/ATPC', 'DFS', 'DCS']);
    expect(tree.Wireless['Radio 2']).toEqual(['Properties', 'DDRS/ATPC', 'DFS', 'DCS']);
    expect(tree.Wireless['2.4 GHz Radio']).toEqual(['Properties']);
    expect(tree.Network.VLAN).toEqual(['Radio 1', 'Radio 2']);
    expect(tree.Network['IP Configuration']).toEqual(['5 GHz Radio', '2.4 GHz Radio']);
    expect(Object.keys(tree.Monitor)).toEqual(['Radio 1', 'Radio 2', '2.4 GHz Radio']);
  });

  it('gives each radio its own OID instance on the real EnGenius enterprise', () => {
    expect(param('config.radio24.properties.ssid').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.1');
    expect(param('config.radio1.properties.ssid').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.2');
    expect(param('config.radio2.properties.ssid').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.1.1.3.3');
    // linkProfileTable / dcsTable use the same instance numbering as wirelessTable: 2 = Radio 1, 3 = Radio 2
    // (verified on UBR655 hardware; instance 1 = 2.4 GHz has no DDRS/DCS).
    expect(param('config.radio1.ddrs.ddrs_status').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.2.1.3.2.1');
    expect(param('config.radio2.ddrs.ddrs_status').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.2.1.3.3.1');
    expect(param('config.radio1.dcs.dcs_status').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.3.1.2.2');
    expect(param('config.radio2.dcs.dcs_status').snmpOid).toBe('.1.3.6.1.4.1.52619.1.1.1.3.1.2.3');
    expect(entries.filter((e) => e.snmpOid).every((e) => e.snmpOid.startsWith('.1.3.6.1.4.1.52619.1.'))).toBe(true);
  });

  it('keeps OIDs unique per parameter and flags only OFDMA as unmapped', () => {
    const oids = entries.filter((e) => e.snmpOid).map((e) => e.snmpOid);
    expect(new Set(oids).size).toBe(oids.length);
    expect(entries.filter((e) => !e.snmpOid).map((e) => e.parameterId))
      .toEqual(['config.radio1.properties.ofdma', 'config.radio2.properties.ofdma', 'config.radio24.properties.ofdma']);
  });

  it('produces dropdown options the Apply path can SET', () => {
    expect(param('config.radio1.properties.radio_status').enumValues).toEqual(['Enable(0)', 'Disable(1)']);
    expect(param('config.radio1.properties.dl_ul_ratio').enumValues).toContain('75:25(75)');
    expect(param('config.radio1.properties.key').isSecret).toBe(true);
  });

  it('has no wireframe validation errors', () => {
    expect(validationErrors).toEqual([]);
  });
});

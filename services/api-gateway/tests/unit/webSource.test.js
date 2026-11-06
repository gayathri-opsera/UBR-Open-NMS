'use strict';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ws = require('../../src/live/webSource');
const { encrypt } = require('../../src/utils/aesEncrypt');

const HTML = `
  const values = {
    "wireless.wifi1.linktype":
      "3",
    "wireless.@wifi-iface[1].ssid":
      "oct21",
    "advwireless.ath1.channel":
      "140",
    "vlan.ath1.svlanethertype":
      "0x0081",
    "vlan.ath1.svlan":
      "100",
  };
  const param_elements = {
    "wireless.wifi1.linktype": { 1: "PTP", 3: "PTMP" },
    // a comment
    "ath1qos.qoscfg.dlulratio": { 0: "Auto", 75: "75/25" },
  };`;
const config = { values: ws.parseValues(HTML), elements: ws.parseElements(HTML) };
const e = (groupId, displayName) => ({ groupId, parameterId: `x.${displayName}`, displayName });

describe('webSource parsing and formatting', () => {
  it('parses the page values and option labels', () => {
    expect(ws.parseValues(HTML)['wireless.@wifi-iface[1].ssid']).toBe('oct21');
    expect(ws.parseElements(HTML)['wireless.wifi1.linktype']).toEqual({ 1: 'PTP', 3: 'PTMP' });
  });
  it('formats like the device UI', () => {
    expect(ws.prefixToMask(24)).toBe('255.255.255.0');
    expect(ws.etherType('0x0081')).toBe('0x8100');
    expect(ws.channelLabel(1, '140')).toBe('140 ( 5700 MHz )');
    expect(ws.mbps('40820')).toBe('0.04');
    expect(ws.uptime(151320)).toBe('01:18:02:00');
  });
});

describe('webSource.valueFor (rules keyed by field label)', () => {
  it('maps radio, VLAN and statistics fields to what the device shows', () => {
    const src = { config, stats: { 2: { tx_pkts: '187096', tx_tput: '42107', g_chanutil: '2 %' } } };
    expect(ws.valueFor(e('radio1.properties', 'LinkType'), src)[0].display).toBe('PTMP');
    expect(ws.valueFor(e('radio1.properties', 'SSID'), src)[0]).toMatchObject({ display: 'oct21', web: true });
    expect(ws.valueFor(e('radio1.properties', 'Configured channel'), src)[0].display).toBe('140 ( 5700 MHz )');
    expect(ws.valueFor(e('radio1.vlan', 'SVLAN ID'), src)[0].display).toBe('100');
    expect(ws.valueFor(e('radio1.vlan', 'SVLAN EtherType'), src)[0].display).toBe('0x8100');
    expect(ws.valueFor(e('radio2.wireless_stats', 'Total Tx packets'), src)[0].display).toBe('187096');
    expect(ws.valueFor(e('radio2.wireless_stats', 'Tx Throughput'), src)[0].display).toBe('0.04');
    expect(ws.valueFor(e('radio2.wireless_stats', 'Channel Utilisation (Combined)'), src)[0].display).toBe('2');
  });
  it('says "no client associated" for an empty link table and never invents values', () => {
    expect(ws.valueFor(e('radio2.link_stats', 'MAC Address'), { links: { 2: null } })[0].display).toBe('No client associated');
    expect(ws.valueFor(e('radio1.properties', 'SSID'), { config: { values: {} } })).toBeUndefined();
  });
});

describe('webSource.overlay (fill-only)', () => {
  const entries = [{ groupId: 'radio1.properties', parameterId: 'a', displayName: 'SSID' },
    { groupId: 'radio1.properties', parameterId: 'b', displayName: 'LinkType' },
    { groupId: 'radio1.properties', parameterId: 'c', displayName: 'Country' }];
  it('fills missing and placeholder answers but never overwrites a real SNMP value', () => {
    const mapped = new Map([
      ['radio1.properties::a', [{ index: '', raw: 'from-snmp' }]],
      ['radio1.properties::b', [{ index: '', raw: '-1', placeholder: true }]],
    ]);
    const n = ws.overlay(entries, mapped, { config });
    expect(mapped.get('radio1.properties::a')[0].raw).toBe('from-snmp');
    expect(mapped.get('radio1.properties::b')[0]).toMatchObject({ display: 'PTMP', web: true });
    expect(n).toBe(1);   // Country has no value on the page
  });
});

describe('webSource.credentialsFor (per device)', () => {
  it('uses only the device\'s own stored, encrypted login', () => {
    expect(ws.credentialsFor({})).toBeNull();
    expect(ws.credentialsFor({ webCredentials: { username: 'u' } })).toBeNull();
    const dev = { webCredentials: { username: 'develop', password: encrypt('s3cret') } };
    expect(ws.credentialsFor(dev)).toEqual({ user: 'develop', pass: 's3cret' });
    expect(JSON.stringify(dev.webCredentials.password)).not.toContain('s3cret');
  });
});

describe('webSource Bandwidth follows the control the device page shows', () => {
  const bw = (mode, extra = {}) => ws.valueFor(e('radio1.properties', 'Bandwidth'), { config: { values: {
    'wireless.@wifi-iface[1].mode': mode, 'wireless.wifi1.htmode': 'HT20', 'advwireless.ath1.force_bw': '0', ...extra }, elements: {} } });
  it('AP / BTS radio shows the channel width', () => { expect(bw('ap')[0].display).toBe('20 MHz'); });
  it('STA / CPE radio shows Force Bandwidth (Auto / 20 / 40 / 80 MHz)', () => {
    expect(bw('sta')[0].display).toBe('Auto');
    expect(bw('sta', { 'advwireless.ath1.force_bw': '40' })[0].display).toBe('40 MHz');
  });
});

describe('webSource.roleFromHeader (the role the device itself shows)', () => {
  it('BTS when the backhaul radios are BTS, CPE when any is CPE, "" when unknown', () => {
    expect(ws.roleFromHeader({ radio0: 'AP', radio1: 'BTS', radio2: 'BTS' })).toBe('BTS');
    expect(ws.roleFromHeader({ radio0: 'AP', radio1: 'CPE', radio2: 'BTS' })).toBe('CPE');
    expect(ws.roleFromHeader({ radio0: 'AP' })).toBe('');
    expect(ws.roleFromHeader(null)).toBe('');
  });
});

describe('webSource DDRS / ATPC / DFS / DCS rules', () => {
  const html = (rates) => `var mcs_data_rates = "${rates}";`;
  // 0..11 single, 12..23 dual (MCS0..11 again), as the device page builds them
  const rates = Array.from({ length: 26 }, (_, i) => `${i % 12} ( ${(i + 1) * 10} Mbps )`).join(',');
  const config = { values: {
    'txparam.ath1.ddrsstatus': '1', 'txparam.ath1.spatialstream': '3', 'txparam.ath1.ddrsrate': '3', 'txparam.ath1.maxsinglemcs': '11',
    'txparam.ath1.maxdualmcs': '20', 'txparam.ath1.atpcstatus': '0', 'txparam.ath1.atpcpower': '26', 'wireless.wifi1.staDFSEn': '1',
    'advwireless.ath1.dcsstatus': '0', 'advwireless.ath1.dcsthrld': '25', 'advwireless.ath1.bgscan': '0',
  }, elements: {}, mcs: { 1: ws.mcsSets(html(rates)) } };
  const v = (sec, label) => (ws.valueFor({ groupId: `radio1.${sec}`, displayName: label }, { config }) || [{}])[0].display;
  it('maps the status, power, DFS and DCS fields', () => {
    expect(v('ddrs', 'DDRS Status')).toBe('Enable');
    expect(v('ddrs', 'Spatial Stream ( DDRS Status is enabled )')).toBe('Auto');
    expect(v('atpc', 'ATPC Status')).toBe('Disable');
    expect(v('atpc', 'Transmit Power')).toBe('26');
    expect(v('dfs', 'DFS Status')).toBe('Enable');
    expect(v('dcs', 'RTX Threshold')).toBe('25');
    expect(v('dcs', 'Background Scan')).toBe('Disable');
  });
  it('builds MCS labels like the page: dual set for the max data rate, first option when the value is not offered', () => {
    expect(v('ddrs', 'Max. Data Rate - Single Stream')).toMatch(/^MCS11 /);
    expect(v('ddrs', 'Max. Data Rate - Dual Stream')).toMatch(/^MCS8 /);       // index 20 → MCS(20-12)
    expect(v('ddrs', 'Modulation Index')).toMatch(/^MCS0 /);                    // value 3 is not a dual index → first option
  });
});

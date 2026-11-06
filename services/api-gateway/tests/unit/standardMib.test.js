'use strict';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const mib = require('../../src/live/standardMib');
const { parseUpload } = require('../../src/routes/descriptors.routes');
const { buildCurrentResponse } = require('../../src/live/liveParameters');

// A fake agent: answers only the OIDs asked for, and counts requests (the footprint must stay tiny).
const agent = (calls) => async ({ oids }) => {
  calls.push(oids);
  const answers = {
    '.1.3.6.1.2.1.4.20.1.1.10.0.150.108': '10.0.150.108', '.1.3.6.1.2.1.4.20.1.3.10.0.150.108': '255.255.255.0',
    '.1.3.6.1.2.1.4.20.1.2.10.0.150.108': '21', '.1.3.6.1.2.1.4.21.1.7.0.0.0.0': '10.0.150.254', '.1.3.6.1.2.1.2.2.1.4.21': '1500',
  };
  return Object.fromEntries(oids.filter((o) => answers[o]).map((o) => [o, answers[o]]));
};

describe('standardMib (single GETs, never a walk)', () => {
  it('answers IP, mask, gateway and the management interface MTU with two small GETs', async () => {
    const calls = [];
    const d = await mib.read({ host: '10.0.150.108', community: 'c' }, agent(calls));
    expect(d).toEqual({ address: '10.0.150.108', mask: '255.255.255.0', gateway: '10.0.150.254', mtu: '1500' });
    expect(calls).toHaveLength(2);                         // never more than two requests
    expect(calls.every((c) => c.length <= 4)).toBe(true);  // and never a table
    const v = (s) => mib.valueFor({ source: s }, d)[0].display;
    expect([v('ip.address'), v('ip.netmask'), v('ip.gateway'), v('mgmt.mtu')]).toEqual(['10.0.150.108', '255.255.255.0', '10.0.150.254', '1500']);
  });

  it('caches for a minute, ignores a 0.0.0.0 gateway and unknown sources', async () => {
    const calls = [];
    await mib.read({ host: '10.0.150.108', community: 'c' }, agent(calls));   // cached from the previous test
    expect(calls).toHaveLength(0);
    expect(mib.valueFor({ source: 'ip.gateway' }, { gateway: null })).toBeUndefined();
    expect(mib.valueFor({ source: 'nope' }, { address: 'x' })).toBeUndefined();
  });

  it('fills only fields without a real value (placeholders are replaced, real SNMP values are kept)', async () => {
    const entries = [{ groupId: 'g', parameterId: 'gw', fallback: { source: 'ip.gateway' } }, { groupId: 'g', parameterId: 'real', fallback: { source: 'ip.gateway' } }];
    const mapped = new Map([['g::gw', [{ index: '', raw: '0.0.0.0', placeholder: true }]], ['g::real', [{ index: '', raw: '1.2.3.4' }]]]);
    const n = await mib.overlay(entries, mapped, { host: '10.0.150.108', community: 'c' }, agent([]));
    expect(n).toBe(1);
    expect(mapped.get('g::gw')[0]).toMatchObject({ display: '10.0.150.254', src: 'standard-mib' });
    expect(mapped.get('g::real')[0].raw).toBe('1.2.3.4');
  });
});

describe('standard XML declares the fallbacks and the response names the source', () => {
  const file = path.join(__dirname, '../../../../sample-definitions/Configurations_GUI_standard.xml');
  const parsed = parseUpload(fs.readFileSync(file), 'x.xml');
  const entries = [...parsed.config.groups, ...parsed.monitor.groups].flatMap((g) => g.parameters.map((p) => ({ ...p, groupId: g.groupId })));
  it('declares IP, mask, gateway and MTU fallbacks (nothing that needs a table walk)', () => {
    const fb = entries.filter((e) => e.fallback).map((e) => e.fallback.source);
    expect(new Set(fb)).toEqual(new Set(['ip.address', 'ip.netmask', 'ip.gateway', 'mgmt.mtu']));
    expect(entries.find((e) => e.parameterId === 'eth1.ethernet.mtu').fallback).toEqual({ source: 'mgmt.mtu' });
  });
  it('reports a precomputed value as SUCCESS with its source (read-only on screen)', () => {
    const e = { groupId: 'g', parameterId: 'ip', displayName: 'IP Address', snmpOid: '.1.3.6.1.4.1.1.1', dataType: 'IPADDRESS' };
    const body = buildCurrentResponse({ device: { _id: 'd' }, definition: { productDefinitionId: 'p', registryVersion: '1', entries: [e] },
      doc: { pollStatus: 'OK', collectedAt: new Date(), values: [{ groupId: 'g', parameterId: 'ip', instances: [{ index: '', raw: '10.0.150.108', display: '10.0.150.108', src: 'standard-mib' }] }] } });
    expect(body.data.groups[0].parameters[0]).toMatchObject({ readStatus: 'SUCCESS', display: '10.0.150.108', source: 'standard-mib' });
  });
});

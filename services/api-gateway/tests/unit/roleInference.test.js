'use strict';

const { inferRoleFromLink } = require('../../src/live/deviceAttributes');

const ROOT = '.1.3.6.1.4.1.14125.123';                    // re-rooted firmware
const partners = (n2, n3) => ({ [`${ROOT}.1.3.1.1.3.2`]: String(n2), ...(n3 == null ? {} : { [`${ROOT}.1.3.1.1.3.3`]: String(n3) }) });
// fake network: ip → partner counts, and the peer ip a single-uplink unit reports
const net = { '10.0.0.1': partners(2), '10.0.0.2': partners(1), '10.0.0.3': partners(1), '10.0.0.9': partners(1) };
const peers = { '10.0.0.2': '10.0.0.1', '10.0.0.3': '10.0.0.1', '10.0.0.9': '10.0.0.8' };
net['10.0.0.8'] = partners(1);
const io = (host) => ({
  getFor: (h) => async () => net[h] || {},
  walk: async () => (peers[host] ? [{ oid: `${ROOT}.1.3.3.1.4.2.1`, value: peers[host] }] : []),
});
const infer = (host, sysObjectID = ROOT) => inferRoleFromLink({ host, community: 'c', sysObjectID, io: io(host) });

describe('inferRoleFromLink (no credentials, small GETs, never guessed)', () => {
  it('two or more associated stations → BTS', async () => {
    expect(await infer('10.0.0.1')).toMatchObject({ role: 'BTS' });
  });
  it('a single uplink to a unit that serves several stations → CPE', async () => {
    const r = await infer('10.0.0.2');
    expect(r.role).toBe('CPE');
    expect(r.source).toMatch(/inferred.*10\.0\.0\.1/);
  });
  it('a lone 1:1 link cannot be decided → unknown', async () => {
    expect(await infer('10.0.0.9')).toBeNull();
  });
  it('unknown enterprise or unreadable counters → unknown', async () => {
    expect(await infer('10.0.0.1', '.1.3.6.1.4.1.9')).toBeNull();
    expect(await inferRoleFromLink({ host: 'x', community: 'c', sysObjectID: ROOT, io: { getFor: () => async () => ({}) } })).toBeNull();
  });
});

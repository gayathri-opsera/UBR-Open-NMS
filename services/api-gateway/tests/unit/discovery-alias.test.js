'use strict';
/**
 * Discovery of units on the re-rooted enterprise tree (UBR650/655 firmware 1.0.0.163/.164 report
 * sysObjectID .1.3.6.1.4.1.14125.123), and the SNMP GET that must survive a lost datagram.
 */

global.__fpEntries = [];
global.__fpCol = {
  find: jest.fn(() => ({ toArray: async () => global.__fpEntries })),
  findOne: jest.fn(async () => null),
};

jest.mock('mongoose', () => {
  const real = jest.requireActual('mongoose');
  return {
    ...real,
    connection: { readyState: 1, db: { collection: () => global.__fpCol }, client: { db: () => ({ collection: () => global.__fpCol }) } },
    createConnection: jest.fn().mockReturnValue({
      asPromise: jest.fn().mockResolvedValue({ db: { collection: () => global.__fpCol } }),
    }),
  };
});

const dgram = require('dgram');
const { classifyByOid, matchesTemplateFingerprints, snmpGet, discoveryWindowMs } = require('../../src/routes/discovery.stub');

const UBR655_FP = {
  fingerprintType: 'SNMP_OID', fingerprintValue: '.1.3.6.1.4.1.52619', matchOp: 'prefix',
  productDefinitionId: 'eoc-ubr655', vendor: 'EOC', model: 'UBR655',
};

describe('template filter', () => {
  test('a unit on the new enterprise root matches the definition fingerprint (it used to be "excluded")', () => {
    expect(matchesTemplateFingerprints({ sysObjectID: '1.3.6.1.4.1.14125.123', sysDescr: 'Linux UBR655' }, [UBR655_FP])).toBe(true);
  });
  test('the old-root unit still matches', () => {
    expect(matchesTemplateFingerprints({ sysObjectID: '1.3.6.1.4.1.52619' }, [UBR655_FP])).toBe(true);
  });
  test('a different vendor is still excluded', () => {
    expect(matchesTemplateFingerprints({ sysObjectID: '1.3.6.1.4.1.9.1.1' }, [UBR655_FP])).toBe(false);
  });
});

describe('classifyByOid', () => {
  beforeEach(() => { global.__fpEntries = [UBR655_FP]; });

  test('a new-root unit classifies as the registered product (was Unknown / SNMP Device)', async () => {
    const c = await classifyByOid('1.3.6.1.4.1.14125.123');
    expect(c).toMatchObject({ vendor: 'EOC', model: 'UBR655', productDefinitionId: 'eoc-ubr655' });
  });
  test('an unrelated device is unaffected', async () => {
    const c = await classifyByOid('1.3.6.1.4.1.9.1.1');
    expect(c.productDefinitionId == null).toBe(true);
  });
});

describe('snmpGet retransmits instead of failing on one lost datagram', () => {
  function agent(answerFrom) {
    return new Promise((resolve) => {
      const seen = [];
      const server = dgram.createSocket('udp4');
      server.on('message', (msg, rinfo) => {
        seen.push(msg);
        if (seen.length >= answerFrom) server.send(Buffer.from([0x30, 0x00]), rinfo.port, rinfo.address);
      });
      server.bind(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
    });
  }

  test('the agent drops the first datagram → the retry is answered and the host is discovered', async () => {
    const a = await agent(2);               // ignore #1, answer #2
    try {
      const r = await snmpGet('127.0.0.1', a.port, 'public', 2400, 'v2c');
      expect(r).toHaveProperty('sysName');
      expect(a.seen.length).toBeGreaterThanOrEqual(2);
      expect(a.seen[1].equals(a.seen[0])).toBe(true);   // same request, same request-id
    } finally { a.server.close(); }
  });

  test('a silent device still ends in a timeout, and the retries stop afterwards', async () => {
    const a = await agent(Infinity);
    try {
      await expect(snmpGet('127.0.0.1', a.port, 'public', 1200, 'v2c')).rejects.toThrow(/SNMP timeout/);
      const n = a.seen.length;
      expect(n).toBeGreaterThanOrEqual(2);
      await new Promise((r) => setTimeout(r, 1300));
      expect(a.seen.length).toBe(n);          // no stray retransmits after giving up
    } finally { a.server.close(); }
  });
});

describe('handshake window', () => {
  test('never shorter than the longest quiet spell measured on a radio agent (~9 s)', () => {
    expect(discoveryWindowMs(5000)).toBe(10000);
    expect(discoveryWindowMs(0)).toBe(10000);
    expect(discoveryWindowMs(undefined)).toBe(10000);
  });
  test('a longer window requested by the operator is honoured', () => {
    expect(discoveryWindowMs(20000)).toBe(20000);
  });
});

'use strict';
/**
 * Discovery → Provision → Deprovision contract (gateway stub layer).
 *
 *   • Discovery only REPORTS. It never creates, revives or overwrites an inventory record, so a
 *     device is not "already provisioned" before an admin provisions it.
 *   • The SNMP credential and facts discovery collected reach Provision server-side only — they
 *     are never part of the results the browser gets.
 *   • One physical unit (device-reported serial) is one inventory record: provisioning it again
 *     under another label or IP updates that record; a different unit cannot take its serial.
 *   • A deprovisioned device stays deprovisioned until an admin provisions it again.
 */

process.env.INVENTORY_SERVICE_URL = 'http://127.0.0.1:1';

let deviceStore = new Map(); // _id → doc

function matchesFilter(doc, filter) {
  if (filter.$or && !filter.$or.some((cond) => matchesFilter(doc, cond))) return false;
  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (val && typeof val === 'object' && !(val instanceof RegExp)) {
      if ('$ne' in val && doc[key] === val.$ne) return false;
      if ('$nin' in val && val.$nin.includes(doc[key])) return false;
      if ('$in' in val && !val.$in.includes(doc[key])) return false;
    } else if (doc[key] !== val) {
      return false;
    }
  }
  return true;
}

global.__devColMock = {
  find: jest.fn(), findOne: jest.fn(), replaceOne: jest.fn(), insertOne: jest.fn(),
  deleteMany: jest.fn(), deleteOne: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(),
};

jest.mock('../../src/routes/topology.stub', () => ({
  bustTopologyCache: jest.fn(),
  getTopologyGraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
}));

jest.mock('mongoose', () => {
  const real = jest.requireActual('mongoose');
  return {
    ...real,
    connection: {
      readyState: 1,
      db: { collection: jest.fn().mockReturnValue(global.__devColMock) },
      client: { db: () => ({ collection: () => global.__devColMock }) },
    },
    createConnection: jest.fn().mockReturnValue({
      asPromise: jest.fn().mockResolvedValue({ db: { collection: jest.fn().mockReturnValue(global.__devColMock) } }),
    }),
  };
});

// No real SNMP in unit tests: the device "reports" these facts.
const FACTS = {
  uptimeSeconds: 1000, sysContact: 'noc', macAddress: '88:dc:97:1f:e2:1d',
  serialNumber: '2381XC71DRXD', firmwareVersion: '1.0.0.149', interfaces: [],
};
jest.mock('../../src/live/deviceFacts', () => {
  const actual = jest.requireActual('../../src/live/deviceFacts');
  return { ...actual, collectDeviceFacts: jest.fn(async () => FACTS) };
});

const express = require('express');
const request = require('supertest');
const runStore = require('../../src/live/discoveryRunStore');

function buildApp() {
  const app = express();
  app.use(express.json());
  const { createProvisionHandler } = require('../../src/routes/provision.stub');
  app.post('/api/v1/discovery/runs/:runId/provision', createProvisionHandler({}));
  app.use('/api/v1/discovery', require('../../src/routes/discovery.stub'));
  app.use('/api/v1/devices', require('../../src/routes/devices.stub'));
  return app;
}

const TARGET = 'host.docker.internal:1162';          // demo simulator port → built-in MIB, no real agent
const PROVISION_HOST = (over = {}) => ({
  ip: TARGET, deviceType: 'BTS', serialNumber: 'SN-EOC-A60-BTS-01', macAddress: '',
  sysName: 'EOC-A60-BTS-01', vendor: 'EOC', model: 'Configurations_GUI', ...over,
});

describe('Discovery → Provision → Deprovision (stub layer)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    deviceStore.clear();
    runStore.clear();
    jest.clearAllMocks();
    const c = global.__devColMock;
    c.find.mockImplementation((filter = {}) => {
      const docs = [...deviceStore.values()].filter((d) => matchesFilter(d, filter));
      const cursor = { limit: () => cursor, toArray: jest.fn().mockResolvedValue(docs) };
      return cursor;
    });
    c.findOne.mockImplementation((filter) =>
      Promise.resolve([...deviceStore.values()].find((d) => matchesFilter(d, filter)) ?? null));
    const applySet = (filter, update) => {
      let n = 0;
      for (const d of deviceStore.values()) if (matchesFilter(d, filter)) { Object.assign(d, update.$set || {}); n++; }
      return Promise.resolve({ matchedCount: n, modifiedCount: n });
    };
    c.updateOne.mockImplementation(applySet);
    c.updateMany.mockImplementation(applySet);
    c.replaceOne.mockImplementation((filter, doc) => { deviceStore.set(doc._id, doc); return Promise.resolve({ acknowledged: true }); });
    c.insertOne.mockImplementation((doc) => { deviceStore.set(doc._id, doc); return Promise.resolve({}); });
    c.deleteMany.mockImplementation((filter) => {
      let n = 0;
      for (const [id, d] of [...deviceStore]) if (matchesFilter(d, filter)) { deviceStore.delete(id); n++; }
      return Promise.resolve({ deletedCount: n });
    });
  });

  async function discover(extra = {}) {
    const res = await request(app).post('/api/v1/discovery/runs').send({ scope: [{ type: 'SEED', value: TARGET }], community: 'lab-secret', ...extra });
    expect(res.status).toBe(201);
    const results = await request(app).get(`/api/v1/discovery/runs/${res.body.runId}/results`);
    return { runId: res.body.runId, hosts: results.body, raw: JSON.stringify(results.body) };
  }

  test('1. discovery reports the device but writes nothing to the inventory', async () => {
    const { hosts } = await discover();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ snmpStatus: 'success', provisioned: false });
    expect(deviceStore.size).toBe(0);
    expect(global.__devColMock.replaceOne).not.toHaveBeenCalled();
    expect(global.__devColMock.insertOne).not.toHaveBeenCalled();
    // …and it does not show up in the inventory list
    const list = await request(app).get('/api/v1/devices');
    expect(JSON.stringify(list.body)).not.toContain('EOC-A60-BTS-01');
  });

  test('2. the SNMP community and facts are kept server-side — never in the run results', async () => {
    const { raw } = await discover();
    expect(raw).not.toContain('lab-secret');
    expect(raw).not.toContain('snmpCommunity');
  });

  test('3. provisioning creates exactly one record, with the credential and facts discovery collected', async () => {
    const { runId } = await discover();
    const res = await request(app).post(`/api/v1/discovery/runs/${runId}/provision`).send({ hosts: [PROVISION_HOST()] });
    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ status: 'provisioned', serialNumber: 'SN-EOC-A60-BTS-01' });
    expect(deviceStore.size).toBe(1);
    const doc = deviceStore.get('SN-EOC-A60-BTS-01');
    expect(doc).toMatchObject({
      deviceType: 'BTS', snmpCommunity: 'lab-secret', snmpPort: 1162,
      reportedSerialNumber: '2381XC71DRXD', macAddress: '88:dc:97:1f:e2:1d', firmwareVersion: '1.0.0.149',
    });
    expect(doc.isDeprovisioned).toBeUndefined();
  });

  test('4. re-discovering a managed device refreshes its facts but does not rewrite or duplicate it', async () => {
    const first = await discover();
    await request(app).post(`/api/v1/discovery/runs/${first.runId}/provision`).send({ hosts: [PROVISION_HOST({ deviceType: 'CPE' })] });
    deviceStore.get('SN-EOC-A60-BTS-01').firmwareVersion = 'stale';

    const again = await discover();
    expect(again.hosts[0].provisioned).toBe(true);
    expect(deviceStore.size).toBe(1);
    const doc = deviceStore.get('SN-EOC-A60-BTS-01');
    expect(doc.firmwareVersion).toBe('1.0.0.149');   // refreshed
    expect(doc.deviceType).toBe('CPE');               // the admin's choice is untouched
  });

  test('5. the same unit provisioned under another serial/IP updates its record — no duplicate', async () => {
    const first = await discover();
    await request(app).post(`/api/v1/discovery/runs/${first.runId}/provision`).send({ hosts: [PROVISION_HOST()] });

    // same physical unit (same reported serial) now answers from another address
    runStore.put('run-2', '10.0.150.6', { community: 'lab-secret', port: 161, inventory: { reportedSerialNumber: '2381XC71DRXD', macAddress: '88:dc:97:1f:e2:1d' } });
    const res = await request(app).post('/api/v1/discovery/runs/run-2/provision')
      .send({ hosts: [PROVISION_HOST({ ip: '10.0.150.6', serialNumber: 'SN-OTHER-LABEL', sysName: 'UBR655' })] });
    expect(res.body.results[0]).toMatchObject({ status: 'provisioned', serialNumber: 'SN-EOC-A60-BTS-01', merged: true });
    expect(deviceStore.size).toBe(1);
    expect(deviceStore.get('SN-EOC-A60-BTS-01').ipAddress).toBe('10.0.150.6');
  });

  test('6. a different unit cannot take another unit\'s serial number', async () => {
    const first = await discover();
    await request(app).post(`/api/v1/discovery/runs/${first.runId}/provision`).send({ hosts: [PROVISION_HOST()] });

    runStore.put('run-3', '10.0.150.77', { community: 'x', port: 161, inventory: { reportedSerialNumber: 'DIFFERENT-UNIT' } });
    const res = await request(app).post('/api/v1/discovery/runs/run-3/provision')
      .send({ hosts: [PROVISION_HOST({ ip: '10.0.150.77', sysName: 'OTHER' })] });   // same chosen serial
    expect(res.status).toBe(422);
    expect(res.body.results[0].status).toBe('failed');
    expect(res.body.results[0].error).toMatch(/already used by a different device/);
    expect(deviceStore.size).toBe(1);
    expect(deviceStore.get('SN-EOC-A60-BTS-01').reportedSerialNumber).toBe('2381XC71DRXD');   // untouched
  });

  test('7. a deprovisioned device stays deprovisioned through re-discovery until provisioned again', async () => {
    const first = await discover();
    await request(app).post(`/api/v1/discovery/runs/${first.runId}/provision`).send({ hosts: [PROVISION_HOST()] });

    expect((await request(app).delete('/api/v1/devices/SN-EOC-A60-BTS-01')).status).toBe(204);
    expect(deviceStore.get('SN-EOC-A60-BTS-01').isDeprovisioned).toBe(true);

    const again = await discover();
    expect(again.hosts[0]).toMatchObject({ provisioned: false, deprovisionedFlag: true });
    expect(deviceStore.get('SN-EOC-A60-BTS-01').isDeprovisioned).toBe(true);     // not revived
    expect(deviceStore.size).toBe(1);                                            // not duplicated

    const res = await request(app).post(`/api/v1/discovery/runs/${again.runId}/provision`).send({ hosts: [PROVISION_HOST()] });
    expect(res.body.results[0].status).toBe('provisioned');
    expect(deviceStore.get('SN-EOC-A60-BTS-01').isDeprovisioned).toBeUndefined(); // active again, by the admin
    expect(deviceStore.size).toBe(1);
  });

  test('9. provisioning links the definition discovery resolved, clears stale poll state and polls at once', async () => {
    const live = require('../../src/live/liveParameters');
    const resolve = jest.spyOn(live, 'resolveDefinitionId').mockImplementation(async (c) => c.find(Boolean) || null);
    const reset   = jest.spyOn(live, 'resetStaleLiveState').mockResolvedValue(true);
    const refresh = jest.spyOn(live, 'refreshDevice').mockResolvedValue({ pollStatus: 'OK' });
    try {
      const { runId } = await discover();
      // the browser's request carries no productDefinitionId — it must come from the run
      await request(app).post(`/api/v1/discovery/runs/${runId}/provision`).send({ hosts: [PROVISION_HOST()] });
      const doc = deviceStore.get('SN-EOC-A60-BTS-01');
      expect(doc.productDefinitionId).toBe('Configurations_GUI');
      expect(reset).toHaveBeenCalledWith(expect.objectContaining({ _id: 'SN-EOC-A60-BTS-01' }));
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ _id: 'SN-EOC-A60-BTS-01', snmpCommunity: 'lab-secret' }));
    } finally {
      resolve.mockRestore(); reset.mockRestore(); refresh.mockRestore();
    }
  });

  test('10. a host from a subnet scan (no run data, no definition in the request) is linked from its own sysObjectID', async () => {
    const live = require('../../src/live/liveParameters');
    const resolve = jest.spyOn(live, 'resolveDefinitionId').mockImplementation(async (c) => c.find(Boolean) || null);
    jest.spyOn(live, 'refreshDevice').mockResolvedValue({});
    try {
      // new-firmware root: only resolvable because the registry lookup compares the canonical root
      const res = await request(app).post('/api/v1/discovery/runs/java-run-1/provision').send({ hosts: [PROVISION_HOST({
        ip: '10.0.150.16', deviceType: 'CPE', serialNumber: 'SN-EOC655-C18', sysName: 'EOC655-C18',
        sysObjectID: '1.3.6.1.4.1.14125.123', sysDescr: 'Linux UBR655 4.4.60',
      })] });
      expect(res.body.results[0].status).toBe('provisioned');
      expect(deviceStore.get('SN-EOC655-C18').productDefinitionId).toBe('Configurations_GUI');
    } finally { jest.restoreAllMocks(); }
  });

  test('8. a CPE is linked to its BTS once both are provisioned, whichever goes first', async () => {
    runStore.put('run-4', '10.0.0.2', { community: 'c', port: 161, inventory: { reportedSerialNumber: 'CPE-UNIT' }, pairedBtsIp: '10.0.0.1' });
    runStore.put('run-4', '10.0.0.1', { community: 'c', port: 161, inventory: { reportedSerialNumber: 'BTS-UNIT' } });

    await request(app).post('/api/v1/discovery/runs/run-4/provision')
      .send({ hosts: [PROVISION_HOST({ ip: '10.0.0.2', deviceType: 'CPE', serialNumber: 'SN-CPE-0001', sysName: 'cpe' })] });
    expect(deviceStore.get('SN-CPE-0001').connectedBtsSerial).toBeUndefined();   // BTS not in inventory yet

    await request(app).post('/api/v1/discovery/runs/run-4/provision')
      .send({ hosts: [PROVISION_HOST({ ip: '10.0.0.1', deviceType: 'BTS', serialNumber: 'SN-BTS-0001', sysName: 'bts' })] });
    expect(deviceStore.get('SN-CPE-0001').connectedBtsSerial).toBe('SN-BTS-0001');
  });
});

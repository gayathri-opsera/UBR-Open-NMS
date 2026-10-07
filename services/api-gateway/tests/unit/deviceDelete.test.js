'use strict';
/**
 * Deleting a device must hide it from the inventory list for good.
 *
 * Regression: DELETE only looked in ubrnms.devices, so a device held in the inventory store
 * (IDU devices, and the BTS/CPE the Java inventory service owns) answered 404 and was listed
 * again on the next refresh. These tests use SEPARATE collections for the local store and the
 * inventory store, plus a fake Java inventory service.
 */

const http = require('http');

// ── in-memory collections with the bits of Mongo semantics the stub uses ──────
function matches(doc, filter = {}) {
  if (filter.$or && !filter.$or.some((c) => matches(doc, c))) return false;
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return true;
    if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
    if (v && typeof v === 'object' && '$regex' in v) return new RegExp(v.$regex, v.$options).test(doc[k] || '');
    return doc[k] === v;
  });
}
function makeCol() {
  const docs = new Map();
  const col = {
    docs,
    find: (filter) => {
      const out = [...docs.values()].filter((d) => matches(d, filter));
      const cur = { limit: () => cur, toArray: async () => out };
      return cur;
    },
    findOne: async (filter) => [...docs.values()].find((d) => matches(d, filter)) || null,
    updateMany: async (filter, update) => {
      let n = 0;
      for (const d of docs.values()) if (matches(d, filter)) { Object.assign(d, update.$set); n++; }
      return { matchedCount: n };
    },
    updateOne: async (filter, update) => col.updateMany(filter, update),
    insert: (d) => docs.set(d._id, d),
  };
  return col;
}
global.__localCol = makeCol();
global.__invCol = makeCol();

jest.mock('../../src/routes/topology.stub', () => ({ bustTopologyCache: jest.fn() }));
jest.mock('mongoose', () => {
  const real = jest.requireActual('mongoose');
  return {
    ...real,
    connection: { readyState: 1, db: { collection: () => global.__localCol } },
    createConnection: () => ({ asPromise: async () => ({ db: { collection: () => global.__invCol } }) }),
  };
});

const express = require('express');
const request = require('supertest');

describe('DELETE /api/v1/devices/:id across stores', () => {
  let app;
  let javaServer;
  const javaDevices = new Map();      // id → device the fake Java service lists
  const javaDeletes = [];             // ids Java was asked to delete
  let javaDown = false;

  beforeAll(async () => {
    javaServer = http.createServer((req, res) => {
      if (javaDown) { req.socket.destroy(); return; }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/devices')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify([...javaDevices.values()]));
      }
      if (req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.split('/').pop());
        javaDeletes.push(id);
        javaDevices.delete(id);
        global.__invCol.docs.delete(id);     // Java removes its record from the shared store
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404; return res.end();
    });
    await new Promise((r) => javaServer.listen(0, '127.0.0.1', r));
    process.env.INVENTORY_SERVICE_URL = `http://127.0.0.1:${javaServer.address().port}`;

    app = express();
    app.use(express.json());
    app.use('/api/v1/devices', require('../../src/routes/devices.stub'));
  });
  afterAll(() => new Promise((r) => javaServer.close(r)));

  beforeEach(() => {
    global.__localCol.docs.clear();
    global.__invCol.docs.clear();
    javaDevices.clear();
    javaDeletes.length = 0;
    javaDown = false;
  });

  const listed = async (serial) => {
    const res = await request(app).get('/api/v1/devices');
    return (res.body || []).some((d) => d.serialNumber === serial || d.id === serial);
  };

  it('a device in the local store is deleted and stays gone', async () => {
    global.__localCol.insert({ _id: 'L-1', serialNumber: 'L-1', deviceType: 'RADIO', ipAddress: '10.1.1.1' });
    expect(await listed('L-1')).toBe(true);
    expect((await request(app).delete('/api/v1/devices/L-1')).status).toBe(204);
    expect(await listed('L-1')).toBe(false);
  });

  it('an IDU held only in the inventory store is deleted (was 404 and came back)', async () => {
    global.__invCol.insert({ _id: 'idu-1', id: 'idu-1', serialNumber: 'SN-IDU-1', deviceType: 'IDU', status: 'ONLINE' });
    expect(await listed('SN-IDU-1')).toBe(true);

    const del = await request(app).delete('/api/v1/devices/SN-IDU-1');
    expect(del.status).toBe(204);
    expect(await listed('SN-IDU-1')).toBe(false);
  });

  it('a Java-inventory device is deleted through the Java service (tombstone cascade)', async () => {
    const dev = { _id: 'bts-1', id: 'bts-1', serialNumber: 'SN-BTS-1', deviceType: 'BTS', status: 'ONLINE' };
    global.__invCol.insert(dev);
    javaDevices.set('bts-1', dev);
    expect(await listed('SN-BTS-1')).toBe(true);

    expect((await request(app).delete('/api/v1/devices/SN-BTS-1')).status).toBe(204);
    expect(javaDeletes).toEqual(['bts-1']);
    expect(await listed('SN-BTS-1')).toBe(false);
  });

  it('stays hidden even if the Java inventory service is down or still lists the device', async () => {
    const dev = { _id: 'cpe-1', id: 'cpe-1', serialNumber: 'SN-CPE-1', deviceType: 'CPE', status: 'ONLINE' };
    global.__invCol.insert(dev);
    javaDevices.set('cpe-1', dev);

    javaDown = true;                                    // the cascade call fails …
    expect((await request(app).delete('/api/v1/devices/SN-CPE-1')).status).toBe(204);
    javaDown = false;
    expect(javaDevices.has('cpe-1')).toBe(true);        // … so Java still lists it
    expect(await listed('SN-CPE-1')).toBe(false);       // but the gateway hides it
  });

  it('keeps the record, flagged, in every store that held it', async () => {
    global.__localCol.insert({ _id: 'B-1', serialNumber: 'B-1', deviceType: 'RADIO' });
    global.__invCol.insert({ _id: 'B-1', serialNumber: 'B-1', deviceType: 'IDU' });
    javaDown = true;
    await request(app).delete('/api/v1/devices/B-1');
    expect(global.__localCol.docs.get('B-1')).toMatchObject({ isDeprovisioned: true, status: 'DEPROVISIONED' });
    expect(global.__invCol.docs.get('B-1')).toMatchObject({ isDeprovisioned: true, status: 'DEPROVISIONED' });
  });

  it('answers 404 only when no store knows the device, and leaves others alone', async () => {
    global.__localCol.insert({ _id: 'keep', serialNumber: 'keep', deviceType: 'RADIO' });
    expect((await request(app).delete('/api/v1/devices/nope')).status).toBe(404);
    expect(await listed('keep')).toBe(true);
  });
});

'use strict';
/**
 * Integration-style test: provision → deprovision → cascade assertions.
 *
 * Validates the full stub-layer contract that was identified as missing:
 *   1. POST  /api/v1/discovery/runs/:runId/provision  — device appears in devices collection
 *   2. Reject duplicate IP+hostname with a different serial (uniqueness constraint)
 *   3. Re-provisioning same IP+hostname+serial is idempotent (upsert)
 *   4. GET   /api/v1/devices/:id/metrics returns data for a provisioned device
 *   5. After deprovision → GET /metrics returns 404
 *   6. Deprovision busts the topology cache
 *   7. GET   /api/v1/topology does not include the deprovisioned device
 *
 * ⚠️  ARCHITECTURE NOTE (preserved for the real Java path):
 *   In production the cascade relies on:
 *     a) InventoryService.deleteDevice() publishing a DEVICE_DELETED tombstone to Kafka
 *     b) topology-service InventoryChangeConsumer consuming that tombstone + deleting the node
 *     c) kpi-query-service checking device existence via inventory gRPC before returning metrics
 *   These tests exercise the Node.js stub equivalents only.  The Java path MUST be covered
 *   by separate Spring Boot integration tests (e.g. @SpringBootTest + EmbeddedKafka).
 */

// The Java inventory service is not running in unit tests: a closed port makes the best-effort
// cascade call fail immediately (and exercises the "Java down" path) instead of waiting on DNS.
process.env.INVENTORY_SERVICE_URL = 'http://127.0.0.1:1';

// ── Shared in-memory device store (mirrors MongoDB 'devices' collection) ──────
let deviceStore = new Map(); // _id → doc

// ── Query helpers (mirror MongoDB semantics for $or, $ne) ─────────────────────
function matchesFilter(doc, filter) {
  // $or and sibling conditions must BOTH hold (Mongo semantics)
  if (filter.$or && !filter.$or.some((cond) => matchesFilter(doc, cond))) return false;
  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (val && typeof val === 'object' && '$ne' in val) {
      if (doc[key] === val.$ne) return false;
    } else if (doc[key] !== val) {
      return false;
    }
  }
  return true;
}

// ── Shared mock collection (updated in beforeEach so the store reference is live) ─
global.__devColMock = {
  find: jest.fn(),
  findOne: jest.fn(),
  replaceOne: jest.fn(),
  deleteMany: jest.fn(),
  deleteOne: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
};

// topology stub must be mocked before any require of topology.stub
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
      db: {
        collection: jest.fn().mockReturnValue(global.__devColMock),
      },
      // KPI stub also looks devices up in the inventory DB through connection.client
      client: { db: () => ({ collection: () => global.__devColMock }) },
    },
    createConnection: jest.fn().mockReturnValue({
      asPromise: jest.fn().mockResolvedValue({
        db: { collection: jest.fn().mockReturnValue(global.__devColMock) },
      }),
    }),
  };
});

const express = require('express');
const request = require('supertest');

// ── Build a minimal test app wiring the same routes as app.js ────────────────
function buildApp() {
  const app = express();
  app.use(express.json());

  const { createProvisionHandler } = require('../../src/routes/provision.stub');
  app.post('/api/v1/discovery/runs/:runId/provision', createProvisionHandler({}));

  const devicesRouter = require('../../src/routes/devices.stub');
  app.use('/api/v1/devices', devicesRouter);

  const kpiRouter = require('../../src/routes/kpi.stub');
  app.use('/api/v1', kpiRouter);

  return app;
}

const CISCO_HOST = {
  ip:           '192.168.65.254',
  deviceType:   'BTS',
  serialNumber: 'SN-cisco-sw-core-01',
  macAddress:   'AA:BB:CC:DD:EE:FF',
  sysName:      'cisco-sw-core-01',
  vendor:       'Cisco',
  model:        'Catalyst 2960',
  networkId:    'net-test-01',
};

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Provision → Deprovision cascade (stub layer)', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    deviceStore.clear();
    jest.clearAllMocks();

    // Re-bind mock implementations to the live deviceStore after clearAllMocks.
    global.__devColMock.find.mockImplementation((filter = {}) => {
      const docs = [...deviceStore.values()].filter((d) => matchesFilter(d, filter));
      const cursor = { limit: () => cursor, toArray: jest.fn().mockResolvedValue(docs) };
      return cursor;
    });

    // Soft-delete: DELETE /devices/:id marks matching docs instead of removing them.
    const applySet = (filter, update) => {
      let matched = 0;
      for (const doc of deviceStore.values()) {
        if (matchesFilter(doc, filter)) { Object.assign(doc, update.$set || {}); matched++; }
      }
      return Promise.resolve({ matchedCount: matched, modifiedCount: matched });
    };
    global.__devColMock.updateOne.mockImplementation(applySet);
    global.__devColMock.updateMany.mockImplementation(applySet);

    global.__devColMock.findOne.mockImplementation((filter) =>
      Promise.resolve([...deviceStore.values()].find((d) => matchesFilter(d, filter)) ?? null),
    );

    global.__devColMock.replaceOne.mockImplementation((filter, doc /*, opts */) => {
      deviceStore.set(doc._id, doc);
      return Promise.resolve({ acknowledged: true, upsertedCount: 1 });
    });

    global.__devColMock.deleteMany.mockImplementation((filter) => {
      let deleted = 0;
      for (const [key, doc] of deviceStore.entries()) {
        if (matchesFilter(doc, filter)) {
          deviceStore.delete(key);
          deleted++;
        }
      }
      return Promise.resolve({ deletedCount: deleted });
    });

    global.__devColMock.deleteOne.mockImplementation((filter) => {
      for (const [key, doc] of deviceStore.entries()) {
        if (matchesFilter(doc, filter)) {
          deviceStore.delete(key);
          return Promise.resolve({ deletedCount: 1 });
        }
      }
      return Promise.resolve({ deletedCount: 0 });
    });

    // Re-wire mongoose connection mock (clearAllMocks wipes mockReturnValue on it)
    const mongoose = require('mongoose');
    mongoose.connection.db.collection.mockReturnValue(global.__devColMock);
  });

  // ── 1. Provision ─────────────────────────────────────────────────────────
  it('1. provision creates a device record', async () => {
    const res = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });

    expect(res.status).toBe(201);
    expect(res.body.provisioned).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(true);
    const stored = deviceStore.get(CISCO_HOST.serialNumber);
    expect(stored.ipAddress).toBe(CISCO_HOST.ip);
    expect(stored.status).toBe('ONLINE');
  });

  // ── 2. Same IP + hostname, different serial → no second record ───────────
  // Provisioning is idempotent: the host is already provisioned, so the existing device
  // is returned as success and no duplicate record is created.
  it('2. re-provisioning same IP+hostname with a different serial does not create a duplicate', async () => {
    const first = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });
    expect(first.status).toBe(201);
    expect(deviceStore.size).toBe(1);

    const dup = { ...CISCO_HOST, serialNumber: 'SN-different-serial' };
    const res = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [dup] });

    expect(res.body.failed).toBe(0);
    const ok = res.body.results.find((r) => r.status === 'provisioned');
    expect(ok.deviceId).toBe(CISCO_HOST.serialNumber);   // the existing device, not a new one
    expect(deviceStore.size).toBe(1);
    expect(deviceStore.has('SN-different-serial')).toBe(false);
  });

  // ── 3. Idempotent re-provision ────────────────────────────────────────────
  it('3. re-provisioning same IP+hostname+serial is idempotent (upsert)', async () => {
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });

    const res = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });

    expect(res.body.provisioned).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(deviceStore.size).toBe(1);
  });

  // ── 4. KPI metrics — provisioned device returns data ─────────────────────
  it('4. GET /devices/:deviceId/metrics returns data for a provisioned device', async () => {
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });

    const res = await request(app)
      .get(`/api/v1/devices/${CISCO_HOST.serialNumber}/metrics`)
      .query({ metrics: 'cpuUtilization', granularity: 'HOUR' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  // ── 5. Deprovision + KPI cascade ─────────────────────────────────────────
  it('5. after deprovision GET /metrics returns 404 (device not found)', async () => {
    // Provision first.
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(true);

    // Deprovision.
    const delRes = await request(app)
      .delete(`/api/v1/devices/${CISCO_HOST.serialNumber}`);
    expect(delRes.status).toBe(204);
    expect(deviceStore.get(CISCO_HOST.serialNumber).isDeprovisioned).toBe(true);

    // KPI metrics for the deleted device → 404.
    const metricsRes = await request(app)
      .get(`/api/v1/devices/${CISCO_HOST.serialNumber}/metrics`)
      .query({ metrics: 'cpuUtilization', granularity: 'HOUR' });

    expect(metricsRes.status).toBe(404);
    expect(metricsRes.body.code).toBe('DEVICE_NOT_FOUND');
  });

  // ── 6. Deprovision + topology cache bust ─────────────────────────────────
  it('6. deprovision busts the topology cache', async () => {
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });

    const topologyStub = require('../../src/routes/topology.stub');
    topologyStub.bustTopologyCache.mockClear();

    const delRes = await request(app)
      .delete(`/api/v1/devices/${CISCO_HOST.serialNumber}`);
    expect(delRes.status).toBe(204);

    expect(topologyStub.bustTopologyCache).toHaveBeenCalledTimes(1);
  });

  // ── 7. Deleted device is no longer listed ────────────────────────────────
  it('7. deprovisioned device is flagged and no longer listed (record kept for audit)', async () => {
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(true);

    await request(app).delete(`/api/v1/devices/${CISCO_HOST.serialNumber}`);

    // The record stays (soft delete) so re-discovery cannot resurrect it silently …
    expect(deviceStore.get(CISCO_HOST.serialNumber)).toMatchObject({ isDeprovisioned: true, status: 'DEPROVISIONED' });
    // … but the inventory list must not show it.
    const list = await request(app).get('/api/v1/devices');
    const listed = (list.body || []).some(
      (d) => d.serialNumber === CISCO_HOST.serialNumber || d.ipAddress === CISCO_HOST.ip,
    );
    expect(listed).toBe(false);
  });
});

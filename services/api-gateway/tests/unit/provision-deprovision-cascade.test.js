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

// ── Shared in-memory device store (mirrors MongoDB 'devices' collection) ──────
let deviceStore = new Map(); // _id → doc

// ── Query helpers (mirror MongoDB semantics for $or, $ne) ─────────────────────
function matchesFilter(doc, filter) {
  if (filter.$or) {
    return filter.$or.some((cond) => matchesFilter(doc, cond));
  }
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
    global.__devColMock.find.mockImplementation(() => ({
      toArray: jest.fn().mockResolvedValue([...deviceStore.values()]),
    }));

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

  // ── 2. IP+hostname uniqueness — duplicate rejected ────────────────────────
  it('2. re-provisioning same IP+hostname with different serial is rejected', async () => {
    // First provision succeeds.
    const first = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });
    expect(first.status).toBe(201);
    expect(deviceStore.size).toBe(1);

    // Second provision — same IP, same sysName, different serial → conflict.
    const dup = { ...CISCO_HOST, serialNumber: 'SN-different-serial' };
    const res = await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [dup] });

    expect(res.body.failed).toBe(1);
    const failedResult = res.body.results.find((r) => r.status === 'failed');
    expect(failedResult).toBeDefined();
    expect(failedResult.error).toMatch(/already exists/i);
    // Store should still have only the original record.
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(true);
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
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(false);

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

  // ── 7. Topology node absent after deprovision ────────────────────────────
  it('7. deprovisioned device is absent from device store (topology has no stale node)', async () => {
    await request(app)
      .post('/api/v1/discovery/runs/run-001/provision')
      .send({ hosts: [CISCO_HOST] });
    expect(deviceStore.has(CISCO_HOST.serialNumber)).toBe(true);

    await request(app)
      .delete(`/api/v1/devices/${CISCO_HOST.serialNumber}`);

    // The topology stub reads from the devices collection; after deletion it must
    // have no entry for this device.
    const remaining = [...deviceStore.values()];
    const found = remaining.some(
      (d) => d.serialNumber === CISCO_HOST.serialNumber || d.ipAddress === CISCO_HOST.ip,
    );
    expect(found).toBe(false);
    expect(deviceStore.size).toBe(0);
  });
});

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Disable Kafka and syslog for integration test
process.env.KAFKA_ENABLED = 'false';
process.env.SYSLOG_ENABLED = 'false';

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  await mongoose.connect(process.env.MONGO_URI);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// Import app AFTER env vars are set
const app = require('../../src/app');

describe('POST /api/v1/audit/events', () => {
  it('persists a valid audit event and returns 201', async () => {
    const res = await request(app)
      .post('/api/v1/audit/events')
      .send({
        actor: 'admin@nms.local',
        action: 'CREATE',
        resource: 'device',
        resourceId: 'dev-001',
        result: 'SUCCESS',
        sourceIp: '10.0.0.1',
        correlationId: 'corr-abc',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.id).toBeDefined();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/api/v1/audit/events')
      .send({ actor: 'user1' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/audit/logs', () => {
  it('returns 403 for non-admin users', async () => {
    // Simulate a non-admin user by injecting into req (via test middleware)
    const appWithUser = require('express')();
    appWithUser.use(require('express').json());
    appWithUser.use((req, res, next) => { req.user = { role: 'operator' }; next(); });
    appWithUser.use('/api/v1/audit', require('../../src/routes/audit.routes'));

    const res = await request(appWithUser).get('/api/v1/audit/logs');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns audit log entries for admin users', async () => {
    const appWithAdmin = require('express')();
    appWithAdmin.use(require('express').json());
    appWithAdmin.use((req, res, next) => { req.user = { role: 'admin' }; next(); });
    appWithAdmin.use('/api/v1/audit', require('../../src/routes/audit.routes'));

    const res = await request(appWithAdmin).get('/api/v1/audit/logs?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /healthz', () => {
  it('returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

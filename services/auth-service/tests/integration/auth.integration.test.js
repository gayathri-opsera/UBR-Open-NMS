'use strict';

/**
 * Integration test: full login→access→refresh→logout flow.
 *
 * Uses in-process mocks for LDAP, MongoDB (mongoose-memory-server), and Redis
 * so no external services are needed in CI.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { generateKeyPairSync } = require('crypto');
const { createApp } = require('../../src/app');
const sessionService = require('../../src/services/session.service');
const config = require('../../src/config');

// ── Test RSA key pair ────────────────────────────────────────────────────────
let mongod;
let app;

// Minimal Redis mock for integration tests.
function buildRedis() {
  const store = {};
  const sets = {};

  const redis = {
    get: async (k) => store[k] ?? null,
    set: async (k, v) => { store[k] = v; return 'OK'; },
    del: async (...ks) => { ks.forEach((k) => delete store[k]); return ks.length; },
    incr: async (k) => { store[k] = String((parseInt(store[k] || '0', 10) + 1)); return parseInt(store[k], 10); },
    expire: async () => 1,
    sadd: async (k, ...ms) => { sets[k] = sets[k] || new Set(); ms.forEach((m) => sets[k].add(m)); return ms.length; },
    srem: async (k, ...ms) => { if (sets[k]) ms.forEach((m) => sets[k].delete(m)); return ms.length; },
    smembers: async (k) => [...(sets[k] || new Set())],
    scan: async () => ['0', []],
    pipeline() {
      const ops = [];
      const pipe = {
        set: (...a) => { ops.push(['set', ...a]); return pipe; },
        del: (...a) => { ops.push(['del', ...a]); return pipe; },
        sadd: (...a) => { ops.push(['sadd', ...a]); return pipe; },
        srem: (...a) => { ops.push(['srem', ...a]); return pipe; },
        expire: (...a) => { ops.push(['expire', ...a]); return pipe; },
        exec: async () => {
          for (const op of ops) {
            const [cmd, ...args] = op;
            if (redis[cmd]) await redis[cmd](...args);
          }
          return [];
        },
      };
      return pipe;
    },
  };
  return redis;
}

beforeAll(async () => {
  // Set up RSA keys for JWT.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  config.jwt.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  config.jwt.publicKey = publicKey.export({ type: 'spki', format: 'pem' });

  // In-memory MongoDB.
  mongod = await MongoMemoryServer.create();
  config.mongo.uri = mongod.getUri();
  await mongoose.connect(config.mongo.uri, config.mongo.options);

  // Mock Redis.
  sessionService.setRedis(buildRedis());

  app = createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// Mock LDAP so tests don't need a real directory server.
jest.mock('../../src/services/ldap.service', () => ({
  authenticate: jest.fn(),
  isOpen: jest.fn(() => false),
}));

const ldapService = require('../../src/services/ldap.service');

describe('Integration — login → refresh → logout', () => {
  let accessToken, refreshToken;

  // Seed a user first (needed so the shadow record can be found on LDAP success path).
  beforeAll(async () => {
    const { User } = require('../../src/models/user.model');
    const user = new User({
      username: 'testoperator',
      email: 'op@test.com',
      role: 'operator',
      isLdapUser: true,
    });
    await user.save();
  });

  test('POST /api/v1/auth/login returns 200 with tokens', async () => {
    ldapService.authenticate.mockResolvedValue({
      dn: 'uid=testoperator,dc=test,dc=com',
      mail: 'op@test.com',
      uid: 'testoperator',
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'testoperator', password: 'AnyPass123!' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data.role).toBe('operator');

    accessToken = res.body.data.accessToken;
    refreshToken = res.body.data.refreshToken;
  });

  test('POST /api/v1/auth/refresh returns new tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');

    accessToken = res.body.data.accessToken;
    refreshToken = res.body.data.refreshToken;
  });

  test('POST /api/v1/auth/logout returns 200', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });

    expect(res.status).toBe(200);
  });

  test('POST /api/v1/auth/refresh with invalidated token returns 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('Integration — RBAC enforcement', () => {
  let operatorToken, adminToken;

  beforeAll(async () => {
    const { User } = require('../../src/models/user.model');
    await User.create({ username: 'adminuser', email: 'admin@test.com', role: 'admin', isLdapUser: true });
    await User.create({ username: 'opuser2', email: 'op2@test.com', role: 'operator', isLdapUser: true });

    ldapService.authenticate.mockResolvedValue({ dn: 'uid=adminuser', mail: 'admin@test.com' });
    const adminRes = await request(app).post('/api/v1/auth/login').send({ username: 'adminuser', password: 'x' });
    adminToken = adminRes.body.data.accessToken;

    ldapService.authenticate.mockResolvedValue({ dn: 'uid=opuser2', mail: 'op2@test.com' });
    const opRes = await request(app).post('/api/v1/auth/login').send({ username: 'opuser2', password: 'x' });
    operatorToken = opRes.body.data.accessToken;
  });

  test('admin can GET /api/v1/users', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  test('operator receives 403 on /api/v1/users', async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('unauthenticated request to /api/v1/users returns 401', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });
});

describe('Integration — health probes', () => {
  test('GET /healthz returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /readyz returns 200', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });
});

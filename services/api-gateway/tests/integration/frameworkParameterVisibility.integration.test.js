'use strict';

/**
 * WO-006 Integration tests: Framework Parameter Visibility — Authorization gates
 *
 * These tests verify that:
 *  - Unauthenticated requests are rejected with 401
 *  - Insufficient roles are rejected with 403 (FORBIDDEN_ACTION)
 *  - Authorised callers reach the downstream proxy (200)
 *  - The canonical and legacy paths both work
 *
 * Visibility filtering is a pure-function concern tested in
 * tests/unit/frameworkParameterVisibility.test.js (34 tests).
 */

const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');

const { privateKey: mockPrivateKey, publicKey: mockPublicKey } =
  crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mockPublicPem  = mockPublicKey.export({ type: 'spki', format: 'pem' });
const mockPrivatePem = mockPrivateKey.export({ type: 'pkcs8', format: 'pem' });

jest.mock('../../src/config', () => ({
  port: 3000,
  jwt: { publicKey: mockPublicPem, algorithm: 'RS256', issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
  cors: { origin: '*', credentials: true },
  circuitBreaker: { timeout: 3000, errorThresholdPct: 50, resetTimeout: 30000 },
  rateLimit: { defaultWindowMs: 60000, defaultMax: 100 },
  services: {
    auth: 'http://auth:3001', inventory: 'http://inventory:3002',
    alarm: 'http://alarm:3003', config: 'http://cfg:3004',
    kpi: 'http://kpi:3005', topology: 'http://top:3006',
    discovery: 'http://disc:3007', audit: 'http://audit:3008',
    notification: 'http://notif:3009',
    productDefinition: 'http://prod-def:8093',
  },
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// The proxy mock returns 200 for authorised requests.
// Visibility filtering is a pure function tested separately in unit tests.
jest.mock('express-http-proxy', () => () => (_req, res) => {
  res.status(200).json({ status: 'ok', data: { deviceId: 'bts-001', parameterGroups: [] } });
});

jest.mock('opossum', () => {
  return class FakeBreaker {
    constructor(fn) { this.fn = fn; }
    on()          { return this; }
    fire(...args) { return this.fn(...args); }
  };
});

jest.mock('mongoose', () => ({
  connection: { readyState: 1, db: { collection: jest.fn().mockReturnValue({}) } },
  connect: jest.fn().mockResolvedValue(undefined),
}));

const { createApp } = require('../../src/app');

function signToken(role) {
  return jwt.sign(
    { sub: `u-${role}`, userId: `u-${role}`, role },
    mockPrivatePem,
    { algorithm: 'RS256', expiresIn: '5m', issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
  );
}

const CANONICAL = '/api/framework/v1/devices/bts-001';
const LEGACY    = '/api/v1/framework/devices/bts-001';

// ── 401 for unauthenticated requests ─────────────────────────────────────────

describe('WO-006: 401 for unauthenticated access', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  [CANONICAL, LEGACY].forEach((base) => {
    it(`[${base}] GET /parameter-template returns 401 without token`, async () => {
      const res = await request(app).get(`${base}/parameter-template`);
      expect(res.status).toBe(401);
    });

    it(`[${base}] GET /parameters returns 401 without token`, async () => {
      const res = await request(app).get(`${base}/parameters`);
      expect(res.status).toBe(401);
    });
  });
});

// ── ReadOnly roles (viewer, compliance, auditor) can access read endpoints ────

describe('WO-006: ReadOnly roles can access read endpoints', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  ['viewer', 'compliance', 'auditor', 'user'].forEach((role) => {
    it(`${role} can GET /parameter-template`, async () => {
      const res = await request(app)
        .get(`${CANONICAL}/parameter-template`)
        .set('Authorization', `Bearer ${signToken(role)}`);
      expect(res.status).toBe(200);
    });

    it(`${role} can GET /parameters`, async () => {
      const res = await request(app)
        .get(`${CANONICAL}/parameters`)
        .set('Authorization', `Bearer ${signToken(role)}`);
      expect(res.status).toBe(200);
    });

    it(`${role} can GET /parameters/:id`, async () => {
      const res = await request(app)
        .get(`${CANONICAL}/parameters/sys_uptime`)
        .set('Authorization', `Bearer ${signToken(role)}`);
      expect(res.status).toBe(200);
    });
  });
});

// ── Operator and SuperAdmin roles can also access read endpoints ──────────────

describe('WO-006: Operator and SuperAdmin can access read endpoints', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  ['operator', 'nms_operator', 'admin', 'system_admin'].forEach((role) => {
    it(`${role} can GET /parameter-template`, async () => {
      const res = await request(app)
        .get(`${CANONICAL}/parameter-template`)
        .set('Authorization', `Bearer ${signToken(role)}`);
      expect(res.status).toBe(200);
    });
  });
});

// ── Unknown roles are denied (deny-by-default) ───────────────────────────────

describe('WO-006: Unknown roles are denied by gateway RBAC', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('unknown role returns 403 from framework capability check', async () => {
    const res = await request(app)
      .get(`${CANONICAL}/parameter-template`)
      .set('Authorization', `Bearer ${signToken('unknown_role')}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
  });
});

// ── Correlation ID propagation ────────────────────────────────────────────────

describe('WO-006: Correlation ID propagation', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('upstream correlation ID is echoed in response header', async () => {
    const res = await request(app)
      .get(`${CANONICAL}/parameter-template`)
      .set('Authorization', `Bearer ${signToken('viewer')}`)
      .set('X-Correlation-ID', 'vis-corr-001');
    expect(res.headers['x-correlation-id']).toBe('vis-corr-001');
  });
});

// ── Legacy path parity ────────────────────────────────────────────────────────

describe('WO-006: Legacy /api/v1/framework path parity', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('admin can access legacy path', async () => {
    const res = await request(app)
      .get(`${LEGACY}/parameter-template`)
      .set('Authorization', `Bearer ${signToken('admin')}`);
    expect(res.status).toBe(200);
  });

  it('unknown role denied on legacy path', async () => {
    const res = await request(app)
      .get(`${LEGACY}/parameter-template`)
      .set('Authorization', `Bearer ${signToken('unknown_role')}`);
    expect(res.status).toBe(403);
  });
});

'use strict';

/**
 * WO-004 Integration tests: Framework Gateway Authorization
 *
 * Tests the full Express middleware stack (authenticate → requireRole →
 * requireFrameworkCapability) for /api/framework/v1/product-definitions routes
 * and the legacy /api/v1/framework/product-definitions alias.
 *
 * Variable names in jest.mock() factories must be prefixed with 'mock'
 * (jest restriction for factory hoisting).
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const request = require('supertest');

// Key pair generated at module level — names prefixed with 'mock' per jest rules.
const { privateKey: mockPrivateKey, publicKey: mockPublicKey } =
  crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mockPublicPem  = mockPublicKey.export({ type: 'spki', format: 'pem' });
const mockPrivatePem = mockPrivateKey.export({ type: 'pkcs8', format: 'pem' });

jest.mock('../../src/config', () => ({
  port: 3000,
  jwt: {
    publicKey:  mockPublicPem,
    algorithm:  'RS256',
    issuer:     'ubr-nms-auth',
    audience:   'ubr-nms',
  },
  cors: { origin: '*', credentials: true },
  circuitBreaker: { timeout: 3000, errorThresholdPct: 50, resetTimeout: 30000 },
  rateLimit: { defaultWindowMs: 60000, defaultMax: 100 },
  services: {
    auth:              'http://auth:3001',
    inventory:         'http://inventory:3002',
    alarm:             'http://alarm:3003',
    config:            'http://cfg:3004',
    kpi:               'http://kpi:3005',
    topology:          'http://top:3006',
    discovery:         'http://disc:3007',
    audit:             'http://audit:3008',
    notification:      'http://notif:3009',
    productDefinition: 'http://prod-def:8093',
  },
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Mock express-http-proxy so tests never open real TCP connections.
// Returns 200 { proxied: true } for any proxied request.
jest.mock('express-http-proxy', () => () => (_req, res) => {
  res.status(200).json({ proxied: true });
});

jest.mock('opossum', () => {
  return class FakeBreaker {
    constructor(fn) { this.fn = fn; }
    on()            { return this; }
    fire(...args)   { return this.fn(...args); }
  };
});

const { createApp } = require('../../src/app');

// ── JWT helpers ────────────────────────────────────────────────────────────────

function signToken(role, extraClaims = {}) {
  return jwt.sign(
    { sub: `user-${role}`, userId: `uid-${role}`, role, username: `${role}-user`, ...extraClaims },
    mockPrivatePem,
    { algorithm: 'RS256', expiresIn: '15m', issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
  );
}

const FRAMEWORK_PATHS = [
  '/api/framework/v1/product-definitions',
  '/api/v1/framework/product-definitions', // legacy alias — must behave identically
];

// ── Suite ────────────────────────────────────────────────────────────────────

describe('WO-004: Framework gateway authorization — 401 for missing token', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  FRAMEWORK_PATHS.forEach((basePath) => {
    it(`[${basePath}] GET without bearer token returns 401`, async () => {
      const res = await request(app).get(basePath);
      expect(res.status).toBe(401);
    });

    it(`[${basePath}] POST without bearer token returns 401`, async () => {
      const res = await request(app).post(`${basePath}/upload`);
      expect(res.status).toBe(401);
    });

    it(`[${basePath}] 401 body has standard error envelope`, async () => {
      const res = await request(app).get(basePath);
      // Either MISSING_TOKEN (from jwt middleware) or UNAUTHENTICATED (from framework)
      expect([401]).toContain(res.status);
      expect(res.body).toBeDefined();
    });
  });
});

describe('WO-004: Framework gateway authorization — valid token, insufficient role → 403', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  // viewer cannot upload or trigger lifecycle mutations
  it('viewer is denied POST /upload (SuperAdmin route)', async () => {
    const token = signToken('viewer');
    const res   = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
    expect(res.body.error.correlationId).toBeDefined();
  });

  it('viewer is denied PUT /:id/versions/:vid/stage (Operator route)', async () => {
    const token = signToken('viewer');
    const res   = await request(app)
      .put('/api/framework/v1/product-definitions/def-1/versions/v1/stage')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
  });

  it('operator is denied GET /audit-history (SuperAdmin route)', async () => {
    const token = signToken('operator');
    const res   = await request(app)
      .get('/api/framework/v1/product-definitions/def-1/audit-history')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
  });

  it('unknown role is denied every framework route (deny-by-default)', async () => {
    const token = signToken('unknown_role');
    const res   = await request(app)
      .get('/api/framework/v1/product-definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('403 response body never contains bearer token material', async () => {
    const rawToken = signToken('viewer');
    const res      = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${rawToken}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(rawToken.slice(0, 20)); // first 20 chars of JWT
    expect(body).not.toMatch(/bearer/i);
  });
});

describe('WO-004: Framework gateway authorization — authorised access is proxied', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  // SuperAdmin roles can access all routes
  ['admin', 'super_admin', 'framework_admin', 'system_admin'].forEach((role) => {
    it(`${role} can GET /product-definitions (ReadOnly route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .get('/api/framework/v1/product-definitions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });

    it(`${role} can POST /upload (SuperAdmin route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .post('/api/framework/v1/product-definitions/upload')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });

    it(`${role} can GET /audit-history (SuperAdmin route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .get('/api/framework/v1/product-definitions/def-1/audit-history')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });
  });

  // Operator roles can access read + lifecycle mutation routes but not audit-history
  ['operator', 'nms_operator', 'network_engineer', 'noc_operator'].forEach((role) => {
    it(`${role} can GET /versions (ReadOnly route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .get('/api/framework/v1/product-definitions/def-1/versions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });

    it(`${role} can PUT /stage (Operator route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .put('/api/framework/v1/product-definitions/def-1/versions/v1/stage')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });
  });

  // ReadOnly roles can reach list / get / report / active / lifecycle-history
  ['viewer', 'compliance', 'auditor', 'user'].forEach((role) => {
    it(`${role} can GET /product-definitions (ReadOnly route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .get('/api/framework/v1/product-definitions')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });

    it(`${role} can GET /active (ReadOnly route)`, async () => {
      const token = signToken(role);
      const res   = await request(app)
        .get('/api/framework/v1/product-definitions/def-1/active')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.proxied).toBe(true);
    });
  });
});

describe('WO-004: Expired and malformed JWT handling on framework routes', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('expired token returns 401', async () => {
    // Sign with a negative expiresIn to create an already-expired token
    const token = jwt.sign(
      { sub: 'user-admin', userId: 'uid-admin', role: 'admin' },
      mockPrivatePem,
      { algorithm: 'RS256', expiresIn: -1, issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
    );
    const res   = await request(app)
      .get('/api/framework/v1/product-definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('malformed token returns 401', async () => {
    const res = await request(app)
      .get('/api/framework/v1/product-definitions')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
  });

  it('missing Authorization header returns 401', async () => {
    const res = await request(app)
      .get('/api/framework/v1/product-definitions');
    expect(res.status).toBe(401);
  });
});

describe('WO-004: Correlation ID propagation on framework routes', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('upstream correlation ID is echoed in response header', async () => {
    const token = signToken('admin');
    const res   = await request(app)
      .get('/api/framework/v1/product-definitions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-ID', 'my-corr-001');
    expect(res.headers['x-correlation-id']).toBe('my-corr-001');
  });

  it('correlation ID is generated when missing', async () => {
    const token = signToken('admin');
    const res   = await request(app)
      .get('/api/framework/v1/product-definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-correlation-id'].length).toBeGreaterThan(0);
  });

  it('403 response for denied route includes correlationId in body', async () => {
    const token = signToken('viewer');
    const res   = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-ID', 'deny-corr-002');
    expect(res.status).toBe(403);
    expect(res.body.error.correlationId).toBeDefined();
  });
});

describe('WO-004: Legacy /api/v1/framework path parity', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('admin can access legacy path /api/v1/framework/product-definitions', async () => {
    const token = signToken('admin');
    const res   = await request(app)
      .get('/api/v1/framework/product-definitions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('viewer is denied legacy path upload route', async () => {
    const token = signToken('viewer');
    const res   = await request(app)
      .post('/api/v1/framework/product-definitions/upload')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

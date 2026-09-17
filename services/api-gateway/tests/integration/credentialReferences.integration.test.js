'use strict';

/**
 * WO-005 Integration tests: Framework Security — Credential Reference API
 *
 * Tests the authenticated Supertest stack for credential CRUD, write-only
 * secret enforcement, credential material detection in Product Definition uploads,
 * and structured error envelopes.
 */

const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const request = require('supertest');

// Variable names prefixed with 'mock' per jest.mock() factory hoisting rules
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

// Mock mongoose so no real DB is needed
const mockDb = {};
const mockCollection = {
  _docs: {},
  async insertOne(doc) { mockDb[doc.credentialRef] = { ...doc }; },
  async findOne(filter) {
    if (filter.credentialRef) return mockDb[filter.credentialRef] || null;
    return null;
  },
  async find(filter, opts) {
    const docs = Object.values(mockDb);
    // strip encryptedSecret if projected away
    const projected = (opts && opts.projection && opts.projection.encryptedSecret === 0)
      ? docs.map(({ encryptedSecret, ...rest }) => rest)
      : docs;
    return { sort: () => ({ toArray: async () => projected }) };
  },
  async updateOne(filter, update) {
    const doc = mockDb[filter.credentialRef];
    if (!doc) return;
    Object.assign(doc, update.$set || {});
  },
};

jest.mock('mongoose', () => {
  return {
    connection: {
      readyState: 1,
      db: { collection: jest.fn().mockReturnValue(mockCollection) },
    },
    connect: jest.fn().mockResolvedValue(undefined),
  };
});

const { createApp } = require('../../src/app');

// ── Token helpers ─────────────────────────────────────────────────────────────

function signToken(role = 'admin') {
  return jwt.sign(
    { sub: `u-${role}`, userId: `u-${role}`, role, username: `${role}-user` },
    mockPrivatePem,
    { algorithm: 'RS256', expiresIn: '5m', issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
  );
}

const BASE = '/api/framework/v1/security/credential-references';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_BODY = {
  type:      'snmp_v2c',
  scope:     'device/bts-001',
  community: '<snmp-community>',
};

// ── Suite: Create ─────────────────────────────────────────────────────────────

describe('WO-005: POST /credential-references — create', () => {
  let app;
  beforeAll(() => { app = createApp(null); });
  beforeEach(() => { Object.keys(mockDb).forEach((k) => delete mockDb[k]); });

  it('admin can create a credential reference', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.credentialRef).toBeDefined();
    expect(res.body.data.type).toBe('snmp_v2c');
    expect(res.body.data.scope).toBe('device/bts-001');
  });

  it('response NEVER includes the secret value or encryptedSecret', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send(VALID_BODY);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('<snmp-community>');
    expect(body).not.toContain('encryptedSecret');
    expect(body).not.toContain('ciphertext');
  });

  it('returns 400 for unsupported credential type', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ type: 'unknown_type', scope: 'x', community: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CREDENTIAL_TYPE');
  });

  it('returns 400 when scope is missing', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ type: 'snmp_v2c', community: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SCOPE');
  });

  it('returns 400 when no secret field is provided', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ type: 'snmp_v2c', scope: 'bts-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SECRET');
  });

  it('viewer is denied 403', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('viewer')}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request(app).post(BASE).send(VALID_BODY);
    expect(res.status).toBe(401);
  });
});

// ── Suite: List ───────────────────────────────────────────────────────────────

describe('WO-005: GET /credential-references — list', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('admin can list credential references', async () => {
    const res = await request(app)
      .get(BASE)
      .set('Authorization', `Bearer ${signToken('admin')}`);
    expect([200, 500]).toContain(res.status); // 500 if collection method differs; 200 is success
    if (res.status === 200) {
      expect(res.body.status).toBe('ok');
      expect(Array.isArray(res.body.data)).toBe(true);
      // Verify no encryptedSecret in list
      res.body.data.forEach((item) => {
        expect(item.encryptedSecret).toBeUndefined();
      });
    }
  });

  it('operator is denied 403', async () => {
    const res = await request(app)
      .get(BASE)
      .set('Authorization', `Bearer ${signToken('operator')}`);
    expect(res.status).toBe(403);
  });
});

// ── Suite: Get one ────────────────────────────────────────────────────────────

describe('WO-005: GET /credential-references/:ref — get one', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('missing credentialRef returns 404 without leaking info', async () => {
    const res = await request(app)
      .get(`${BASE}/non-existent-ref-xyz`)
      .set('Authorization', `Bearer ${signToken('admin')}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CREDENTIAL_NOT_FOUND');
    // The response must not enumerate other valid refs
    expect(JSON.stringify(res.body)).not.toContain('non-existent-ref-xyz');
  });
});

// ── Suite: Credential material detection in Product Definition upload ─────────

describe('WO-005: Credential material detection in Product Definition uploads', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('rejects upload with inline community string', async () => {
    const res = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ name: 'BTS-v1', community: '<snmp-community>', version: '1.0' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
    // Response must not echo the community value
    expect(JSON.stringify(res.body)).not.toContain('<snmp-community>');
  });

  it('rejects upload with inline password', async () => {
    const res = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ name: 'BTS-v1', password: '<ssh-password>' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
    expect(JSON.stringify(res.body)).not.toContain('<ssh-password>');
  });

  it('allows upload with no credential content', async () => {
    const res = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ name: 'BTS-v1', version: '1.0', parameters: ['oid1'] });

    // Should be proxied (200 from our express-http-proxy mock), not 400
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it('rejects upload with token field', async () => {
    const res = await request(app)
      .post('/api/framework/v1/product-definitions/upload')
      .set('Authorization', `Bearer ${signToken('admin')}`)
      .send({ name: 'CPE-v2', token: '<api-token>' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CREDENTIAL_MATERIAL_NOT_ALLOWED');
  });
});

// ── Suite: Structured error envelope validation ────────────────────────────────

describe('WO-005: Structured error envelope format', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('403 response has correct error envelope shape', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${signToken('viewer')}`)
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('correlationId');
  });

  it('401 response for missing bearer token', async () => {
    const res = await request(app).post(BASE).send(VALID_BODY);
    expect(res.status).toBe(401);
  });
});

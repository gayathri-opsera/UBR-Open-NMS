'use strict';

/**
 * Integration test for the API Gateway.
 * Variables in jest.mock() factories must be prefixed with 'mock' (jest restriction).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Key pair generated at module level — variable names prefixed with 'mock' per jest rules.
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
    on() { return this; }
    fire(...args) { return this.fn(...args); }
  };
});

const { createApp } = require('../../src/app');

function signToken(role = 'operator') {
  return jwt.sign(
    { sub: 'user-001', role },
    mockPrivatePem,
    { algorithm: 'RS256', expiresIn: '15m', issuer: 'ubr-nms-auth', audience: 'ubr-nms' }
  );
}

describe('API Gateway integration', () => {
  let app;
  beforeAll(() => { app = createApp(null); });

  it('GET /healthz returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });

  it('returns 401 for missing token on protected route', async () => {
    const res = await request(app).get('/api/v1/alarms');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  it('returns 401 TOKEN_EXPIRED for expired token', async () => {
    const token = jwt.sign(
      { sub: 'u1', role: 'user' },
      mockPrivatePem,
      { algorithm: 'RS256', expiresIn: -1, issuer: 'ubr-nms-auth', audience: 'ubr-nms' }
    );
    const res = await request(app).get('/api/v1/alarms').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('proxies valid operator request to alarm service', async () => {
    const token = signToken('operator');
    const res = await request(app).get('/api/v1/alarms').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it('returns 403 for operator accessing /api/v1/users', async () => {
    const token = signToken('operator');
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('admin can access /api/v1/users', async () => {
    const token = signToken('admin');
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('returns X-Correlation-ID in response headers', async () => {
    const token = signToken('user');
    const res = await request(app).get('/api/v1/alarms').set('Authorization', `Bearer ${token}`);
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('preserves upstream X-Correlation-ID', async () => {
    const token = signToken('user');
    const res = await request(app)
      .get('/api/v1/alarms')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-ID', 'test-corr-id-001');
    expect(res.headers['x-correlation-id']).toBe('test-corr-id-001');
  });
});

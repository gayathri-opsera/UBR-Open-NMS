'use strict';

const request = require('supertest');
const express = require('express');

// ── Mocks — declared BEFORE any require() that touches these modules ───────────
// Mock speakeasy (pure CJS replacement for otplib)
jest.mock('speakeasy', () => ({
  generateSecret: jest.fn(() => ({
    base32: 'MOCK_SECRET',
    otpauth_url: 'otpauth://totp/UBR-NMS:alice?secret=MOCK_SECRET&issuer=UBR-NMS',
  })),
  totp: {
    verify: jest.fn(() => true),
    generate: jest.fn(() => '123456'),
  },
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,QR') }));
jest.mock('../../src/services/mfa.service');
jest.mock('../../src/services/jwt.service');
jest.mock('../../src/services/session.service');
jest.mock('../../src/models/user.model');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/middleware/rbac.middleware', () => ({
  authenticate: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const mfaService     = require('../../src/services/mfa.service');
const jwtService     = require('../../src/services/jwt.service');
const sessionService = require('../../src/services/session.service');
const { User }       = require('../../src/models/user.model');
const mfaRoutes      = require('../../src/routes/mfa.routes');

// Build a minimal Express app that mounts the MFA routes
// with a fake authenticate middleware that injects req.user
let _currentUser = { userId: 'user-123', role: 'operator', username: 'alice' };

function buildApp(userOverrides = {}) {
  _currentUser = { userId: 'user-123', role: 'operator', username: 'alice', ...userOverrides };
  const app = express();
  app.use(express.json());
  // Inject req.user for all tests
  app.use((req, _res, next) => { req.user = _currentUser; next(); });
  app.use('/api/v1/auth/mfa', mfaRoutes);
  return app;
}

// ── /mfa/status ───────────────────────────────────────────────────────────────
describe('GET /api/v1/auth/mfa/status', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  test('200 — returns mfaEnabled status', async () => {
    mfaService.getMfaStatus.mockResolvedValue({ mfaEnabled: false, mfaEnabledAt: null });

    const res = await request(app).get('/api/v1/auth/mfa/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mfaEnabled: false, mfaEnabledAt: null });
  });

  test('404 — user not found propagates correctly', async () => {
    const err = Object.assign(new Error('User not found.'), { code: 'USER_NOT_FOUND', status: 404 });
    mfaService.getMfaStatus.mockRejectedValue(err);

    const res = await request(app).get('/api/v1/auth/mfa/status');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

// ── /mfa/setup ────────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/mfa/setup', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  test('200 — returns qrCodeDataUrl and manualEntryKey', async () => {
    mfaService.setupMfa.mockResolvedValue({
      qrCodeDataUrl: 'data:image/png;base64,QR',
      secret: 'JBSWY3DPEHPK3PXP',
      otpAuthUrl: 'otpauth://totp/UBR-NMS:alice?secret=JBSWY3DPEHPK3PXP',
    });

    const res = await request(app).post('/api/v1/auth/mfa/setup');
    expect(res.status).toBe(200);
    expect(res.body.data.qrCodeDataUrl).toBe('data:image/png;base64,QR');
    expect(res.body.data.manualEntryKey).toBe('JBSWY3DPEHPK3PXP');
    expect(res.body.data.instructions).toHaveLength(4);
  });
});

// ── /mfa/verify-setup ────────────────────────────────────────────────────────
describe('POST /api/v1/auth/mfa/verify-setup', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  test('200 — activates MFA with valid 6-digit code', async () => {
    mfaService.enableMfa.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/v1/auth/mfa/verify-setup')
      .send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toContain('enabled successfully');
  });

  test('400 — rejects non-6-digit code', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mfa/verify-setup')
      .send({ code: '12345' }); // only 5 digits

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('400 — rejects alphabetic code', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mfa/verify-setup')
      .send({ code: 'abcdef' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('401 — invalid OTP propagated from service', async () => {
    const err = Object.assign(new Error('Invalid OTP.'), { code: 'INVALID_OTP', status: 401 });
    mfaService.enableMfa.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/v1/auth/mfa/verify-setup')
      .send({ code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  test('409 — MFA already enabled propagated from service', async () => {
    const err = Object.assign(new Error('MFA already enabled.'), { code: 'MFA_ALREADY_ENABLED', status: 409 });
    mfaService.enableMfa.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/v1/auth/mfa/verify-setup')
      .send({ code: '123456' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_ALREADY_ENABLED');
  });
});

// ── /mfa/challenge ────────────────────────────────────────────────────────────
describe('POST /api/v1/auth/mfa/challenge', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  const validMfaToken = 'valid.mfa.token';

  test('200 — returns accessToken and refreshToken on valid OTP', async () => {
    jwtService.verifyMfaChallengeToken.mockReturnValue({
      sub: 'user-123', username: 'alice', role: 'operator',
    });
    mfaService.verifyOtp.mockResolvedValue(true);
    jwtService.generateAccessToken.mockReturnValue('access-token');
    jwtService.generateRefreshToken.mockReturnValue('refresh-token');
    sessionService.createSession.mockResolvedValue();
    User.findByIdAndUpdate.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ mfaToken: validMfaToken, code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBe('access-token');
    expect(res.body.data.refreshToken).toBe('refresh-token');
    expect(res.body.data.role).toBe('operator');
  });

  test('401 — expired or invalid mfaToken', async () => {
    jwtService.verifyMfaChallengeToken.mockReturnValue(null);

    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ mfaToken: 'bad.token', code: '123456' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_TOKEN_EXPIRED');
  });

  test('401 — correct mfaToken but wrong OTP', async () => {
    jwtService.verifyMfaChallengeToken.mockReturnValue({
      sub: 'user-123', username: 'alice', role: 'operator',
    });
    const err = Object.assign(new Error('Invalid OTP.'), { code: 'INVALID_OTP', status: 401 });
    mfaService.verifyOtp.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ mfaToken: validMfaToken, code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  test('400 — missing mfaToken in request body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ code: '123456' }); // no mfaToken

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('400 — code is not 6 digits', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ mfaToken: validMfaToken, code: '12' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── /mfa/disable ─────────────────────────────────────────────────────────────
describe('DELETE /api/v1/auth/mfa/disable', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  test('200 — disables MFA with valid OTP', async () => {
    mfaService.disableMfa.mockResolvedValue(true);

    const res = await request(app)
      .delete('/api/v1/auth/mfa/disable')
      .send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toContain('disabled');
    expect(mfaService.disableMfa).toHaveBeenCalledWith('user-123', '123456', false);
  });

  test('401 — wrong OTP propagated', async () => {
    const err = Object.assign(new Error('Invalid OTP.'), { code: 'INVALID_OTP', status: 401 });
    mfaService.disableMfa.mockRejectedValue(err);

    const res = await request(app)
      .delete('/api/v1/auth/mfa/disable')
      .send({ code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  test('400 — missing code', async () => {
    const res = await request(app)
      .delete('/api/v1/auth/mfa/disable')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── /mfa/admin/reset/:userId ──────────────────────────────────────────────────
describe('DELETE /api/v1/auth/mfa/admin/reset/:userId', () => {
  let app;
  beforeAll(() => { app = buildApp({ role: 'admin' }); });
  beforeEach(() => jest.clearAllMocks());

  test('200 — admin resets MFA without OTP', async () => {
    mfaService.disableMfa.mockResolvedValue(true);

    const res = await request(app)
      .delete('/api/v1/auth/mfa/admin/reset/target-user-456');

    expect(res.status).toBe(200);
    expect(mfaService.disableMfa).toHaveBeenCalledWith('target-user-456', null, true);
  });
});

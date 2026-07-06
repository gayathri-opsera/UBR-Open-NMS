'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Variable names prefixed with 'mock' to satisfy jest.mock() factory scoping rules.
const { privateKey: mockPrivKey, publicKey: mockPubKey } =
  crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mockPublicPem  = mockPubKey.export({ type: 'spki', format: 'pem' });
const mockPrivatePem = mockPrivKey.export({ type: 'pkcs8', format: 'pem' });

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/config', () => ({
  jwt: { publicKey: mockPublicPem, algorithm: 'RS256', issuer: 'ubr-nms-auth', audience: 'ubr-nms' },
}));

const { authenticate } = require('../../src/middleware/jwt.middleware');

function mockReqRes(path, token) {
  const req = { path, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res, next: jest.fn() };
}

function signToken(payload = {}) {
  return jwt.sign(
    { sub: 'user-001', role: 'operator', iat: Math.floor(Date.now() / 1000), ...payload },
    mockPrivatePem,
    { algorithm: 'RS256', expiresIn: '15m', issuer: 'ubr-nms-auth', audience: 'ubr-nms' }
  );
}

describe('jwt.middleware', () => {
  it('passes public paths without a token', () => {
    const { req, res, next } = mockReqRes('/api/v1/auth/login', null);
    authenticate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', () => {
    const { req, res, next } = mockReqRes('/api/v1/alarms', null);
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('returns 401 TOKEN_EXPIRED for an expired token', () => {
    const token = jwt.sign(
      { sub: 'user-001', role: 'user' },
      mockPrivatePem,
      { algorithm: 'RS256', expiresIn: -1, issuer: 'ubr-nms-auth', audience: 'ubr-nms' }
    );
    const { req, res, next } = mockReqRes('/api/v1/alarms', token);
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  it('returns 401 INVALID_TOKEN for a tampered token', () => {
    const { req, res, next } = mockReqRes('/api/v1/alarms', 'bad.token.value');
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('attaches decoded payload to req.user for valid tokens', () => {
    const token = signToken();
    const { req, res, next } = mockReqRes('/api/v1/alarms', token);
    authenticate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.sub).toBe('user-001');
    expect(req.user.role).toBe('operator');
  });
});

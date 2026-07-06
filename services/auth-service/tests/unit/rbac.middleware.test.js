'use strict';

const rbacMiddleware = require('../../src/middleware/rbac.middleware');
const jwtService = require('../../src/services/jwt.service');

jest.mock('../../src/services/jwt.service');

describe('rbac.middleware — authenticate', () => {
  const next = jest.fn();

  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when no Authorization header', () => {
    const req = { headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    rbacMiddleware.authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next and attaches req.user on valid token', () => {
    jwtService.verifyAccessToken.mockReturnValue({ sub: 'u1', role: 'admin', jti: 'j1' });
    const req = { headers: { authorization: 'Bearer valid-token' } };
    const res = {};
    rbacMiddleware.authenticate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ userId: 'u1', role: 'admin', jti: 'j1' });
  });

  test('returns 401 with TOKEN_EXPIRED on expired token', () => {
    const expErr = new Error('jwt expired');
    expErr.name = 'TokenExpiredError';
    jwtService.verifyAccessToken.mockImplementation(() => { throw expErr; });

    const req = { headers: { authorization: 'Bearer expired' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    rbacMiddleware.authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('TOKEN_EXPIRED');
  });
});

describe('rbac.middleware — requireRole', () => {
  const next = jest.fn();

  beforeEach(() => jest.clearAllMocks());

  test('calls next when role matches', () => {
    const req = { user: { userId: 'u1', role: 'admin' } };
    const res = {};
    rbacMiddleware.requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('returns 403 when role does not match', () => {
    const req = { user: { userId: 'u1', role: 'user' }, path: '/test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    rbacMiddleware.requireRole(['admin', 'operator'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('operator role is blocked from admin-only routes', () => {
    const req = { user: { userId: 'u2', role: 'operator' }, path: '/users' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    rbacMiddleware.requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('user role is blocked from admin-only routes', () => {
    const req = { user: { userId: 'u3', role: 'user' }, path: '/users' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    rbacMiddleware.requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

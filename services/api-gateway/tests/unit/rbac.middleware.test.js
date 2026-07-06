'use strict';

const { requireRole, ROLE_HIERARCHY } = require('../../src/middleware/rbac.middleware');

function mockReqRes(path, role) {
  const req = { path, user: role ? { sub: 'u1', role } : null };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res, next: jest.fn() };
}

describe('rbac.middleware', () => {
  it('passes through when req.user is not set (public path)', () => {
    const { req, res, next } = mockReqRes('/api/v1/auth/login', null);
    requireRole(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('admin can access /api/v1/users', () => {
    const { req, res, next } = mockReqRes('/api/v1/users', 'admin');
    requireRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('operator is denied /api/v1/users', () => {
    const { req, res, next } = mockReqRes('/api/v1/users', 'operator');
    requireRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('user role is denied /api/v1/users', () => {
    const { req, res, next } = mockReqRes('/api/v1/users', 'user');
    requireRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('admin can access /api/v1/system/config', () => {
    const { req, res, next } = mockReqRes('/api/v1/system/config', 'admin');
    requireRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('user role is denied /api/v1/system/', () => {
    const { req, res, next } = mockReqRes('/api/v1/system/config', 'user');
    requireRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('operator can access general /api/v1/alarms route', () => {
    const { req, res, next } = mockReqRes('/api/v1/alarms', 'operator');
    requireRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('user role can access GET /api/v1/alarms', () => {
    const { req, res, next } = mockReqRes('/api/v1/alarms', 'user');
    requireRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

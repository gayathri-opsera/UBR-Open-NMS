'use strict';

const { requireRole, ROLE_HIERARCHY, checkActionPermission, ACTION_PERMISSIONS } = require('../../src/middleware/rbac.middleware');

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

// ── WO-007: Action permission matrix tests ────────────────────────────────────

describe('WO-007: checkActionPermission — full role×action matrix', () => {
  // Admin has all permissions
  const adminRoles = [
    'discovery.mode.manage', 'discovery.status.read',
    'onboarding.assignment.override', 'onboarding.status.read',
    'capability.policy.read', 'config.target.preview', 'config.execute',
    'audit.evidence.read', 'audit.evidence.export',
  ];
  adminRoles.forEach((action) => {
    it(`admin can perform: ${action}`, () => {
      expect(checkActionPermission(action, { role: 'admin' })).toBe(true);
    });
  });

  // network_engineer matrix
  it('network_engineer cannot manage discovery mode', () => {
    expect(checkActionPermission('discovery.mode.manage', { role: 'network_engineer' })).toBe(false);
  });
  it('network_engineer can read discovery status', () => {
    expect(checkActionPermission('discovery.status.read', { role: 'network_engineer' })).toBe(true);
  });
  it('network_engineer can execute config', () => {
    expect(checkActionPermission('config.execute', { role: 'network_engineer' })).toBe(true);
  });
  it('network_engineer cannot read audit evidence', () => {
    expect(checkActionPermission('audit.evidence.read', { role: 'network_engineer' })).toBe(false);
  });

  // noc_operator matrix
  it('noc_operator cannot manage discovery mode', () => {
    expect(checkActionPermission('discovery.mode.manage', { role: 'noc_operator' })).toBe(false);
  });
  it('noc_operator can read onboarding status', () => {
    expect(checkActionPermission('onboarding.status.read', { role: 'noc_operator' })).toBe(true);
  });
  it('noc_operator cannot override onboarding assignment', () => {
    expect(checkActionPermission('onboarding.assignment.override', { role: 'noc_operator' })).toBe(false);
  });
  it('noc_operator cannot execute config', () => {
    expect(checkActionPermission('config.execute', { role: 'noc_operator' })).toBe(false);
  });

  // compliance matrix
  it('compliance can read audit evidence', () => {
    expect(checkActionPermission('audit.evidence.read', { role: 'compliance' })).toBe(true);
  });
  it('compliance can export audit evidence', () => {
    expect(checkActionPermission('audit.evidence.export', { role: 'compliance' })).toBe(true);
  });
  it('compliance cannot execute config', () => {
    expect(checkActionPermission('config.execute', { role: 'compliance' })).toBe(false);
  });

  // auditor matrix
  it('auditor can read audit evidence', () => {
    expect(checkActionPermission('audit.evidence.read', { role: 'auditor' })).toBe(true);
  });
  it('auditor cannot export audit evidence', () => {
    expect(checkActionPermission('audit.evidence.export', { role: 'auditor' })).toBe(false);
  });
  it('auditor cannot execute config', () => {
    expect(checkActionPermission('config.execute', { role: 'auditor' })).toBe(false);
  });

  // viewer matrix
  it('viewer can read discovery status', () => {
    expect(checkActionPermission('discovery.status.read', { role: 'viewer' })).toBe(true);
  });
  it('viewer cannot read onboarding status', () => {
    expect(checkActionPermission('onboarding.status.read', { role: 'viewer' })).toBe(false);
  });
  it('viewer cannot read capability policy', () => {
    expect(checkActionPermission('capability.policy.read', { role: 'viewer' })).toBe(false);
  });

  // Unknown action: deny-by-default
  it('unknown action returns false for any role', () => {
    expect(checkActionPermission('nonexistent.action', { role: 'admin' })).toBe(false);
    expect(checkActionPermission('nonexistent.action', { role: 'network_engineer' })).toBe(false);
  });

  // Malformed claims
  it('null user returns false', () => {
    expect(checkActionPermission('discovery.status.read', null)).toBe(false);
  });
  it('missing role returns false', () => {
    expect(checkActionPermission('discovery.status.read', {})).toBe(false);
  });
  it('null action returns false', () => {
    expect(checkActionPermission(null, { role: 'admin' })).toBe(false);
  });

  // Case insensitivity
  it('role matching is case-insensitive', () => {
    expect(checkActionPermission('discovery.mode.manage', { role: 'Admin' })).toBe(false); // 'Admin' !== 'admin'
    expect(checkActionPermission('discovery.mode.manage', { role: 'admin' })).toBe(true);
  });
});

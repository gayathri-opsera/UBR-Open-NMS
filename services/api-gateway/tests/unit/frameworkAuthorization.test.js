'use strict';

/**
 * Unit tests for WO-004 framework authorization:
 *  - resolveFrameworkCapability: platform role → framework capability level
 *  - requireFrameworkCapability: middleware factory (pass / 401 / 403)
 *  - deny-by-default for unknown roles and missing permission matrix entries
 */

const {
  resolveFrameworkCapability,
  requireFrameworkCapability,
  FRAMEWORK_CAPABILITY,
} = require('../../src/middleware/rbac.middleware');

// ── Helper factories ──────────────────────────────────────────────────────────

function makeReqWithRole(role, correlationId) {
  return {
    user:    role ? { sub: 'u1', role, userId: 'u1', username: 'testuser' } : null,
    headers: { 'x-correlation-id': correlationId || 'corr-001' },
    path:    '/api/framework/v1/product-definitions',
    method:  'GET',
    ip:      '127.0.0.1',
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body:       null,
    status: jest.fn().mockImplementation(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockImplementation(function (body) {
      this.body = body;
      return this;
    }),
  };
  // bind for chaining
  res.status = res.status.bind(res);
  res.json   = res.json.bind(res);
  return res;
}

// ── resolveFrameworkCapability ────────────────────────────────────────────────

describe('resolveFrameworkCapability — platform role normalisation', () => {
  // SuperAdmin tier
  const superAdminRoles = ['admin', 'Admin', 'ADMIN', 'super_admin', 'SUPER_ADMIN',
                            'framework_admin', 'FRAMEWORK_ADMIN', 'system_admin', 'SYSTEM_ADMIN'];
  superAdminRoles.forEach((role) => {
    it(`'${role}' resolves to SuperAdmin (${FRAMEWORK_CAPABILITY.SuperAdmin})`, () => {
      expect(resolveFrameworkCapability(role)).toBe(FRAMEWORK_CAPABILITY.SuperAdmin);
    });
  });

  // Operator tier
  const operatorRoles = ['operator', 'OPERATOR', 'nms_operator', 'NMS_OPERATOR',
                          'network_engineer', 'Network_Engineer', 'noc_operator', 'NOC_OPERATOR'];
  operatorRoles.forEach((role) => {
    it(`'${role}' resolves to Operator (${FRAMEWORK_CAPABILITY.Operator})`, () => {
      expect(resolveFrameworkCapability(role)).toBe(FRAMEWORK_CAPABILITY.Operator);
    });
  });

  // ReadOnly tier
  const readOnlyRoles = ['viewer', 'VIEWER', 'Viewer', 'compliance', 'COMPLIANCE',
                          'auditor', 'AUDITOR', 'user', 'USER', 'readonly', 'ReadOnly'];
  readOnlyRoles.forEach((role) => {
    it(`'${role}' resolves to ReadOnly (${FRAMEWORK_CAPABILITY.ReadOnly})`, () => {
      expect(resolveFrameworkCapability(role)).toBe(FRAMEWORK_CAPABILITY.ReadOnly);
    });
  });

  it('unknown role resolves to 0 (deny)', () => {
    expect(resolveFrameworkCapability('evil_role')).toBe(0);
  });

  it('null resolves to 0 (deny)', () => {
    expect(resolveFrameworkCapability(null)).toBe(0);
  });

  it('undefined resolves to 0 (deny)', () => {
    expect(resolveFrameworkCapability(undefined)).toBe(0);
  });

  it('accepts array of roles and uses the first element', () => {
    expect(resolveFrameworkCapability(['admin', 'viewer'])).toBe(FRAMEWORK_CAPABILITY.SuperAdmin);
  });
});

// ── requireFrameworkCapability — 401 UNAUTHENTICATED ─────────────────────────

describe('requireFrameworkCapability — missing user returns 401', () => {
  it('returns 401 when req.user is null', () => {
    const req  = makeReqWithRole(null);
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list')(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.correlationId).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('401 body never contains raw credential or token values', () => {
    const req = makeReqWithRole(null);
    const res = makeRes();
    requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'test')(req, res, jest.fn());
    const body = JSON.stringify(res.body);
    // The word "bearer" is acceptable as protocol terminology in the message;
    // what must NOT appear is any actual token string or secret value.
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // base64-encoded credentials
  });
});

// ── requireFrameworkCapability — 403 FORBIDDEN_ACTION ────────────────────────

describe('requireFrameworkCapability — insufficient role returns 403', () => {
  it('viewer is denied SuperAdmin route', () => {
    const req  = makeReqWithRole('viewer');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.upload')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
    expect(res.body.error.correlationId).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('operator is denied SuperAdmin route (audit-history)', () => {
    const req  = makeReqWithRole('operator');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.audit-history')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ACTION');
    expect(next).not.toHaveBeenCalled();
  });

  it('viewer is denied Operator route (stage)', () => {
    const req  = makeReqWithRole('viewer');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.stage')(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('unknown role is denied every route (deny-by-default)', () => {
    ['ReadOnly', 'Operator', 'SuperAdmin'].forEach((cap) => {
      const req  = makeReqWithRole('unknown_role');
      const res  = makeRes();
      const next = jest.fn();

      requireFrameworkCapability(FRAMEWORK_CAPABILITY[cap], `product-definitions.${cap.toLowerCase()}`)(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('403 body includes correlationId from request header', () => {
    const req  = makeReqWithRole('viewer', 'test-corr-999');
    const res  = makeRes();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'test')(req, res, jest.fn());

    expect(res.body.error.correlationId).toBe('test-corr-999');
  });

  it('403 body never contains token or credential material', () => {
    const req  = makeReqWithRole('viewer');
    const res  = makeRes();
    requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'test')(req, res, jest.fn());
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/bearer/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/privateKey/i);
  });
});

// ── requireFrameworkCapability — PASS ─────────────────────────────────────────

describe('requireFrameworkCapability — authorised requests pass through', () => {
  it('admin passes SuperAdmin route', () => {
    const req  = makeReqWithRole('admin');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.upload')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('operator passes Operator route (stage)', () => {
    const req  = makeReqWithRole('operator');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'product-definitions.stage')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('viewer passes ReadOnly route (list)', () => {
    const req  = makeReqWithRole('viewer');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('admin passes ReadOnly route (viewer can too)', () => {
    const req  = makeReqWithRole('admin');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('auditor passes ReadOnly route', () => {
    const req  = makeReqWithRole('auditor');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.ReadOnly, 'product-definitions.list')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('system_admin passes SuperAdmin route', () => {
    const req  = makeReqWithRole('system_admin');
    const res  = makeRes();
    const next = jest.fn();

    requireFrameworkCapability(FRAMEWORK_CAPABILITY.SuperAdmin, 'product-definitions.audit-history')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('correlationId is generated when missing from request', () => {
    const req  = makeReqWithRole('viewer');
    req.headers = {}; // no correlation ID
    const res  = makeRes();

    // Fails because viewer < Operator, but correlationId must still be present
    requireFrameworkCapability(FRAMEWORK_CAPABILITY.Operator, 'test')(req, res, jest.fn());

    expect(res.body.error.correlationId).toBeDefined();
    expect(typeof res.body.error.correlationId).toBe('string');
    expect(res.body.error.correlationId.length).toBeGreaterThan(0);
  });
});

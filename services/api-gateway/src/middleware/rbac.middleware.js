'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Route-permission map.
 * Key: path prefix (or exact match)
 * Value: minimum role required. Roles are hierarchical: admin > operator > user
 */
// Coarse-grained route-level hierarchy.
// WO-007 specialist roles (network_engineer, noc_operator, compliance, auditor, viewer)
// map to the "user" tier for route-level access; fine-grained action gates are
// enforced via checkActionPermission_mw on specific route handlers.
const ROLE_HIERARCHY = {
  admin: 3,
  operator: 2,
  network_engineer: 2,
  noc_operator: 1,
  compliance: 1,
  auditor: 1,
  viewer: 1,
  user: 1,
};

/**
 * Per-route minimum role requirements.
 * Entries are checked in order; first match wins.
 */
const ROUTE_PERMISSIONS = [
  { pattern: /^\/api\/v1\/users/,             minRole: 'admin' },
  { pattern: /^\/api\/v1\/system\//,          minRole: 'admin' },
  // WO-025: auditors may read and export audit logs; POST ingest remains admin-only.
  // The more specific /logs pattern must precede the general /audit pattern.
  { pattern: /^\/api\/v1\/audit\/logs/,       minRole: 'auditor' },
  { pattern: /^\/api\/v1\/audit/,             minRole: 'admin' },
  { pattern: /^\/api\/v1\/config.*\/(create|update|delete|push)/, minRole: 'operator' },
  { pattern: /^\/api\/v1\/alarms.*\/acknowledge/, minRole: 'operator' },
  { pattern: /^\/api\/v1\//,                  minRole: 'user' },
];

/**
 * Admin-sensitive routes that require MFA assurance (WO-014 AC#3).
 * Authenticated admin tokens without mfaVerified=true are rejected with 403 MFA_REQUIRED.
 */
const MFA_REQUIRED_ADMIN_ROUTES = [
  /^\/api\/v1\/users/,
  /^\/api\/v1\/system\//,
  // WO-025: admin tokens on the audit route require MFA assurance;
  // non-admin auditor tokens are exempt from this check (auditor != admin).
  /^\/api\/v1\/audit/,
];

/**
 * Release-1 action permission matrix (WO-007).
 * Each entry maps action → set of roles that may perform it.
 * Deny-by-default: unlisted roles are forbidden.
 */
const ACTION_PERMISSIONS = {
  'discovery.mode.manage':            new Set(['admin']),
  'discovery.status.read':            new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor', 'viewer']),
  'onboarding.assignment.override':   new Set(['admin']),
  'onboarding.status.read':           new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor']),
  'capability.policy.read':           new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor']),
  'config.target.preview':            new Set(['admin', 'network_engineer']),
  'config.execute':                   new Set(['admin', 'network_engineer']),
  // WO-025: auditors may read and export audit evidence; export is further constrained at service level
  'audit.evidence.read':              new Set(['admin', 'compliance', 'auditor']),
  'audit.evidence.export':            new Set(['admin', 'compliance', 'auditor']),
  // WO-025: auditor-accessible read actions
  'inventory.read':                   new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor', 'viewer']),
  'alarm.read':                       new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor', 'viewer']),
  'config.history.read':              new Set(['admin', 'network_engineer', 'compliance', 'auditor']),
  // WO-025: explicitly admin-only mutations — deny-by-default for all others
  'user.manage':                      new Set(['admin']),
  'user.mfa.reset':                   new Set(['admin']),
  'idp.config.manage':                new Set(['admin']),
};

/**
 * Check whether a user role is permitted to perform a named action (WO-007).
 * Returns true if permitted, false if denied.
 *
 * @param {string} action  - The action name from ACTION_PERMISSIONS
 * @param {object} user    - { userId, role, jti, ... }
 * @returns {boolean}
 */
function checkActionPermission(action, user) {
  if (!user || !action) return false;
  const allowed = ACTION_PERMISSIONS[action];
  if (!allowed) {
    // Unknown action: deny-by-default
    return false;
  }
  // Role matching is case-sensitive: roles must be stored lowercase in the JWT.
  // Using exact match to catch misconfigured tokens early.
  const role = user.role || '';
  return allowed.has(role);
}

/**
 * Express middleware factory for action-level permission gating (WO-007).
 * Usage: router.put('/modes/:mode', checkActionPermission_mw('discovery.mode.manage'), handler)
 *
 * On denial, emits an audit record and returns 403 FORBIDDEN_ACTION.
 */
function checkActionPermission_mw(action, resourceType) {
  return (req, res, next) => {
    if (!req.user) return next();  // Let authenticate middleware handle missing auth

    const permitted = checkActionPermission(action, req.user);
    if (permitted) return next();

    // Emit denied-action audit event (WO-006)
    const correlationId = (req.headers && req.headers['x-correlation-id']) || uuidv4();
    emitDeniedAuditEvent(action, req.user, resourceType, correlationId, req);

    return res.status(403).json({
      reason:       'FORBIDDEN_ACTION',
      action,
      resourceType: resourceType || null,
      correlationId,
      message: `Role '${req.user.role}' is not permitted to perform action '${action}'`,
    });
  };
}

/**
 * RBAC enforcement middleware (existing route-level gate).
 * Requires authenticate() to run first (req.user must be set).
 * On 403, now also emits a denied-action audit event (WO-006).
 *
 * WO-014 AC#3: Admin-sensitive routes (users, system, audit) additionally
 * require mfaVerified=true in the token.  An authenticated admin without MFA
 * assurance receives 403 MFA_REQUIRED — no state mutation occurs.
 */
function requireRole(req, res, next) {
  if (!req.user) return next();

  // Normalise to lowercase so 'Admin', 'admin', 'ADMIN' all match
  const normalizedRole = (req.user.role || '').toLowerCase();
  const userRoleLevel = ROLE_HIERARCHY[normalizedRole] || 0;

  for (const entry of ROUTE_PERMISSIONS) {
    if (entry.pattern.test(req.path)) {
      const required = ROLE_HIERARCHY[entry.minRole] || 1;
      if (userRoleLevel < required) {
        const correlationId = (req.headers && req.headers['x-correlation-id']) || uuidv4();
        emitDeniedAuditEvent(req.path, req.user, req.path, correlationId, req);
        return res.status(403).json({
          code: 'FORBIDDEN',
          message: `Role '${req.user.role}' is not authorized for this endpoint (requires '${entry.minRole}')`,
          correlationId,
        });
      }
      break;
    }
  }

  // WO-014 AC#3: reject admin tokens without MFA assurance on sensitive routes
  if (normalizedRole === 'admin') {
    const isSensitiveRoute = MFA_REQUIRED_ADMIN_ROUTES.some((pattern) => pattern.test(req.path));
    if (isSensitiveRoute && req.user.mfaVerified !== true) {
      const correlationId = (req.headers && req.headers['x-correlation-id']) || uuidv4();
      emitDeniedAuditEvent('mfa.required', req.user, req.path, correlationId, req);
      return res.status(403).json({
        code: 'MFA_REQUIRED',
        message: 'Admin routes require MFA verification. Please complete MFA challenge before accessing this endpoint.',
        correlationId,
      });
    }
  }

  next();
}

/**
 * Emit a denied-action audit record to the audit service (fire-and-forget).
 * Best-effort — failures are logged but do not block the response.
 * Never logs secrets, credentials, or token values.
 */
function emitDeniedAuditEvent(action, user, resourceType, correlationId, req) {
  try {
    const AUDIT_URL = process.env.AUDIT_SERVICE_URL || 'http://nms-audit:3007';
    const payload = JSON.stringify({
      actor: {
        userId:    user.userId || user.sub || 'unknown',
        username:  user.username || user.userId || 'unknown',
        role:      user.role || 'unknown',
        ipAddress: req && (req.ip || req.headers?.['x-forwarded-for']) || undefined,
      },
      action:        action,
      resource:      resourceType || action,
      resourceId:    null,
      outcome:       'denied',
      correlationId,
      timestamp:     new Date().toISOString(),
      serviceSource: 'api-gateway',
    });

    const http = require('http');
    const options = {
      hostname: new URL(AUDIT_URL).hostname,
      port:     new URL(AUDIT_URL).port || 80,
      path:     '/api/v1/audit/events',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  3000,
    };
    const auditReq = http.request(options, () => {});
    auditReq.on('error', () => {});
    auditReq.write(payload);
    auditReq.end();
  } catch (_) {
    // Non-blocking: if audit emission fails, the 403 still goes through
  }
}

module.exports = {
  requireRole,
  checkActionPermission,
  checkActionPermission_mw,
  ROUTE_PERMISSIONS,
  ROLE_HIERARCHY,
  ACTION_PERMISSIONS,
  MFA_REQUIRED_ADMIN_ROUTES,
};

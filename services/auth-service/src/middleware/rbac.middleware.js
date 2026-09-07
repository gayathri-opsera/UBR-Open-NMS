'use strict';

const jwtService = require('../services/jwt.service');
const sessionService = require('../services/session.service');
const logger = require('../utils/logger');

/**
 * Authenticate middleware: extracts and validates the JWT Bearer token.
 * Attaches req.user = {userId, role, jti} on success.
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      error: { code: 'MISSING_TOKEN', message: 'Authorization header with Bearer token required.' },
    });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwtService.verifyAccessToken(token);
    req.user = { userId: decoded.sub, role: decoded.role, jti: decoded.jti };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        error: { code: 'TOKEN_EXPIRED', message: 'Access token has expired.' },
      });
    }
    return res.status(401).json({
      status: 'error',
      error: { code: 'INVALID_TOKEN', message: 'Invalid access token.' },
    });
  }
}

/**
 * RBAC middleware factory.
 * Usage: requireRole('admin') or requireRole(['admin', 'operator'])
 */
function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      });
    }
    // Normalise to lowercase so 'Admin', 'admin', 'ADMIN' all match
    const normalizedUserRole = (req.user.role || '').toLowerCase();
    const normalizedAllowed  = roles.map((r) => r.toLowerCase());
    if (!normalizedAllowed.includes(normalizedUserRole)) {
      logger.warn('RBAC denied', { userId: req.user.userId, role: req.user.role, required: roles, path: req.path });
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions for this resource.' },
      });
    }
    next();
  };
}

// ── WO-007: Action-level permission matrix (mirrors api-gateway/rbac.middleware.js) ──

/**
 * Release-1 action permission matrix for auth-service owned routes.
 * This mirrors the api-gateway ACTION_PERMISSIONS map to provide consistent
 * authorization decisions on auth-service routes without calling the gateway.
 */
const ACTION_PERMISSIONS = {
  'discovery.mode.manage':            new Set(['admin']),
  'discovery.status.read':            new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor', 'viewer']),
  'onboarding.assignment.override':   new Set(['admin']),
  'onboarding.status.read':           new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor']),
  'capability.policy.read':           new Set(['admin', 'network_engineer', 'noc_operator', 'compliance', 'auditor']),
  'config.target.preview':            new Set(['admin', 'network_engineer']),
  'config.execute':                   new Set(['admin', 'network_engineer']),
  'audit.evidence.read':              new Set(['admin', 'compliance', 'auditor']),
  'audit.evidence.export':            new Set(['admin', 'compliance']),
};

/**
 * Check whether a user role is permitted to perform a named action.
 * Returns true if permitted, false if denied (deny-by-default for unknown actions).
 *
 * @param {string} action  - The action name
 * @param {object} user    - { userId, role, ... }
 * @returns {boolean}
 */
function checkActionPermission(action, user) {
  if (!user || !action) return false;
  const allowed = ACTION_PERMISSIONS[action];
  if (!allowed) return false; // deny-by-default for unknown actions
  // Role matching is case-sensitive — roles must be stored lowercase in the JWT.
  const role = user.role || '';
  return allowed.has(role);
}

/**
 * Express middleware factory for action-level permission gating (WO-007).
 * On denial, returns 403 FORBIDDEN_ACTION.
 */
function checkActionPermission_mw(action, resourceType) {
  return (req, res, next) => {
    if (!req.user) return next();
    if (checkActionPermission(action, req.user)) return next();
    logger.warn('Action denied', { action, userId: req.user.userId, role: req.user.role });
    return res.status(403).json({
      status: 'error',
      error: {
        code: 'FORBIDDEN_ACTION',
        action,
        resourceType: resourceType || null,
        message: `Role '${req.user.role}' is not permitted to perform action '${action}'`,
      },
    });
  };
}

// ── WO-014: MFA assurance middleware ──────────────────────────────────────────

// Routes matching these patterns require MFA-verified tokens for admin users.
const MFA_SENSITIVE_PATTERNS = [
  /^\/api\/v1\/users/,
  /^\/api\/v1\/system\//,
  /^\/api\/v1\/auth\/sso\//,
];

/**
 * Middleware that requires MFA assurance for admin users on sensitive routes.
 * Non-admin users pass through without MFA assurance requirement.
 *
 * Tokens issued after successful MFA challenge carry { mfaVerified: true }.
 * Tokens issued without MFA challenge (or pre-WO-014 tokens) lack this claim.
 */
function requireMfaAssurance(req, res, next) {
  if (!req.user) return next();
  const role = (req.user.role || '').toLowerCase();

  // Only enforce MFA assurance for admin users
  if (role !== 'admin') return next();

  // Check whether the current route is MFA-sensitive
  const isSensitive = MFA_SENSITIVE_PATTERNS.some((pattern) => pattern.test(req.path));
  if (!isSensitive) return next();

  // Check for MFA assurance claim in the decoded token
  // The token payload is attached by the authenticate middleware via verifyAccessToken
  const token = (req.headers.authorization || '').slice(7);
  if (!token) return next();

  let payload;
  try {
    payload = require('../services/jwt.service').verifyAccessToken(token);
  } catch (_) {
    return next(); // authenticate middleware will already have rejected this
  }

  if (!payload.mfaVerified) {
    logger.warn('Admin route access denied: MFA assurance required', {
      userId: req.user.userId,
      path: req.path,
    });
    return res.status(403).json({
      status: 'error',
      error: {
        code: 'MFA_REQUIRED',
        message: 'This resource requires MFA verification. Please complete the MFA challenge.',
      },
    });
  }

  next();
}

module.exports = {
  authenticate,
  requireRole,
  requireMfaAssurance,
  checkActionPermission,
  checkActionPermission_mw,
  ACTION_PERMISSIONS,
};

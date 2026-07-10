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

module.exports = { authenticate, requireRole };

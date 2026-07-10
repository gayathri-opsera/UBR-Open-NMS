'use strict';

/**
 * Route-permission map.
 * Key: path prefix (or exact match)
 * Value: minimum role required. Roles are hierarchical: admin > operator > user
 */
const ROLE_HIERARCHY = { admin: 3, operator: 2, user: 1 };

/**
 * Per-route minimum role requirements.
 * Entries are checked in order; first match wins.
 */
const ROUTE_PERMISSIONS = [
  { pattern: /^\/api\/v1\/users/,             minRole: 'admin' },
  { pattern: /^\/api\/v1\/system\//,          minRole: 'admin' },
  { pattern: /^\/api\/v1\/audit/,             minRole: 'admin' },
  { pattern: /^\/api\/v1\/config.*\/(create|update|delete|push)/, minRole: 'operator' },
  { pattern: /^\/api\/v1\/alarms.*\/acknowledge/, minRole: 'operator' },
  { pattern: /^\/api\/v1\//,                  minRole: 'user' },
];

/**
 * RBAC enforcement middleware.
 * Requires authenticate() to run first (req.user must be set).
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
        return res.status(403).json({
          code: 'FORBIDDEN',
          message: `Role '${req.user.role}' is not authorized for this endpoint (requires '${entry.minRole}')`,
        });
      }
      break;
    }
  }
  next();
}

module.exports = { requireRole, ROUTE_PERMISSIONS, ROLE_HIERARCHY };

'use strict';

const passwordPolicyService = require('../services/password_policy.service');
const logger = require('../utils/logger');

/**
 * Middleware that enforces local password renewal policy (WO-019).
 *
 * When a valid JWT is present and the user's password has expired (or an admin
 * has forced a reset), this middleware rejects all requests except to the
 * password-renewal endpoint with HTTP 403 PASSWORD_RENEWAL_REQUIRED.
 *
 * SSO/LDAP-only users are not affected.
 *
 * Intended to be mounted after the JWT-verification middleware so that
 * `req.user` is already populated.
 */
async function enforcePasswordPolicy(req, res, next) {
  // Only applies to authenticated requests
  if (!req.user || !req.user.sub) {
    return next();
  }

  // Allow the renewal endpoint itself through — otherwise users cannot renew
  if (req.path === '/api/v1/auth/password/renew') {
    return next();
  }

  try {
    const result = await passwordPolicyService.checkPasswordPolicy(req.user.sub);

    if (result.status === 'expired') {
      logger.warn('Request blocked: password expired', {
        userId: req.user.sub,
        reason: result.reason,
      });
      return res.status(403).json({
        error: {
          code: 'PASSWORD_RENEWAL_REQUIRED',
          message: 'Your password has expired. Please renew it before continuing.',
          reason: result.reason || 'PASSWORD_EXPIRED',
          renewalEndpoint: 'POST /api/v1/auth/password/renew',
        },
      });
    }

    // Attach policy metadata to the request for downstream use (e.g. response enrichment)
    if (result.status === 'warning') {
      req.passwordPolicyWarning = {
        expiresAt: result.expiresAt,
        daysRemaining: result.daysRemaining,
      };
    }

    return next();
  } catch (err) {
    // Policy check failure must not block the request unless it is a hard policy block
    if (err.code === 'USER_NOT_FOUND') {
      return next();
    }
    logger.error('Password policy check failed', { userId: req.user?.sub, error: err.message });
    return next();
  }
}

module.exports = enforcePasswordPolicy;

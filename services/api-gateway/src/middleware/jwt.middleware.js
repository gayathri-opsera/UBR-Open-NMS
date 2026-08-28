'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Routes that bypass JWT validation.
 */
const PUBLIC_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/mfa/challenge', // MFA OTP submit — authenticated via mfaToken, not Bearer
  '/api/v1/notifications/stream',
  '/healthz',
  '/readyz',
]);

/**
 * Verifies the Bearer token, attaches decoded payload to req.user.
 * Returns 401 for missing/invalid/expired tokens.
 */
function authenticate(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'MISSING_TOKEN', message: 'Authorization header required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.publicKey, {
      algorithms: [config.jwt.algorithm],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      logger.warn({ msg: 'Expired JWT', path: req.path });
      return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Access token has expired' });
    }
    logger.warn({ msg: 'Invalid JWT', err: err.message, path: req.path });
    return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Access token is invalid' });
  }
}

module.exports = { authenticate, PUBLIC_PATHS };

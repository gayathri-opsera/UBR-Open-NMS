'use strict';

const express = require('express');
const passwordPolicyService = require('../services/password_policy.service');
const jwtService = require('../services/jwt.service');
const sessionService = require('../services/session.service');
const logger = require('../utils/logger');
const config = require('../config');

const router = express.Router();

/**
 * POST /api/v1/auth/password/renew
 *
 * Forced password renewal endpoint for local users (WO-019).
 *
 * Request body:
 *   { currentPassword?: string, newPassword: string }
 *
 * Headers:
 *   Authorization: Bearer <access-token-or-mfa-token>
 *
 * Response 200:
 *   { accessToken, refreshToken, expiresIn, role, userId }
 *
 * Response 400: weak or reused password
 * Response 401: current password incorrect
 * Response 403: externally managed account
 * Response 404: user not found
 */
router.post('/renew', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authorization token required.' } });
  }

  // Verify the access token to extract the user ID
  let payload;
  try {
    payload = jwtService.verifyAccessToken(token);
  } catch {
    // Also accept an MFA challenge token so users can renew during the challenge step
    payload = jwtService.verifyMfaChallengeToken(token);
    if (!payload) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired.' } });
    }
  }

  const userId = payload.sub;
  const { currentPassword, newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'newPassword is required.' } });
  }

  try {
    await passwordPolicyService.renewPassword(userId, newPassword, currentPassword);

    // Invalidate existing sessions after renewal so pre-renewal refresh tokens cannot be used
    // (best-effort — session destruction failure must not block the 200 response)
    try {
      const refreshToken = req.body.refreshToken;
      if (refreshToken) {
        await sessionService.destroySession(refreshToken);
      }
    } catch (sessionErr) {
      logger.warn('Could not destroy old session after password renewal', { userId, error: sessionErr.message });
    }

    // Issue fresh tokens for the renewed session
    const role = payload.role || 'user';
    const accessToken = jwtService.generateAccessToken(userId, role);
    const newRefreshToken = jwtService.generateRefreshToken();
    await sessionService.createSession(userId, role, newRefreshToken, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    logger.info('Password renewed — new session issued', logger.maskPii({ userId, ip: req.ip }));

    return res.status(200).json({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: config.jwt.accessTokenTtlSeconds,
      role,
      userId,
    });
  } catch (err) {
    const statusMap = {
      USER_NOT_FOUND: 404,
      POLICY_EXEMPT_USER: 403,
      INVALID_CURRENT_PASSWORD: 401,
      NO_LOCAL_PASSWORD: 400,
      PASSWORD_COMPLEXITY_VIOLATION: 400,
      PASSWORD_REUSE: 400,
    };
    const status = statusMap[err.code] || 500;
    logger.warn('Password renewal failed', { userId, code: err.code });
    return res.status(status).json({ error: { code: err.code || 'RENEWAL_FAILED', message: err.message } });
  }
});

module.exports = router;

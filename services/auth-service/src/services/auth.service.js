'use strict';

const ldapService = require('./ldap.service');
const jwtService = require('./jwt.service');
const sessionService = require('./session.service');
const { User, validatePasswordComplexity } = require('../models/user.model');
const config = require('../config');
const logger = require('../utils/logger');

// Lazy-required to avoid circular dep at module load time
const getMfaService = () => require('./mfa.service');

/**
 * Attempt authentication. LDAP-first, MongoDB-fallback when circuit is open.
 * Returns { accessToken, refreshToken, expiresIn, role } on success.
 * Throws descriptive errors for all failure paths.
 */
async function login(username, password, ip, userAgent) {
  // Check lockout first.
  const failState = await sessionService.getFailedAttempts(username);
  if (failState >= config.password.maxFailedAttempts) {
    const err = new Error('Account temporarily locked due to too many failed attempts.');
    err.code = 'ACCOUNT_LOCKED';
    err.status = 403;
    throw err;
  }

  let role;
  let userId;
  let ldapSuccess = false;

  try {
    // Attempt LDAP authentication.
    const ldapEntry = await ldapService.authenticate(username, password);
    ldapSuccess = true;

    // Upsert user in local MongoDB (shadow record for role lookups).
    let user = await User.findOne({ username });
    if (!user) {
      user = new User({
        username,
        email: ldapEntry.mail || `${username}@nms.local`,
        role: 'user',
        isLdapUser: true,
      });
      await user.save();
    }

    role = user.role;
    userId = user._id.toString();
  } catch (ldapErr) {
    // LDAP unavailable (circuit open) OR connection failure — try local MongoDB fallback.
    if (ldapService.isOpen() || ldapErr.name === 'OpenCircuitError' ||
        ldapErr.code === 'ECONNREFUSED' || ldapErr.code === 'ENOTFOUND' ||
        ldapErr.code === 'ECONNRESET' || ldapErr.code === 'ETIMEDOUT' ||
        ldapErr.message?.includes('connect') || ldapErr.message?.includes('bind failed')) {
      logger.warn('LDAP unavailable — using local fallback', { username, reason: ldapErr.message });
      const user = await User.findOne({ username, isActive: true });

      if (!user || !user.passwordHash) {
        await _recordFailure(username, ip, userAgent, 'USER_NOT_FOUND_FALLBACK');
        _throwInvalidCredentials();
      }

      if (user.isLockedOut()) {
        const err = new Error('Account temporarily locked.');
        err.code = 'ACCOUNT_LOCKED';
        err.status = 403;
        throw err;
      }

      const match = await user.verifyPassword(password);
      if (!match) {
        await _recordFailure(username, ip, userAgent, 'INVALID_PASSWORD_LOCAL');
        _throwInvalidCredentials();
      }

      role = user.role;
      userId = user._id.toString();
    } else if (ldapErr.code === 'INVALID_CREDENTIALS' || ldapErr.code === 'USER_NOT_FOUND') {
      await _recordFailure(username, ip, userAgent, ldapErr.code);
      _throwInvalidCredentials();
    } else {
      logger.error('Unexpected LDAP error', { error: ldapErr.message, username });
      await _recordFailure(username, ip, userAgent, 'LDAP_ERROR');
      _throwInvalidCredentials();
    }
  }

  // Clear any previous failure count on successful auth.
  await sessionService.clearFailedAttempts(username);

  // ── MFA gate ─────────────────────────────────────────────────────────────────
  // Fetch fresh user record to check mfaEnabled (not fetched above for LDAP path).
  const userRecord = await User.findById(userId).select('mfaEnabled username');
  if (userRecord && userRecord.mfaEnabled) {
    // Password is correct but MFA is required — issue a short-lived challenge token
    // instead of the real access token.
    const mfaToken = jwtService.generateMfaChallengeToken(userId, username, role);
    logger.info('MFA challenge issued', logger.maskPii({ username, ip }));
    return {
      mfaRequired: true,
      mfaToken,
      mfaTokenExpiresIn: 300, // 5 minutes
    };
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const accessToken = jwtService.generateAccessToken(userId, role);
  const refreshToken = jwtService.generateRefreshToken();

  await sessionService.createSession(userId, role, refreshToken, { ip, userAgent });

  // Update last login.
  await User.findByIdAndUpdate(userId, { lastLogin: new Date() });

  logger.info('Login successful', logger.maskPii({ username, ip, role }));

  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTokenTtlSeconds,
    role,
    userId,
  };
}

/**
 * Issue new access token + rotated refresh token.
 */
async function refresh(oldRefreshToken) {
  const newRefreshToken = jwtService.generateRefreshToken();
  const session = await sessionService.validateAndRotateRefreshToken(oldRefreshToken, newRefreshToken);

  if (!session) {
    const err = new Error('Invalid or expired refresh token.');
    err.code = 'INVALID_REFRESH_TOKEN';
    err.status = 401;
    throw err;
  }

  const accessToken = jwtService.generateAccessToken(session.userId, session.role);
  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: config.jwt.accessTokenTtlSeconds,
    role: session.role,
  };
}

/**
 * Invalidate the refresh token / session on logout.
 */
async function logout(refreshToken, userId, username) {
  await sessionService.destroySession(refreshToken);
  logger.info('Logout', { userId, username });
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _recordFailure(username, ip, userAgent, reason) {
  const result = await sessionService.recordFailedAttempt(username);
  logger.warn('Login failed', logger.maskPii({ username, ip, userAgent, reason, attempts: result.attempts }));

  if (result.locked) {
    // Trigger CRITICAL self-health alarm when threshold is hit (NMS-AM spec).
    logger.error('CRITICAL: Too many failed login attempts — self-health alarm', {
      username,
      ip: ip ? ip.split('.').slice(0, 2).join('.') + '.*.*' : 'unknown',
      attempts: result.attempts,
    });
  }
}

function _throwInvalidCredentials() {
  const err = new Error('Invalid username or password.');
  err.code = 'INVALID_CREDENTIALS';
  err.status = 401;
  throw err;
}

module.exports = { login, refresh, logout };

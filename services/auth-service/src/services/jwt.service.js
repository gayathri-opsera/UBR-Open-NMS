'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

const MFA_CHALLENGE_SECRET = process.env.MFA_CHALLENGE_SECRET || 'mfa-challenge-dev-secret-change-in-prod';
const MFA_CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * Generate an RS256-signed JWT access token.
 * Claims: sub, role, jti, iat, exp, iss, aud.
 */
function generateAccessToken(userId, role) {
  if (!config.jwt.privateKey) {
    throw new Error('JWT_PRIVATE_KEY not configured');
  }
  return jwt.sign(
    { sub: userId, role, jti: uuidv4() },
    config.jwt.privateKey,
    {
      algorithm: config.jwt.algorithm,
      expiresIn: config.jwt.accessTokenTtl,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }
  );
}

/**
 * Verify and decode a JWT access token using the RS256 public key.
 * Throws on invalid/expired token.
 */
function verifyAccessToken(token) {
  if (!config.jwt.publicKey) {
    throw new Error('JWT_PUBLIC_KEY not configured');
  }
  return jwt.verify(token, config.jwt.publicKey, {
    algorithms: [config.jwt.algorithm],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

/**
 * Generate a cryptographically random opaque refresh token.
 */
function generateRefreshToken() {
  return uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
}

/**
 * Generate a short-lived (5 min) MFA challenge token.
 * This is returned INSTEAD of an access token when MFA is required.
 * It is signed with a symmetric secret (not RS256) to keep it lightweight.
 * Claims: sub (userId), username, role, mfa:true, jti.
 */
function generateMfaChallengeToken(userId, username, role) {
  return jwt.sign(
    { sub: userId, username, role, mfa: true, jti: uuidv4() },
    MFA_CHALLENGE_SECRET,
    { expiresIn: MFA_CHALLENGE_TTL_SECONDS, issuer: 'ubr-nms-mfa' }
  );
}

/**
 * Verify and decode an MFA challenge token.
 * Returns the payload on success, null on failure.
 */
function verifyMfaChallengeToken(token) {
  try {
    const payload = jwt.verify(token, MFA_CHALLENGE_SECRET, { issuer: 'ubr-nms-mfa' });
    if (!payload.mfa) return null; // must have the mfa flag
    return payload;
  } catch (err) {
    logger.warn('MFA challenge token verification failed', { reason: err.message });
    return null;
  }
}

module.exports = {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  generateMfaChallengeToken,
  verifyMfaChallengeToken,
};

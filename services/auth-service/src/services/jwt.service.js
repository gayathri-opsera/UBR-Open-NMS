'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

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

module.exports = { generateAccessToken, verifyAccessToken, generateRefreshToken };

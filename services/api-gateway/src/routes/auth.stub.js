'use strict';
/**
 * auth.stub.js — Local Dev Auth Stub
 * ===================================
 * Handles POST /api/v1/auth/login when the real auth-service is unavailable.
 * Reads users from MongoDB (same collection seeded by scripts/seed.js), verifies
 * bcrypt password, and issues RS256 JWTs signed with the dev private key.
 *
 * SECURITY: This stub is for local development only. It is ONLY mounted when
 * AUTH_SERVICE_URL is unreachable (circuit-breaker timeout). In production the
 * real auth-service handles all authentication.
 *
 * Never commit real credentials — passwords come from the seeded DB only.
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');
const logger   = require('../utils/logger');
const config   = require('../config');

const router = express.Router();

// ── Load signing key ──────────────────────────────────────────────────────────
// Use the same dev private key as the real auth-service (mounted via docker volume).
// Falls back to JWT_PRIVATE_KEY env var (base64-encoded).
function loadPrivateKey() {
  // 1. Env var (base64)
  if (process.env.JWT_PRIVATE_KEY) {
    return Buffer.from(process.env.JWT_PRIVATE_KEY, 'base64').toString('utf8');
  }
  // 2. Well-known dev path (docker-compose volume mount)
  const devPaths = [
    '/run/secrets/jwt_private_key',
    '/app/dev/jwt_private.pem',
    path.join(__dirname, '../../../../dev/jwt_private.pem'),
  ];
  for (const p of devPaths) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) { /* skip */ }
  }
  return null;
}

const PRIVATE_KEY = loadPrivateKey();

// ── Role normalisation ────────────────────────────────────────────────────────
// Seed uses 'user' for viewer-level accounts; gateway RBAC expects 'viewer'.
const ROLE_ALIAS = {
  user:       'viewer',
  super_admin: 'admin',
  system_admin: 'admin',
};
function normalizeRole(r) {
  return ROLE_ALIAS[String(r).toLowerCase()] || String(r).toLowerCase();
}

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ code: 'MISSING_CREDENTIALS', message: 'username and password are required' });
  }

  if (!PRIVATE_KEY) {
    logger.error({ msg: '[auth-stub] No private key available — cannot issue tokens' });
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'auth is currently unavailable (no signing key)' });
  }

  // Auto-connect mongoose if not yet connected (happens when auth is hit before any other stub).
  if (mongoose.connection.readyState === 0) {
    const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || 'mongodb://mongo:27017/ubrnms';
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
      logger.info({ msg: '[auth-stub] Mongoose connected on demand', uri: mongoUri.replace(/:\/\/.*@/, '://***@') });
    } catch (connErr) {
      logger.error({ msg: '[auth-stub] Mongoose connect failed', err: connErr.message });
      return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'auth is currently unavailable (db not connected)' });
    }
  }

  const db = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
  if (!db) {
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'auth is currently unavailable (db not connected)' });
  }

  try {
    const user = await db.collection('users').findOne({ username: username.trim() });

    if (!user) {
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' });
    }

    if (!user.isActive) {
      return res.status(403).json({ code: 'ACCOUNT_DISABLED', message: 'This account has been disabled' });
    }

    // Check lockout
    if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
      const until = new Date(user.lockoutUntil).toISOString();
      return res.status(403).json({ code: 'ACCOUNT_LOCKED', message: `Account locked until ${until}` });
    }

    // Verify password
    const match = await bcrypt.compare(password, user.passwordHash || '');
    if (!match) {
      // Increment failed attempts
      await db.collection('users').updateOne(
        { _id: user._id },
        { $inc: { failedAttempts: 1 }, $set: { updatedAt: new Date() } },
      );
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' });
    }

    // Reset failed attempts on success
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { failedAttempts: 0, lastLogin: new Date(), updatedAt: new Date() } },
    );

    const role = normalizeRole(user.role || 'viewer');

    // Sign access token (short-lived)
    const accessToken = jwt.sign(
      {
        sub:      String(user._id),
        userId:   String(user._id),
        username: user.username,
        email:    user.email || '',
        role,
        iss:      config.jwt.issuer   || 'ubr-nms',
        aud:      config.jwt.audience || 'ubr-nms-api',
      },
      PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '8h' },
    );

    // Sign refresh token (longer-lived, minimal payload)
    const refreshToken = jwt.sign(
      { sub: String(user._id), type: 'refresh', iss: config.jwt.issuer || 'ubr-nms' },
      PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '7d' },
    );

    logger.info({ msg: '[auth-stub] login successful', username: user.username, role });

    // Wrap in the standard gateway envelope { status, data } that auth.api.ts expects
    return res.json({
      status: 'ok',
      data: {
        accessToken,
        refreshToken,
        expiresIn:  28800, // 8h in seconds
        tokenType:  'Bearer',
        role,
        userId:     String(user._id),
        username:   user.username,
        email:      user.email || '',
      },
    });
  } catch (err) {
    logger.error({ msg: '[auth-stub] login error', err: err.message });
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Login failed — internal error' });
  }
});

// ── POST /api/v1/auth/refresh ─────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ code: 'MISSING_TOKEN', message: 'refreshToken is required' });
  }
  if (!PRIVATE_KEY) {
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'auth is currently unavailable' });
  }
  try {
    const payload = jwt.verify(refreshToken, PRIVATE_KEY.replace('PRIVATE', 'PUBLIC'), {
      algorithms: ['RS256'],
    });
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');
    // Re-issue access token (simplified — re-uses same sub)
    const accessToken = jwt.sign(
      { sub: payload.sub, userId: payload.sub, iss: config.jwt.issuer || 'ubr-nms', aud: config.jwt.audience || 'ubr-nms-api' },
      PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '8h' },
    );
    return res.json({ accessToken, expiresIn: 28800, tokenType: 'Bearer' });
  } catch (err) {
    return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Refresh token is invalid or expired' });
  }
});

// ── GET /api/v1/auth/me ────────────────────────────────────────────────────────
// The frontend calls this after login to get the current user profile.
router.get('/me', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  const db = mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
  if (db) {
    try {
      const { ObjectId } = require('mongoose').Types;
      const userId = req.user.userId || req.user.sub;
      const user = await db.collection('users').findOne({ _id: new ObjectId(userId) }).catch(() => null)
        || await db.collection('users').findOne({ username: req.user.username }).catch(() => null);
      if (user) {
        return res.json({
          id:       String(user._id),
          username: user.username,
          email:    user.email || '',
          role:     normalizeRole(user.role),
        });
      }
    } catch (_) { /* fall through */ }
  }
  // Fallback: return JWT claims
  return res.json({
    id:       req.user.userId || req.user.sub,
    username: req.user.username,
    email:    req.user.email || '',
    role:     req.user.role,
  });
});

module.exports = router;

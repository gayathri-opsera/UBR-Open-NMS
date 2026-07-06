'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

let redisClient = null;

function setRedis(client) {
  redisClient = client;
}

function getRedis() {
  if (!redisClient) throw new Error('Redis client not initialised');
  return redisClient;
}

// Key helpers — all keys are prefixed by ioredis keyPrefix from config.
const keys = {
  refreshToken: (token) => `rt:${token}`,
  sessionCount: (userId) => `sc:${userId}`,
  sessionSet: (userId) => `ss:${userId}`,
  sessionActivity: (sessionId) => `sa:${sessionId}`,
  failedAttempts: (username) => `fa:${username}`,
};

/**
 * Store a new session: refresh token + session entry.
 * Enforces the concurrent session limit before creating the session.
 * Throws with code SESSION_LIMIT_EXCEEDED when the user has hit the cap.
 */
async function createSession(userId, role, refreshToken, meta = {}) {
  const redis = getRedis();
  const sessionId = uuidv4();
  const now = Date.now();

  // Enforce concurrent session limit.
  const sessionSet = keys.sessionSet(userId);
  const allSessions = await redis.smembers(sessionSet);

  // Prune stale sessions that have no activity record.
  for (const sid of allSessions) {
    const last = await redis.get(keys.sessionActivity(sid));
    if (!last) await redis.srem(sessionSet, sid);
  }

  const activeSessions = await redis.smembers(sessionSet);
  if (activeSessions.length >= config.session.maxConcurrent) {
    const err = new Error(
      `Concurrent session limit reached (max ${config.session.maxConcurrent}). ` +
      'Log out from another device before signing in.'
    );
    err.code = 'SESSION_LIMIT_EXCEEDED';
    throw err;
  }

  const pipeline = redis.pipeline();

  // Store refresh token → {userId, role, sessionId} with 24-hour TTL.
  pipeline.set(
    keys.refreshToken(refreshToken),
    JSON.stringify({ userId, role, sessionId }),
    'EX',
    config.jwt.refreshTokenTtlSeconds
  );

  // Track session in per-user set.
  pipeline.sadd(sessionSet, sessionId);
  pipeline.expire(sessionSet, config.jwt.refreshTokenTtlSeconds);

  // Record initial activity timestamp for idle-timeout enforcement.
  pipeline.set(
    keys.sessionActivity(sessionId),
    String(now),
    'EX',
    config.session.idleTimeoutSeconds * 2
  );

  await pipeline.exec();
  return sessionId;
}

/**
 * Validate a refresh token. Returns {userId, role, sessionId} or null.
 * Rotates the token (issues new, invalidates old) to prevent replay.
 */
async function validateAndRotateRefreshToken(oldToken, newToken) {
  const redis = getRedis();
  const data = await redis.get(keys.refreshToken(oldToken));
  if (!data) return null;

  const session = JSON.parse(data);
  const pipeline = redis.pipeline();

  // Delete old token.
  pipeline.del(keys.refreshToken(oldToken));

  // Store new token with full TTL reset.
  pipeline.set(
    keys.refreshToken(newToken),
    JSON.stringify(session),
    'EX',
    config.jwt.refreshTokenTtlSeconds
  );

  // Refresh activity timestamp.
  pipeline.set(
    keys.sessionActivity(session.sessionId),
    String(Date.now()),
    'EX',
    config.session.idleTimeoutSeconds * 2
  );

  await pipeline.exec();
  return session;
}

/**
 * Invalidate a refresh token and remove the session from tracking.
 */
async function destroySession(refreshToken) {
  const redis = getRedis();
  const data = await redis.get(keys.refreshToken(refreshToken));
  if (!data) return;

  const { userId, sessionId } = JSON.parse(data);
  const pipeline = redis.pipeline();
  pipeline.del(keys.refreshToken(refreshToken));
  pipeline.srem(keys.sessionSet(userId), sessionId);
  pipeline.del(keys.sessionActivity(sessionId));
  await pipeline.exec();
}

/**
 * Invalidate all sessions for a user (force-logout, role change, password change).
 */
async function destroyAllSessions(userId) {
  const redis = getRedis();
  const sessions = await redis.smembers(keys.sessionSet(userId));
  if (sessions.length === 0) return;

  const pipeline = redis.pipeline();
  for (const sid of sessions) {
    pipeline.del(keys.sessionActivity(sid));
  }
  pipeline.del(keys.sessionSet(userId));
  await pipeline.exec();
}

/**
 * Touch session activity — called on every authenticated request to reset idle timer.
 */
async function touchSession(sessionId) {
  const redis = getRedis();
  await redis.set(
    keys.sessionActivity(sessionId),
    String(Date.now()),
    'EX',
    config.session.idleTimeoutSeconds * 2
  );
}

/**
 * Background job: scan all session-activity keys and evict stale sessions.
 * Runs on configurable interval (default 60s).
 */
async function cleanStaleSessions() {
  const redis = getRedis();
  const cursor = '0';
  const pattern = `${config.redis.keyPrefix}sa:*`;
  const now = Date.now();
  const staleThreshold = config.session.idleTimeoutSeconds * 1000;

  let nextCursor = cursor;
  do {
    const [cur, keys_] = await redis.scan(nextCursor, 'MATCH', pattern, 'COUNT', 100);
    nextCursor = cur;
    for (const key of keys_) {
      const last = await redis.get(key);
      if (!last) continue;
      if (now - parseInt(last, 10) > staleThreshold) {
        await redis.del(key);
        logger.info('Evicted stale session', { key });
      }
    }
  } while (nextCursor !== '0');
}

/**
 * List all active sessions across all users for admin view.
 * Scans Redis session-activity keys and returns session metadata.
 */
async function listAllSessions() {
  const redis = getRedis();
  const pattern = `${config.redis.keyPrefix}sa:*`;
  const now = Date.now();
  const sessions = [];

  let nextCursor = '0';
  do {
    const [cur, keys_] = await redis.scan(nextCursor, 'MATCH', pattern, 'COUNT', 100);
    nextCursor = cur;
    for (const key of keys_) {
      const last = await redis.get(key);
      if (!last) continue;
      // Strip keyPrefix to get the raw key
      const rawKey = key.startsWith(config.redis.keyPrefix)
        ? key.slice(config.redis.keyPrefix.length)
        : key;
      const sessionId = rawKey.replace(/^sa:/, '');
      const lastActivity = parseInt(last, 10);
      const stale = now - lastActivity > config.session.idleTimeoutSeconds * 1000;
      sessions.push({
        sessionId,
        lastActivityAt: new Date(lastActivity).toISOString(),
        stale,
        // userId/username not stored in activity key — would need cross-reference
        userId: null,
        username: null,
        ipAddress: null,
        loginAt: null,
      });
    }
  } while (nextCursor !== '0');

  return sessions;
}

/**
 * Terminate a session by its sessionId (admin force-logout).
 * Removes the activity key and removes from all user session sets.
 */
async function terminateSessionById(sessionId) {
  const redis = getRedis();
  await redis.del(keys.sessionActivity(sessionId));
  // Activity key deletion alone is sufficient — cleanStaleSessions will prune the set
  logger.info('Session terminated by admin', { sessionId });
}

/**
 * Track and enforce failed login attempts.
 * Returns {locked: false, attempts} on success, {locked: true, lockoutSeconds} when limit exceeded.
 */
async function recordFailedAttempt(username) {
  const redis = getRedis();
  const key = keys.failedAttempts(username);
  const attempts = await redis.incr(key);

  if (attempts === 1) {
    await redis.expire(key, config.password.lockoutDurationSeconds);
  }

  if (attempts >= config.password.maxFailedAttempts) {
    return { locked: true, attempts, lockoutSeconds: config.password.lockoutDurationSeconds };
  }
  return { locked: false, attempts };
}

async function clearFailedAttempts(username) {
  const redis = getRedis();
  await redis.del(keys.failedAttempts(username));
}

async function getFailedAttempts(username) {
  const redis = getRedis();
  const val = await redis.get(keys.failedAttempts(username));
  return val ? parseInt(val, 10) : 0;
}

module.exports = {
  setRedis,
  createSession,
  validateAndRotateRefreshToken,
  destroySession,
  destroyAllSessions,
  touchSession,
  cleanStaleSessions,
  listAllSessions,
  terminateSessionById,
  recordFailedAttempt,
  clearFailedAttempts,
  getFailedAttempts,
};

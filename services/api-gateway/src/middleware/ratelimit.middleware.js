'use strict';

const config = require('../config');
const logger = require('../utils/logger');

/**
 * Redis sliding-window rate limiter (per userId from JWT).
 * Falls through without error if Redis is unavailable (fail-open per design).
 */
function rateLimiter(redisClient) {
  return async function rateLimit(req, res, next) {
    if (!req.user) return next();

    const userId = req.user.sub;
    const windowMs = config.rateLimit.defaultWindowMs;
    const maxRequests = config.rateLimit.defaultMax;
    const now = Date.now();
    const windowStart = now - windowMs;
    const key = `ratelimit:${userId}`;

    try {
      const multi = redisClient.multi();
      multi.zremrangebyscore(key, 0, windowStart);
      multi.zadd(key, now, `${now}-${Math.random()}`);
      multi.zcard(key);
      multi.pexpire(key, windowMs);
      const results = await multi.exec();
      const count = results[2];

      res.set('X-RateLimit-Limit', maxRequests);
      res.set('X-RateLimit-Remaining', Math.max(0, maxRequests - count));

      if (count > maxRequests) {
        logger.warn({ msg: 'Rate limit exceeded', userId, count });
        return res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' });
      }
      next();
    } catch (err) {
      // Fail-closed: deny the request when Redis is unavailable to prevent resource exhaustion.
      // A short 503 is preferred over 429 to signal temporary infra unavailability rather than
      // the client exceeding their quota.
      logger.error({ msg: 'Rate limiter Redis error — failing closed', err: err.message });
      return res.status(503).json({
        code: 'RATE_LIMITER_UNAVAILABLE',
        message: 'Service temporarily unavailable — please retry shortly',
      });
    }
  };
}

module.exports = { rateLimiter };

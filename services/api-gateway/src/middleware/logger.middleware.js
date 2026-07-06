'use strict';

const logger = require('../utils/logger');

/**
 * Structured request/response logger.
 * Logs: method, path, status, duration_ms, userId, correlationId.
 * Request bodies are intentionally NOT logged (privacy/security).
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      type: 'access',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      userId: req.user ? req.user.sub : 'anonymous',
      correlationId: req.correlationId || 'none',
      userAgent: req.headers['user-agent'],
    });
  });
  next();
}

module.exports = { requestLogger };

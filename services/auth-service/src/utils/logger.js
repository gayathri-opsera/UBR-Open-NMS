'use strict';

const winston = require('winston');
const config = require('../config');

const { combine, timestamp, json, errors, colorize, simple } = winston.format;

const logger = winston.createLogger({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  format: combine(
    errors({ stack: true }),
    timestamp(),
    json()
  ),
  defaultMeta: { service: 'auth-service' },
  transports: [
    new winston.transports.Console({
      format: config.nodeEnv === 'production'
        ? combine(timestamp(), json())
        : combine(colorize(), simple()),
    }),
  ],
});

/**
 * Mask PII fields before logging — strips passwords, tokens, full IPs (CPNI protection).
 */
logger.maskPii = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const masked = { ...obj };
  const sensitiveKeys = ['password', 'token', 'refreshToken', 'accessToken', 'bindPassword'];
  for (const key of sensitiveKeys) {
    if (masked[key]) masked[key] = '[REDACTED]';
  }
  if (masked.ip && typeof masked.ip === 'string') {
    const parts = masked.ip.split('.');
    if (parts.length === 4) masked.ip = `${parts[0]}.${parts[1]}.*.*`;
  }
  return masked;
};

module.exports = logger;

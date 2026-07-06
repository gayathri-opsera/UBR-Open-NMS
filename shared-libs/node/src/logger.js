'use strict';

/**
 * Structured JSON logger with correlation ID support.
 * Wraps Winston with automatic correlationId from AsyncLocalStorage context.
 */

const { AsyncLocalStorage } = require('async_hooks');
const winston = require('winston');

const asyncLocalStorage = new AsyncLocalStorage();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

function enrichWithContext(meta) {
  const store = asyncLocalStorage.getStore();
  if (store && store.correlationId) {
    return { correlationId: store.correlationId, ...meta };
  }
  return meta;
}

const log = {
  info:  (msg, meta = {}) => logger.info(msg, enrichWithContext(meta)),
  warn:  (msg, meta = {}) => logger.warn(msg, enrichWithContext(meta)),
  error: (msg, meta = {}) => logger.error(msg, enrichWithContext(meta)),
  debug: (msg, meta = {}) => logger.debug(msg, enrichWithContext(meta)),
  /** Run a function within a correlation-ID context. */
  withCorrelationId: (correlationId, fn) => asyncLocalStorage.run({ correlationId }, fn),
};

module.exports = { log, logger };

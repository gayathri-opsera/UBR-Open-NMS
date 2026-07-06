'use strict';

/**
 * Circuit breaker wrapper using opossum.
 * Returns a function that wraps an async operation with circuit breaker semantics.
 */

const CircuitBreaker = require('opossum');

const DEFAULT_OPTIONS = {
  timeout: parseInt(process.env.CB_TIMEOUT_MS || '5000', 10),
  errorThresholdPercentage: parseInt(process.env.CB_ERROR_PCT || '50', 10),
  resetTimeout: parseInt(process.env.CB_RESET_MS || '30000', 10),
};

/**
 * Creates a circuit breaker for an async function.
 * @param {Function} fn - The async function to protect
 * @param {string} name - Circuit breaker name for logging
 * @param {object} [options] - opossum options override
 */
function createCircuitBreaker(fn, name, options = {}) {
  const breaker = new CircuitBreaker(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  breaker.on('open', () => process.stdout.write(JSON.stringify({ level: 'warn', msg: 'Circuit OPEN', name }) + '\n'));
  breaker.on('halfOpen', () => process.stdout.write(JSON.stringify({ level: 'info', msg: 'Circuit HALF-OPEN', name }) + '\n'));
  breaker.on('close', () => process.stdout.write(JSON.stringify({ level: 'info', msg: 'Circuit CLOSED', name }) + '\n'));

  return breaker;
}

module.exports = { createCircuitBreaker };

'use strict';

/**
 * Retry utility with configurable exponential backoff.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3] - Maximum attempts
 * @param {number} [opts.baseDelayMs=100] - Initial delay in ms
 * @param {number} [opts.maxDelayMs=5000] - Maximum delay cap in ms
 * @param {Function} [opts.shouldRetry] - Optional: returns false to stop retrying
 */
async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs || DEFAULT_MAX_DELAY_MS;
  const shouldRetry = opts.shouldRetry || (() => true);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };

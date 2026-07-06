'use strict';

/**
 * Express health check middleware factory.
 * Mounts /healthz (liveness) and /readyz (readiness) on an Express app.
 */

/**
 * Adds /healthz and /readyz routes to an Express app.
 * @param {object} app - Express app instance
 * @param {Function} [readinessCheck] - Optional async fn returning {ready, reason}
 */
function mountHealthChecks(app, readinessCheck) {
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  app.get('/readyz', async (_req, res) => {
    if (!readinessCheck) return res.json({ status: 'ready' });
    try {
      const result = await readinessCheck();
      if (result && result.ready === false) {
        return res.status(503).json({ status: 'not_ready', reason: result.reason });
      }
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', reason: err.message });
    }
  });
}

module.exports = { mountHealthChecks };

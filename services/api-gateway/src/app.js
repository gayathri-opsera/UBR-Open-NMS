'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const { authenticate } = require('./middleware/jwt.middleware');
const { requireRole } = require('./middleware/rbac.middleware');
const { rateLimiter } = require('./middleware/ratelimit.middleware');
const { correlationId } = require('./middleware/correlation.middleware');
const { requestLogger } = require('./middleware/logger.middleware');
const { buildProxyRoutes } = require('./proxy/proxy');

function createApp(redisClient) {
  const app = express();

  app.use(helmet());
  app.use(cors(config.cors));
  app.use(correlationId);
  app.use(requestLogger);
  app.use(authenticate);
  app.use(requireRole);
  if (redisClient) {
    app.use(rateLimiter(redisClient));
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

  const proxyRoutes = buildProxyRoutes(config);
  for (const [prefix, handler] of Object.entries(proxyRoutes)) {
    app.use(prefix, handler);
  }

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' }));

  app.use((err, req, res, _next) => {
    logger.error({ msg: 'Unhandled gateway error', err: err.message, path: req.path });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal gateway error' });
  });

  return app;
}

module.exports = { createApp };

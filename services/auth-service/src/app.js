'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./utils/logger');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/users.routes');

// Prometheus metrics
let metricsMiddleware, metricsEndpoint;
try {
  const nmsMetrics = require('@ubrnms/metrics');
  metricsMiddleware = nmsMetrics.metricsMiddleware;
  metricsEndpoint = nmsMetrics.metricsEndpoint;
} catch (_) {
  // Metrics library not yet installed — no-op middleware
  metricsMiddleware = (_req, _res, next) => next();
  metricsEndpoint = (_req, res) => res.status(503).send('metrics unavailable');
}

function createApp() {
  const app = express();

  // Security headers.
  app.use(helmet());

  // CORS for React SPA.
  app.use(cors({ origin: config.cors.origin, credentials: config.cors.credentials }));

  // Prometheus metrics middleware (before routes)
  app.use(metricsMiddleware);

  // Body parsing.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Trust proxy for correct IP extraction behind NGINX/HAProxy.
  app.set('trust proxy', 1);

  // Rate limiting on auth endpoints (anti-brute-force at service level).
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: 'error',
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
    },
  });
  app.use('/api/v1/auth/login', authLimiter);

  // Health probes.
  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/metrics', metricsEndpoint);

  // API routes.
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);

  // 404 handler.
  app.use((_req, res) => {
    res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  // Global error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  return app;
}

module.exports = { createApp };

'use strict';
const express = require('express');
const { register } = require('prom-client');
const config = require('./config');
const logger = require('./utils/logger');
const notificationsRouter = require('./routes/notifications.routes');

let metricsMiddleware;
try {
  metricsMiddleware = require('@ubrnms/metrics').metricsMiddleware;
} catch (_) {
  metricsMiddleware = (_req, _res, next) => next();
}

const app = express();
app.use(metricsMiddleware);
app.use(express.json());

// Correlation ID
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || require('uuid').v4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// Health
app.get('/healthz', (_, res) => res.json({ status: 'ok' }));
app.get('/readyz', (_, res) => res.json({ status: 'ok' }));
app.get('/metrics', async (_, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.use('/api/v1/notifications', notificationsRouter);

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { err: err.message, correlationId: req.correlationId });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;

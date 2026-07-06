const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const auditRoutes = require('./routes/audit.routes');

let metricsMiddleware, metricsEndpoint;
try {
  const nmsMetrics = require('@ubrnms/metrics');
  metricsMiddleware = nmsMetrics.metricsMiddleware;
  metricsEndpoint = nmsMetrics.metricsEndpoint;
} catch (_) {
  metricsMiddleware = (_req, _res, next) => next();
  metricsEndpoint = (_req, res) => res.status(503).send('metrics unavailable');
}

const app = express();

app.use(metricsMiddleware);
app.use(express.json());

// Correlation ID middleware
app.use((req, res, next) => {
  const { v4: uuidv4 } = require('uuid');
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
});

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      correlationId: req.correlationId,
    });
  });
  next();
});

// Liveness probe
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/metrics', metricsEndpoint);

// Readiness probe
app.get('/readyz', (req, res) => {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) {
    return res.json({ status: 'ready' });
  }
  res.status(503).json({ status: 'not_ready', reason: 'MongoDB not connected' });
});

app.use('/api/v1/audit', auditRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

module.exports = app;

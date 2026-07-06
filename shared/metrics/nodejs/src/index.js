/**
 * UBR NMS — shared Prometheus metrics for Node.js services.
 *
 * Provides standard HTTP, Kafka, and database metric helpers using prom-client.
 * Import this module in any Node.js microservice:
 *
 *   const { nmsMetrics, metricsMiddleware } = require('@ubrnms/metrics');
 *   app.use(metricsMiddleware);
 *   app.get('/metrics', nmsMetrics.metricsEndpoint);
 */

'use strict';

const client = require('prom-client');

// Default Prometheus registry
const register = client.register;
register.setDefaultLabels({ service: process.env.SERVICE_NAME || 'unknown' });

// ── Standard metrics ────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of in-flight HTTP requests',
  labelNames: ['service'],
});

// ── Kafka metrics ────────────────────────────────────────────────────────────

const kafkaMessagesConsumed = new client.Counter({
  name: 'kafka_messages_consumed_total',
  help: 'Total Kafka messages consumed',
  labelNames: ['topic'],
});

const kafkaConsumerLag = new client.Gauge({
  name: 'kafka_consumer_lag',
  help: 'Kafka consumer lag',
  labelNames: ['topic', 'partition'],
});

// ── Database metrics ─────────────────────────────────────────────────────────

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

const dbConnectionsActive = new client.Gauge({
  name: 'db_connections_active',
  help: 'Active database connections',
  labelNames: ['db'],
});

// ── Redis metrics ────────────────────────────────────────────────────────────

const redisCacheHits = new client.Counter({
  name: 'redis_cache_hits_total',
  help: 'Redis cache hits',
  labelNames: ['cache'],
});

const redisCacheMisses = new client.Counter({
  name: 'redis_cache_misses_total',
  help: 'Redis cache misses',
  labelNames: ['cache'],
});

const redisOpDuration = new client.Histogram({
  name: 'redis_operations_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
});

// ── Express middleware ───────────────────────────────────────────────────────

/**
 * Express middleware that records http_requests_total, http_request_duration_seconds,
 * and http_requests_in_flight for every HTTP request.
 */
function metricsMiddleware(req, res, next) {
  const serviceName = process.env.SERVICE_NAME || 'unknown';
  const start = Date.now();
  const path = req.route ? req.route.path : req.path;

  httpRequestsInFlight.inc({ service: serviceName });

  res.on('finish', () => {
    httpRequestsInFlight.dec({ service: serviceName });
    const duration = (Date.now() - start) / 1000;
    const labels = { method: req.method, path };
    httpRequestsTotal.inc({ ...labels, status: res.statusCode });
    httpRequestDuration.observe(labels, duration);
  });

  next();
}

// ── Metrics endpoint handler ─────────────────────────────────────────────────

async function metricsEndpoint(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

// ── Collect default Node.js metrics (GC, heap, event loop lag) ───────────────
client.collectDefaultMetrics({ register });

module.exports = {
  register,
  metricsMiddleware,
  metricsEndpoint,
  metrics: {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight,
    kafkaMessagesConsumed,
    kafkaConsumerLag,
    dbQueryDuration,
    dbConnectionsActive,
    redisCacheHits,
    redisCacheMisses,
    redisOpDuration,
  },
};

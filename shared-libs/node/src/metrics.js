'use strict';

/**
 * Prometheus metrics helper.
 * Provides a pre-configured prom-client registry with default process metrics
 * and a convenience method for creating service-scoped counters, histograms, and gauges.
 */

const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/**
 * Get or create a Counter.
 */
function counter(name, help, labelNames = []) {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing;
  return new client.Counter({ name, help, labelNames, registers: [registry] });
}

/**
 * Get or create a Histogram.
 */
function histogram(name, help, labelNames = [], buckets = client.linearBuckets(0, 0.5, 10)) {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing;
  return new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });
}

/**
 * Get or create a Gauge.
 */
function gauge(name, help, labelNames = []) {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing;
  return new client.Gauge({ name, help, labelNames, registers: [registry] });
}

/**
 * Express route handler for /metrics endpoint.
 */
async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

module.exports = { registry, counter, histogram, gauge, metricsHandler };

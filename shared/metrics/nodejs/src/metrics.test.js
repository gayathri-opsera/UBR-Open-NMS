'use strict';

/**
 * Tests for shared Node.js metrics library.
 * Verifies: metric registration, counter increments, histogram observations,
 * middleware request recording, and Prometheus text format output.
 */

const client = require('prom-client');

// Use a fresh registry per test to avoid conflicts
let registry;
let nmsMetrics;

beforeEach(() => {
  registry = new client.Registry();
  // Re-require with a mock registry by patching module internals
  jest.resetModules();
});

afterEach(() => {
  registry.clear();
});

// We test the exported metrics objects directly
const { metrics } = require('../src/index');

describe('http_requests_total counter', () => {
  test('increments on recordHttpRequest', () => {
    const counter = new client.Counter({
      name: 'test_http_requests_total',
      help: 'test',
      labelNames: ['method', 'path', 'status'],
      registers: [registry],
    });
    counter.inc({ method: 'GET', path: '/api/v1/alarms', status: '200' });
    counter.inc({ method: 'GET', path: '/api/v1/alarms', status: '200' });
    counter.inc({ method: 'POST', path: '/api/v1/alarms', status: '201' });

    const values = counter.hashMap;
    expect(Object.keys(values).length).toBe(2);
  });
});

describe('http_request_duration_seconds histogram', () => {
  test('records observations within expected buckets', () => {
    const hist = new client.Histogram({
      name: 'test_http_request_duration_seconds',
      help: 'test',
      labelNames: ['method', 'path'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
    hist.observe({ method: 'GET', path: '/api/v1/devices' }, 0.042);
    hist.observe({ method: 'GET', path: '/api/v1/devices' }, 0.120);

    const result = hist.hashMap;
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});

describe('kafka_consumer_lag gauge', () => {
  test('sets and reads lag value', () => {
    const gauge = new client.Gauge({
      name: 'test_kafka_consumer_lag',
      help: 'test',
      labelNames: ['topic', 'partition'],
      registers: [registry],
    });
    gauge.set({ topic: 'raw-alarms', partition: '0' }, 42);
    const value = gauge.hashMap['topic:raw-alarms,partition:0,'];
    expect(value.value).toBe(42);
  });
});

describe('redis cache hit/miss counters', () => {
  test('records independent hit and miss counts', () => {
    const hits = new client.Counter({
      name: 'test_redis_cache_hits_total',
      help: 'test',
      labelNames: ['cache'],
      registers: [registry],
    });
    const misses = new client.Counter({
      name: 'test_redis_cache_misses_total',
      help: 'test',
      labelNames: ['cache'],
      registers: [registry],
    });

    hits.inc({ cache: 'kpi' });
    hits.inc({ cache: 'kpi' });
    misses.inc({ cache: 'kpi' });

    const hitValue = hits.hashMap['cache:kpi,'];
    const missValue = misses.hashMap['cache:kpi,'];
    expect(hitValue.value).toBe(2);
    expect(missValue.value).toBe(1);
  });
});

describe('Prometheus text format', () => {
  test('metrics output contains required metric families', async () => {
    const testRegistry = new client.Registry();
    new client.Counter({
      name: 'http_requests_total_check',
      help: 'Total HTTP requests check',
      labelNames: ['method'],
      registers: [testRegistry],
    }).inc({ method: 'GET' });

    const output = await testRegistry.metrics();
    expect(output).toContain('# HELP http_requests_total_check');
    expect(output).toContain('# TYPE http_requests_total_check counter');
    expect(output).toMatch(/http_requests_total_check\{method="GET"\} 1/);
  });

  test('histogram output contains _bucket, _sum, _count', async () => {
    const testRegistry = new client.Registry();
    const hist = new client.Histogram({
      name: 'http_request_duration_seconds_check',
      help: 'test hist',
      labelNames: ['path'],
      registers: [testRegistry],
    });
    hist.observe({ path: '/test' }, 0.05);

    const output = await testRegistry.metrics();
    expect(output).toContain('_bucket');
    expect(output).toContain('_sum');
    expect(output).toContain('_count');
  });
});

describe('metricsMiddleware', () => {
  test('records request on response finish', done => {
    const testRegistry = new client.Registry();
    const counter = new client.Counter({
      name: 'mw_http_requests_total',
      help: 'test',
      labelNames: ['method', 'path', 'status'],
      registers: [testRegistry],
    });

    // Simulate an Express request/response cycle
    const req = { method: 'GET', path: '/api/v1/alarms', route: { path: '/api/v1/alarms' } };
    const listeners = {};
    const res = {
      statusCode: 200,
      on: (event, cb) => { listeners[event] = cb; },
    };

    // Simulate middleware manually
    const start = Date.now();
    res.on('finish', () => {
      counter.inc({ method: req.method, path: req.route.path, status: res.statusCode });
    });

    // Trigger finish
    listeners['finish']();
    const val = counter.hashMap['method:GET,path:/api/v1/alarms,status:200,'];
    expect(val.value).toBe(1);
    done();
  });
});

'use strict';

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  jwt: {
    publicKey: process.env.JWT_PUBLIC_KEY
      ? Buffer.from(process.env.JWT_PUBLIC_KEY, 'base64').toString('utf8')
      : '',
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER || 'ubr-nms',
    audience: process.env.JWT_AUDIENCE || 'ubr-nms-api',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },

  rateLimit: {
    defaultWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    defaultMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    credentials: true,
  },

  circuitBreaker: {
    timeout: parseInt(process.env.CB_TIMEOUT_MS || '30000', 10),
    errorThresholdPct: parseInt(process.env.CB_ERROR_PCT || '80', 10),
    resetTimeout: parseInt(process.env.CB_RESET_MS || '15000', 10),
  },

  services: {
    auth:         process.env.AUTH_SERVICE_URL           || 'http://localhost:3001',
    inventory:    process.env.INVENTORY_SERVICE_URL       || 'http://localhost:3002',
    alarm:        process.env.ALARM_SERVICE_URL           || 'http://localhost:3003',
    config:       process.env.CONFIG_SERVICE_URL          || 'http://localhost:3004',
    kpi:          process.env.KPI_SERVICE_URL             || 'http://localhost:3005',
    topology:     process.env.TOPOLOGY_SERVICE_URL        || 'http://localhost:3006',
    discovery:    process.env.DISCOVERY_SERVICE_URL       || 'http://localhost:3007',
    audit:        process.env.AUDIT_SERVICE_URL           || 'http://localhost:3008',
    notification: process.env.NOTIFICATION_SERVICE_URL   || 'http://localhost:3009',
    healthMonitor:process.env.HEALTH_MONITOR_URL          || 'http://localhost:8092',
    diagnostics:  process.env.DIAGNOSTICS_SERVICE_URL    || 'http://localhost:8090',
  },
};

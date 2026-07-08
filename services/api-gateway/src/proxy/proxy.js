'use strict';

const proxy = require('express-http-proxy');
const CircuitBreaker = require('opossum');
const logger = require('../utils/logger');

/**
 * Circuit breaker options for downstream service calls.
 */
function makeCBOptions(serviceName, config) {
  return {
    timeout: config.circuitBreaker.timeout,
    errorThresholdPercentage: config.circuitBreaker.errorThresholdPct,
    resetTimeout: config.circuitBreaker.resetTimeout,
    name: `proxy-${serviceName}`,
  };
}

/**
 * Creates an express-http-proxy handler wrapped in an opossum circuit breaker.
 * When the circuit is open, responds 503.
 */
function createServiceProxy(serviceUrl, serviceName, config) {
  const proxyHandler = proxy(serviceUrl, {
    proxyReqPathResolver: req => req.originalUrl,
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
      proxyReqOpts.headers['x-correlation-id'] = srcReq.correlationId || '';
      if (srcReq.user) {
        proxyReqOpts.headers['x-user-id'] = srcReq.user.sub || '';
        proxyReqOpts.headers['x-user-role'] = srcReq.user.role || '';
      }
      return proxyReqOpts;
    },
    userResDecorator: (proxyRes, proxyResData, userReq, userRes) => proxyResData,
  });

  const circuitHandler = (req, res, next) => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      // Resolve when response is fully sent (normal proxy success path).
      res.on('finish', () => settle(resolve, undefined));
      // Resolve/reject via next() for connection-level errors.
      proxyHandler(req, res, (err) => {
        if (err) settle(reject, err);
        else settle(resolve, undefined);
      });
    });
  };

  const breaker = new CircuitBreaker(circuitHandler, makeCBOptions(serviceName, config));

  breaker.on('open', () => logger.warn({ msg: 'Circuit OPEN', service: serviceName }));
  breaker.on('halfOpen', () => logger.info({ msg: 'Circuit HALF-OPEN', service: serviceName }));
  breaker.on('close', () => logger.info({ msg: 'Circuit CLOSED', service: serviceName }));

  return (req, res, next) => {
    breaker.fire(req, res, next).catch(() => {
      if (!res.headersSent) {
        res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: `${serviceName} is currently unavailable` });
      }
    });
  };
}

/**
 * Build route map: path prefix → circuit-broken proxy handler.
 */
function buildProxyRoutes(config) {
  return {
    '/api/v1/auth':         createServiceProxy(config.services.auth,          'auth',          config),
    '/api/v1/devices':      createServiceProxy(config.services.inventory,      'inventory',     config),
    '/api/v1/inventory':    createServiceProxy(config.services.inventory,      'inventory',     config),
    '/api/v1/alarms':       createServiceProxy(config.services.alarm,          'alarm',         config),
    '/api/v1/config':       createServiceProxy(config.services.config,         'config',        config),
    '/api/v1/kpi':          createServiceProxy(config.services.kpi,            'kpi',           config),
    '/api/v1/topology':     createServiceProxy(config.services.topology,       'topology',      config),
    '/api/v1/discovery':    createServiceProxy(config.services.discovery,      'discovery',     config),
    '/api/v1/audit':        createServiceProxy(config.services.audit,          'audit',         config),
    '/api/v1/notifications':createServiceProxy(config.services.notification,   'notification',  config),
    '/api/v1/users':        createServiceProxy(config.services.auth,           'auth',          config),
    '/api/v1/system':       createServiceProxy(config.services.healthMonitor,  'health-monitor',config),
    '/api/v1/diagnostics':  createServiceProxy(config.services.diagnostics,    'diagnostics',   config),
  };
}

/**
 * Creates a direct (no circuit breaker, no timeout) proxy for SSE/streaming endpoints.
 * The circuit breaker must never wrap SSE connections because they are long-lived and
 * the CB timeout would misclassify healthy streams as failures, opening the circuit.
 */
function createSseProxy(serviceUrl) {
  return proxy(serviceUrl, {
    proxyReqPathResolver: req => req.originalUrl,
    parseReqBody: false,
    limit: '1mb',
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
      // Signal to the upstream that we want SSE; disable proxy-level buffering
      proxyReqOpts.headers['x-correlation-id'] = srcReq.correlationId || '';
      if (srcReq.user) {
        proxyReqOpts.headers['x-user-id']   = srcReq.user.sub  || '';
        proxyReqOpts.headers['x-user-role'] = srcReq.user.role || '';
      }
      // Disable Node.js socket timeout for streaming connections
      if (srcReq.socket) srcReq.socket.setTimeout(0);
      return proxyReqOpts;
    },
    userResHeaderDecorator: (headers) => {
      // Preserve SSE headers set by the upstream
      headers['x-accel-buffering'] = 'no'; // Disable nginx buffering
      return headers;
    },
  });
}

module.exports = { buildProxyRoutes, createServiceProxy, createSseProxy };

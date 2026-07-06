'use strict';

const mongoose = require('mongoose');
const Redis = require('ioredis');
const config = require('./config');
const logger = require('./utils/logger');
const sessionService = require('./services/session.service');
const { createApp } = require('./app');

let server;
let cleanupInterval;

async function start() {
  // Connect to MongoDB.
  await mongoose.connect(config.mongo.uri, config.mongo.options);
  logger.info('MongoDB connected', { uri: config.mongo.uri.replace(/\/\/.*@/, '//***@') });

  // Connect to Redis.
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    tls: config.redis.tls,
    keyPrefix: config.redis.keyPrefix,
    lazyConnect: true,
    enableReadyCheck: true,
  });
  await redis.connect();
  logger.info('Redis connected', { host: config.redis.host, port: config.redis.port });

  sessionService.setRedis(redis);

  // Start stale-session cleanup on interval.
  cleanupInterval = setInterval(async () => {
    try {
      await sessionService.cleanStaleSessions();
    } catch (err) {
      logger.error('Stale session cleanup error', { message: err.message });
    }
  }, config.session.cleanupIntervalSeconds * 1000);

  const app = createApp();
  server = app.listen(config.port, () => {
    logger.info(`Auth Service listening on port ${config.port}`, { env: config.nodeEnv });
  });

  return { server, redis };
}

async function stop() {
  clearInterval(cleanupInterval);
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  logger.info('Auth Service stopped');
}

// Graceful shutdown.
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  await stop();
  process.exit(0);
});

if (require.main === module) {
  start().catch((err) => {
    logger.error('Startup error', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { start, stop };

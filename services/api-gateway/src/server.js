'use strict';

const Redis = require('ioredis');
const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');

async function start() {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
    logger.info({ msg: 'Redis connected', host: config.redis.host });
  } catch (err) {
    logger.warn({ msg: 'Redis unavailable — rate limiting disabled', err: err.message });
  }

  const app = createApp(redis.status === 'ready' ? redis : null);
  const server = app.listen(config.port, () => {
    logger.info({ msg: 'API Gateway started', port: config.port });
  });

  const shutdown = async (signal) => {
    logger.info({ msg: 'Shutting down', signal });
    server.close(async () => {
      await redis.quit().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

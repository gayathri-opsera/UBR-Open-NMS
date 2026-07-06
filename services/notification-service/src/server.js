'use strict';
const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const kafkaConsumer = require('./services/kafka.consumer');

async function main() {
  try {
    await kafkaConsumer.start();
  } catch (err) {
    logger.warn('Kafka consumer failed to start — continuing without Kafka', { err: err.message });
  }

  const server = app.listen(config.port, () => {
    logger.info('Notification Service started', { port: config.port });
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    await kafkaConsumer.stop().catch(() => {});
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Fatal startup error', err);
  process.exit(1);
});

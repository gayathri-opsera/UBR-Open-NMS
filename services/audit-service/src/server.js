const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const kafkaConsumer = require('./services/kafka.consumer');

let server;

async function start() {
  await mongoose.connect(config.mongoUri);
  logger.info('MongoDB connected', { uri: config.mongoUri.replace(/\/\/.*@/, '//***@') });

  await kafkaConsumer.start();

  server = app.listen(config.port, () => {
    logger.info('Audit Service started', { port: config.port });
  });
}

async function stop() {
  logger.info('Shutting down Audit Service');
  await kafkaConsumer.stop();
  if (server) server.close();
  await mongoose.disconnect();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start().catch((err) => {
  logger.error('Failed to start Audit Service', { error: err.message });
  process.exit(1);
});

module.exports = { start, stop };

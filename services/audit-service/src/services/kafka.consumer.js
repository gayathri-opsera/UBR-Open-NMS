const { Kafka } = require('kafkajs');
const config = require('../config');
const logger = require('../utils/logger');
const { ingestEvent } = require('./audit.service');
const { forward } = require('./syslog.forwarder');

let consumer = null;

async function start() {
  if (!config.kafka.enabled) {
    logger.info('Kafka consumer disabled via config');
    return;
  }
  const kafka = new Kafka({ brokers: config.kafka.brokers, clientId: 'audit-service' });
  consumer = kafka.consumer({ groupId: config.kafka.groupId });

  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const event = JSON.parse(message.value.toString());
        const entry = await ingestEvent(event);
        forward(entry);
      } catch (err) {
        logger.error('Failed to process audit event from Kafka', { error: err.message });
      }
    },
  });

  logger.info('Kafka consumer started', { topic: config.kafka.topic });
}

async function stop() {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
  }
}

module.exports = { start, stop };

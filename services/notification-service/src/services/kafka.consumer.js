'use strict';
const { Kafka } = require('kafkajs');
const config = require('../config');
const logger = require('../utils/logger');
const sseService = require('./sse.service');
const emailService = require('./email.service');
const smsService = require('./sms.service');

const kafka = new Kafka({ clientId: 'notification-service', brokers: config.kafka.brokers });
const consumer = kafka.consumer({ groupId: config.kafka.groupId });

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topics.processedAlarms, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const alarm = JSON.parse(message.value.toString());
        alarm._consumedAt = Date.now();

        // Push to all SSE clients
        sseService.broadcast(alarm);

        // Email: CRITICAL and MAJOR
        if (['CRITICAL', 'MAJOR'].includes(alarm.severity)) {
          await emailService.sendEmail(alarm, config.smtp.recipients);
        }

        // SMS: CRITICAL only
        if (alarm.severity === 'CRITICAL') {
          await smsService.sendSms(alarm, config.sms.phoneNumbers);
        }

        logger.info('Alarm notification dispatched', { alarmId: alarm.alarmId, severity: alarm.severity });
      } catch (err) {
        logger.error('Failed to process alarm notification', { err: err.message });
      }
    },
  });

  logger.info('Kafka consumer started', { topic: config.kafka.topics.processedAlarms });
}

async function stop() {
  await consumer.disconnect();
}

module.exports = { start, stop };

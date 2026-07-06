'use strict';
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3003'),
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    groupId: process.env.KAFKA_GROUP_ID || 'notification-service',
    topics: {
      processedAlarms: process.env.KAFKA_TOPIC_PROCESSED_ALARMS || 'processed-alarms',
    },
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'nms-alerts@ubr.local',
    enabled: process.env.SMTP_ENABLED !== 'false',
    recipients: (process.env.SMTP_RECIPIENTS || '').split(',').filter(Boolean),
  },
  sms: {
    gatewayUrl: process.env.SMS_GATEWAY_URL || '',
    apiKey: process.env.SMS_API_KEY || '',
    enabled: process.env.SMS_ENABLED === 'true',
    phoneNumbers: (process.env.SMS_PHONE_NUMBERS || '').split(',').filter(Boolean),
  },
  sse: {
    heartbeatIntervalMs: parseInt(process.env.SSE_HEARTBEAT_MS || '30000'),
  },
  severityLevels: ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INFO'],
};

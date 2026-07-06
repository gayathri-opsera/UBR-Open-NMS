require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3007', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/ubrnms_audit',
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    groupId: process.env.KAFKA_GROUP_ID || 'audit-service',
    topic: process.env.KAFKA_AUDIT_TOPIC || 'audit-events',
    enabled: process.env.KAFKA_ENABLED !== 'false',
  },
  syslog: {
    host: process.env.SYSLOG_HOST || 'localhost',
    port: parseInt(process.env.SYSLOG_PORT || '514', 10),
    transport: process.env.SYSLOG_TRANSPORT || 'UDP',
    appName: process.env.SYSLOG_APP_NAME || 'ubrnms-audit',
    enabled: process.env.SYSLOG_ENABLED !== 'false',
  },
  audit: {
    ttlDays: parseInt(process.env.AUDIT_TTL_DAYS || '365', 10),
    maxExportRows: parseInt(process.env.AUDIT_MAX_EXPORT_ROWS || '10000', 10),
  },
};

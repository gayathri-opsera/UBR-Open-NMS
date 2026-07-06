'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Build the SMS payload for the configured REST SMS gateway.
 */
function buildSmsPayload(alarm, phoneNumbers) {
  return {
    to: phoneNumbers,
    message: `[${alarm.severity}] ${alarm.alarmName || alarm.alarmType} on ${alarm.deviceId}. State: ${alarm.state}.`,
    apiKey: config.sms.apiKey,
  };
}

/**
 * Send an SMS notification for a CRITICAL alarm.
 */
async function sendSms(alarm, phoneNumbers) {
  if (!config.sms.enabled || !config.sms.gatewayUrl || phoneNumbers.length === 0) return;
  const payload = buildSmsPayload(alarm, phoneNumbers);
  try {
    await axios.post(config.sms.gatewayUrl, payload, { timeout: 5000 });
    logger.info('SMS sent', { alarmId: alarm.alarmId, to: phoneNumbers });
  } catch (err) {
    logger.error('SMS send failed', { err: err.message });
  }
}

module.exports = { sendSms, buildSmsPayload };

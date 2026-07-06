'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

/**
 * Render a plain-text email body for an alarm.
 */
function renderEmailBody(alarm) {
  return [
    `UBR NMS Alert — ${alarm.severity}`,
    '',
    `Alarm: ${alarm.alarmName || alarm.alarmType}`,
    `Device: ${alarm.deviceId} (${alarm.deviceType})`,
    `Severity: ${alarm.severity}`,
    `State: ${alarm.state}`,
    `Description: ${alarm.description || ''}`,
    `Raised At: ${alarm.raisedAt || new Date().toISOString()}`,
    '',
    'This is an automated message from UBR NMS. Do not reply.',
  ].join('\n');
}

/**
 * Send an email notification for a CRITICAL or MAJOR alarm.
 * @param {object} alarm
 * @param {string[]} recipients
 */
async function sendEmail(alarm, recipients) {
  if (!config.smtp.enabled || !recipients || recipients.length === 0) return;
  const body = renderEmailBody(alarm);
  try {
    await getTransporter().sendMail({
      from: config.smtp.from,
      to: recipients.join(','),
      subject: `[${alarm.severity}] ${alarm.alarmName || alarm.alarmType} on ${alarm.deviceId}`,
      text: body,
    });
    logger.info('Email sent', { alarmId: alarm.alarmId, to: recipients });
  } catch (err) {
    logger.error('Email send failed', { err: err.message });
  }
}

module.exports = { sendEmail, renderEmailBody };

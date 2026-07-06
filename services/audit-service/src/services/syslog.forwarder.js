const syslog = require('syslog-client');
const config = require('../config');
const logger = require('../utils/logger');

let client = null;
const queue = [];
let flushing = false;
const MAX_QUEUE = 10000;

function getClient() {
  if (!client) {
    client = syslog.createClient(config.syslog.host, {
      syslogHostname: require('os').hostname(),
      port: config.syslog.port,
      transport: config.syslog.transport === 'TCP'
        ? syslog.Transport.Tcp
        : syslog.Transport.Udp,
      appName: config.syslog.appName,
    });

    client.on('error', (err) => {
      logger.warn('Syslog client error', { error: err.message });
      client = null;
    });
  }
  return client;
}

/**
 * Format an audit entry as RFC-5424-compatible message string.
 */
function formatMessage(entry) {
  return JSON.stringify({
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    result: entry.result,
    sourceIp: entry.sourceIp,
    correlationId: entry.correlationId,
    timestamp: entry.timestamp,
  });
}

async function flush() {
  if (flushing || queue.length === 0 || !config.syslog.enabled) return;
  flushing = true;
  while (queue.length > 0) {
    const entry = queue[0];
    await new Promise((resolve) => {
      try {
        getClient().log(
          formatMessage(entry),
          { facility: syslog.Facility.Security, severity: syslog.Severity.Informational },
          (err) => {
            if (err) {
              logger.warn('Syslog send failed, leaving in queue', { error: err.message });
              flushing = false;
              return resolve(false);
            }
            queue.shift();
            resolve(true);
          }
        );
      } catch (e) {
        logger.warn('Syslog exception', { error: e.message });
        flushing = false;
        resolve(false);
      }
    });
    if (!flushing) break;
  }
  flushing = false;
}

/**
 * Enqueue an audit entry for syslog forwarding.
 * Uses store-and-forward — events are buffered if syslog is unreachable.
 */
function forward(entry) {
  if (!config.syslog.enabled) return;
  if (queue.length >= MAX_QUEUE) {
    logger.warn('Syslog queue full, dropping oldest entry');
    queue.shift();
  }
  queue.push(entry);
  setImmediate(flush);
}

module.exports = { forward, flush };

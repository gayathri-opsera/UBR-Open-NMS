'use strict';
const { Histogram } = require('prom-client');

const ssePushLatency = new Histogram({
  name: 'notification_sse_push_latency_ms',
  help: 'SSE push latency from Kafka consume to client delivery in ms',
  buckets: [10, 25, 50, 100, 200, 500, 1000],
});

/** In-memory SSE client registry */
const clients = new Map(); // clientId → { res, userId, preferences }

/**
 * Register a new SSE client.
 * @param {string} clientId
 * @param {object} res  Express response object
 * @param {string|null} userId
 */
function addClient(clientId, res, userId) {
  clients.set(clientId, { res, userId, connectedAt: Date.now() });
}

/**
 * Remove a disconnected client.
 */
function removeClient(clientId) {
  clients.delete(clientId);
}

/**
 * Push an alarm event to all connected SSE clients.
 * @param {object} alarm
 */
function broadcast(alarm) {
  const consumed = alarm._consumedAt || Date.now();
  const payload = formatSseEvent(alarm);

  for (const [id, client] of clients) {
    try {
      client.res.write(payload);
      ssePushLatency.observe(Date.now() - consumed);
    } catch (err) {
      clients.delete(id);
    }
  }
}

/**
 * Format an alarm object as an SSE data frame.
 */
function formatSseEvent(alarm) {
  const event = {
    alarmId: alarm.alarmId,
    alarmName: alarm.alarmName,
    severity: alarm.severity,
    deviceId: alarm.deviceId,
    deviceType: alarm.deviceType,
    timestamp: alarm.raisedAt || new Date().toISOString(),
    state: alarm.state,
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, removeClient, broadcast, formatSseEvent, clientCount };

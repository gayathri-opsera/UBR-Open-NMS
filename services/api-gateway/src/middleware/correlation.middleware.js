'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Injects X-Correlation-ID header if not present,
 * then propagates it to downstream service requests.
 */
function correlationId(req, res, next) {
  const existing = req.headers['x-correlation-id'];
  const correlationID = existing || uuidv4();
  req.correlationId = correlationID;
  req.headers['x-correlation-id'] = correlationID;
  res.set('X-Correlation-ID', correlationID);
  next();
}

module.exports = { correlationId };

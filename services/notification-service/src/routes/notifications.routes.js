'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');
const sseService = require('../services/sse.service');
const preferenceService = require('../services/preference.service');

const router = express.Router();

/** SSE stream endpoint */
router.get('/stream', (req, res) => {
  const clientId = uuidv4();
  const userId = req.query.userId || null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseService.addClient(clientId, res, userId);
  logger.info('SSE client connected', { clientId, total: sseService.clientCount() });

  // Send initial heartbeat
  res.write(':heartbeat\n\n');

  // Periodic heartbeat to prevent connection timeout
  const heartbeat = setInterval(() => {
    try {
      res.write(':heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, config.sse.heartbeatIntervalMs);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseService.removeClient(clientId);
    logger.info('SSE client disconnected', { clientId, total: sseService.clientCount() });
  });
});

/** Notification preferences */
router.put('/preferences', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  preferenceService.setPreferences(userId, req.body);
  res.json({ ok: true, preferences: preferenceService.getPreferences(userId) });
});

router.get('/preferences/:userId', (req, res) => {
  res.json(preferenceService.getPreferences(req.params.userId));
});

module.exports = router;

'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');
const sseService = require('../services/sse.service');
const preferenceService = require('../services/preference.service');

const router = express.Router();

// ── In-memory notification rules store ────────────────────────────────────────
let notifRules = [
  {
    id: 'nr-1', name: 'Device Offline Alert', description: 'Notify when a device goes offline',
    metric: 'device_status', condition: 'OFFLINE', severity: 'CRITICAL',
    channels: ['email'], enabled: true, createdAt: new Date().toISOString(),
  },
  {
    id: 'nr-2', name: 'High CPU Warning', description: 'Notify when CPU exceeds 90%',
    metric: 'cpu_usage', condition: 'ABOVE_90', severity: 'WARNING',
    channels: ['email', 'sms'], enabled: true, createdAt: new Date().toISOString(),
  },
  {
    id: 'nr-3', name: 'Provisioning Request', description: 'New device awaiting provisioning approval',
    metric: 'discovery_event', condition: 'PROVISIONING', severity: 'INFO',
    channels: ['email'], enabled: false, createdAt: new Date().toISOString(),
  },
];
let nextRuleId = 4;

// GET /api/v1/notifications/rules
router.get('/rules', (_req, res) => res.json(notifRules));

// POST /api/v1/notifications/rules
router.post('/rules', (req, res) => {
  const { name, metric, condition, severity, channels } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const rule = {
    id: `nr-${nextRuleId++}`, name, description: req.body.description || '',
    metric: metric || 'device_status', condition: condition || 'OFFLINE',
    severity: severity || 'INFO', channels: channels || ['email'],
    enabled: true, createdAt: new Date().toISOString(),
  };
  notifRules.push(rule);
  res.status(201).json(rule);
});

// PUT /api/v1/notifications/rules/:id
router.put('/rules/:id', (req, res) => {
  const idx = notifRules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  notifRules[idx] = { ...notifRules[idx], ...req.body, id: req.params.id };
  res.json(notifRules[idx]);
});

// PATCH /api/v1/notifications/rules/:id  (toggle enabled)
router.patch('/rules/:id', (req, res) => {
  const idx = notifRules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  notifRules[idx] = { ...notifRules[idx], ...req.body, id: req.params.id };
  res.json(notifRules[idx]);
});

// DELETE /api/v1/notifications/rules/:id
router.delete('/rules/:id', (req, res) => {
  const idx = notifRules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  notifRules.splice(idx, 1);
  res.status(204).end();
});

// POST /api/v1/notifications/rules/:id/test
router.post('/rules/:id/test', (req, res) => {
  const rule = notifRules.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json({ status: 'ok', message: `Test notification sent for rule: ${rule.name}` });
});

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

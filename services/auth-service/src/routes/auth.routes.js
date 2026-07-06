'use strict';

const express = require('express');
const authService = require('../services/auth.service');
const sessionService = require('../services/session.service');
const { authenticate, requireRole } = require('../middleware/rbac.middleware');
const {
  handleValidationErrors,
  loginRules,
  refreshRules,
} = require('../middleware/validate.middleware');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/v1/auth/login
 * Accepts {username, password}, returns {accessToken, refreshToken, expiresIn, role}.
 */
router.post('/login', loginRules, handleValidationErrors, async (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || '';

    const result = await authService.login(username, password, ip, userAgent);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) {
    const status = err.status || 401;
    res.status(status).json({
      status: 'error',
      error: { code: err.code || 'AUTH_FAILED', message: err.message },
    });
  }
});

/**
 * POST /api/v1/auth/refresh
 * Accepts {refreshToken}, returns new {accessToken, refreshToken, expiresIn, role}.
 */
router.post('/refresh', refreshRules, handleValidationErrors, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const result = await authService.refresh(refreshToken);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) {
    res.status(err.status || 401).json({
      status: 'error',
      error: { code: err.code || 'REFRESH_FAILED', message: err.message },
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * Requires Bearer token. Invalidates refresh token from request body.
 */
router.post('/logout', authenticate, refreshRules, handleValidationErrors, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    await authService.logout(refreshToken, req.user.userId, req.user.username);
    res.status(200).json({ status: 'ok', data: { message: 'Session terminated.' } });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: { code: 'LOGOUT_ERROR', message: err.message },
    });
  }
});

/**
 * GET /api/v1/auth/sessions
 * List all active sessions (admin only). Scans Redis session-activity keys.
 */
router.get('/sessions', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const sessions = await sessionService.listAllSessions();
    res.status(200).json({ status: 'ok', data: sessions });
  } catch (err) {
    logger.error('Failed to list sessions', { message: err.message });
    res.status(200).json({ status: 'ok', data: [] }); // degrade gracefully
  }
});

/**
 * DELETE /api/v1/auth/sessions/:sessionId
 * Terminate a specific session (admin only).
 */
router.delete('/sessions/:sessionId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await sessionService.terminateSessionById(req.params.sessionId);
    res.status(200).json({ status: 'ok', data: { message: 'Session terminated.' } });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: { code: 'TERMINATE_ERROR', message: err.message },
    });
  }
});

module.exports = router;

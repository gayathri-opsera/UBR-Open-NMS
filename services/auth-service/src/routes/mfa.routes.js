'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const mfaService = require('../services/mfa.service');
const jwtService = require('../services/jwt.service');
const sessionService = require('../services/session.service');
const { authenticate, requireRole } = require('../middleware/rbac.middleware');
const { User } = require('../models/user.model');
const logger = require('../utils/logger');
const config = require('../config');

const router = express.Router();

// ── Validation helpers ────────────────────────────────────────────────────────

const otpRule = body('code')
  .trim()
  .matches(/^\d{6}$/)
  .withMessage('OTP code must be exactly 6 digits.');

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg },
    });
  }
  return null;
}

// ── GET /api/v1/auth/mfa/status ───────────────────────────────────────────────
/**
 * Returns whether MFA is enabled for the authenticated user.
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const status = await mfaService.getMfaStatus(req.user.userId);
    res.json({ status: 'ok', data: status });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'MFA_STATUS_ERROR', message: err.message },
    });
  }
});

// ── POST /api/v1/auth/mfa/setup ───────────────────────────────────────────────
/**
 * Step 1 of enrollment: generate a TOTP secret + QR code.
 * User scans QR code with Google Authenticator / Authy.
 * MFA is NOT enabled until /mfa/verify-setup is called with a valid OTP.
 */
router.post('/setup', authenticate, async (req, res) => {
  try {
    const result = await mfaService.setupMfa(req.user.userId, req.user.username || req.user.userId);
    res.json({
      status: 'ok',
      data: {
        qrCodeDataUrl: result.qrCodeDataUrl,
        // Return the manual entry key for users who cannot scan the QR code
        manualEntryKey: result.secret,
        instructions: [
          '1. Open Google Authenticator, Authy, or any TOTP app',
          '2. Tap "+" → "Scan QR code" and scan the QR code above',
          '3. Alternatively enter the manual key manually',
          '4. Call POST /api/v1/auth/mfa/verify-setup with the 6-digit code to confirm',
        ],
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'MFA_SETUP_ERROR', message: err.message },
    });
  }
});

// ── POST /api/v1/auth/mfa/verify-setup ───────────────────────────────────────
/**
 * Step 2 of enrollment: verify the first OTP from the authenticator app.
 * Activates MFA on success.
 */
router.post('/verify-setup', authenticate, otpRule, async (req, res) => {
  const validationErr = handleValidation(req, res);
  if (validationErr) return;

  try {
    await mfaService.enableMfa(req.user.userId, req.body.code);
    res.json({
      status: 'ok',
      data: {
        message: 'MFA has been enabled successfully. Your next login will require an OTP.',
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'MFA_ENABLE_ERROR', message: err.message },
    });
  }
});

// ── POST /api/v1/auth/mfa/challenge ──────────────────────────────────────────
/**
 * Step 2 of login when MFA is active.
 * Accepts { mfaToken, code } and returns full { accessToken, refreshToken } on success.
 * This route is PUBLIC (no Bearer token required) — the mfaToken IS the credential.
 */
router.post('/challenge', [
  body('mfaToken').notEmpty().withMessage('mfaToken is required.'),
  otpRule,
], async (req, res) => {
  const validationErr = handleValidation(req, res);
  if (validationErr) return;

  const { mfaToken, code } = req.body;

  // 1. Verify the MFA challenge token (short-lived, symmetric-signed)
  const payload = jwtService.verifyMfaChallengeToken(mfaToken);
  if (!payload) {
    return res.status(401).json({
      status: 'error',
      error: {
        code: 'MFA_TOKEN_EXPIRED',
        message: 'MFA session has expired or is invalid. Please log in again.',
      },
    });
  }

  const { sub: userId, username, role } = payload;

  try {
    // 2. Verify the TOTP code against the user's secret
    await mfaService.verifyOtp(userId, code);

    // 3. All checks passed — issue the real JWT access + refresh tokens
    const accessToken = jwtService.generateAccessToken(userId, role);
    const refreshToken = jwtService.generateRefreshToken();

    await sessionService.createSession(userId, role, refreshToken, {
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
      userAgent: req.headers['user-agent'] || '',
    });

    await User.findByIdAndUpdate(userId, { lastLogin: new Date() });

    logger.info('MFA challenge completed — login successful', { userId, role });

    res.json({
      status: 'ok',
      data: {
        accessToken,
        refreshToken,
        expiresIn: config.jwt.accessTokenTtlSeconds,
        role,
        userId,
      },
    });
  } catch (err) {
    res.status(err.status || 401).json({
      status: 'error',
      error: { code: err.code || 'MFA_CHALLENGE_FAILED', message: err.message },
    });
  }
});

// ── DELETE /api/v1/auth/mfa/disable ──────────────────────────────────────────
/**
 * Self-service: authenticated user disables their own MFA.
 * Requires a valid OTP code as confirmation.
 */
router.delete('/disable', authenticate, otpRule, async (req, res) => {
  const validationErr = handleValidation(req, res);
  if (validationErr) return;

  try {
    await mfaService.disableMfa(req.user.userId, req.body.code, false);
    res.json({
      status: 'ok',
      data: { message: 'MFA has been disabled.' },
    });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'MFA_DISABLE_ERROR', message: err.message },
    });
  }
});

// ── DELETE /api/v1/auth/mfa/admin/reset/:userId ───────────────────────────────
/**
 * Admin-only: reset MFA for a user (e.g., locked out of authenticator app).
 * Does NOT require the user's OTP — admin override.
 */
router.delete('/admin/reset/:userId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await mfaService.disableMfa(req.params.userId, null, true);
    logger.info('Admin MFA reset', { adminId: req.user.userId, targetUserId: req.params.userId });
    res.json({
      status: 'ok',
      data: { message: `MFA has been reset for user ${req.params.userId}.` },
    });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'MFA_ADMIN_RESET_ERROR', message: err.message },
    });
  }
});

module.exports = router;

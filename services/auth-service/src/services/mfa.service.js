'use strict';

// otplib v12 (CJS) exports { authenticator } directly.
// Defensive import handles both v12 CJS and v13 ESM-compat shapes.
const otplib = require('otplib');
const authenticator = otplib.authenticator ?? otplib.default?.authenticator ?? otplib;
const QRCode = require('qrcode');
const { User } = require('../models/user.model');
const logger = require('../utils/logger');

// TOTP window: accept 1 step before/after to handle clock skew (~30s drift)
if (authenticator && typeof authenticator === 'object') {
  authenticator.options = { window: 1 };
}

const APP_NAME = 'UBR-NMS';

/**
 * Generate a new TOTP secret and QR code for a user.
 * Stores the secret as mfaPendingSecret (not active until verified).
 * Returns { qrCodeDataUrl, secret, otpAuthUrl }
 */
async function setupMfa(userId, username) {
  const secret = authenticator.generateSecret(20); // 20-byte = 160-bit secret
  const otpAuthUrl = authenticator.keyuri(username, APP_NAME, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

  await User.findByIdAndUpdate(userId, {
    mfaPendingSecret: secret,
    // Do NOT set mfaEnabled yet — user must verify first
  });

  logger.info('MFA setup initiated', { userId });
  return { qrCodeDataUrl, secret, otpAuthUrl };
}

/**
 * Verify the OTP code against the pending secret.
 * On success, promotes mfaPendingSecret → mfaSecret and sets mfaEnabled=true.
 * Returns true on success, throws on failure.
 */
async function enableMfa(userId, code) {
  const user = await User.findById(userId).select('+mfaSecret +mfaPendingSecret');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!user.mfaPendingSecret) {
    const err = new Error('No MFA setup in progress. Call /mfa/setup first.');
    err.code = 'MFA_NOT_INITIATED';
    err.status = 400;
    throw err;
  }
  if (user.mfaEnabled) {
    const err = new Error('MFA is already enabled. Disable it first to re-enroll.');
    err.code = 'MFA_ALREADY_ENABLED';
    err.status = 409;
    throw err;
  }

  const isValid = authenticator.verify({ token: code, secret: user.mfaPendingSecret });
  if (!isValid) {
    const err = new Error('Invalid OTP code. Please check your authenticator app and try again.');
    err.code = 'INVALID_OTP';
    err.status = 401;
    throw err;
  }

  await User.findByIdAndUpdate(userId, {
    mfaEnabled: true,
    mfaSecret: user.mfaPendingSecret,
    mfaPendingSecret: null,
    mfaEnabledAt: new Date(),
  });

  logger.info('MFA enabled successfully', { userId });
  return true;
}

/**
 * Verify a TOTP code against the user's active mfaSecret.
 * Used during the login challenge step.
 * Returns true on success, throws on failure.
 */
async function verifyOtp(userId, code) {
  const user = await User.findById(userId).select('+mfaSecret');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!user.mfaEnabled || !user.mfaSecret) {
    const err = new Error('MFA is not enabled for this account.');
    err.code = 'MFA_NOT_ENABLED';
    err.status = 400;
    throw err;
  }

  const isValid = authenticator.verify({ token: code, secret: user.mfaSecret });
  if (!isValid) {
    logger.warn('MFA OTP verification failed', { userId });
    const err = new Error('Invalid or expired OTP code.');
    err.code = 'INVALID_OTP';
    err.status = 401;
    throw err;
  }

  logger.info('MFA OTP verified', { userId });
  return true;
}

/**
 * Disable MFA for a user.
 * Requires the user to confirm with a valid OTP (unless called by admin with adminOverride=true).
 */
async function disableMfa(userId, code, adminOverride = false) {
  const user = await User.findById(userId).select('+mfaSecret');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!user.mfaEnabled) {
    const err = new Error('MFA is not currently enabled.');
    err.code = 'MFA_NOT_ENABLED';
    err.status = 400;
    throw err;
  }

  // Verify OTP unless admin is resetting for a locked-out user
  if (!adminOverride) {
    const isValid = authenticator.verify({ token: code, secret: user.mfaSecret });
    if (!isValid) {
      const err = new Error('Invalid OTP code. Provide a valid code to disable MFA.');
      err.code = 'INVALID_OTP';
      err.status = 401;
      throw err;
    }
  }

  await User.findByIdAndUpdate(userId, {
    mfaEnabled: false,
    mfaSecret: null,
    mfaPendingSecret: null,
    mfaEnabledAt: null,
  });

  logger.info('MFA disabled', { userId, adminOverride });
  return true;
}

/**
 * Return MFA status for a user (no secrets exposed).
 */
async function getMfaStatus(userId) {
  const user = await User.findById(userId).select('mfaEnabled mfaEnabledAt');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return {
    mfaEnabled: user.mfaEnabled,
    mfaEnabledAt: user.mfaEnabledAt || null,
  };
}

module.exports = { setupMfa, enableMfa, verifyOtp, disableMfa, getMfaStatus };

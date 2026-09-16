'use strict';

// speakeasy is a pure CJS TOTP library — no ESM dependencies
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { User } = require('../models/user.model');
const logger = require('../utils/logger');

/**
 * Emit a WO-020 MFA audit event via structured logger.
 * SECURITY: never include OTP codes, TOTP secrets, or backup code values.
 * @private
 */
function _emitMfaAudit(action, userId, outcome, reason) {
  logger.info('mfa.audit', {
    action,
    actor: {
      userId: userId ? String(userId) : 'unknown',
      username: 'mfa-flow',
      role: 'user',
    },
    resource: 'mfa',
    resourceId: userId ? String(userId) : undefined,
    outcome,
    serviceSource: 'mfa-service',
    payload: reason ? { reason } : {},
    timestamp: new Date().toISOString(),
  });
}

const APP_NAME_PREFIX = 'UBR-NMS';
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_BCRYPT_ROUNDS = 12;

// Roles that require MFA by policy. Admin accounts must enroll before receiving a full token.
const MFA_REQUIRED_ROLES = new Set(['admin']);

/**
 * Generate a new TOTP secret and QR code for a user.
 * Stores the secret as mfaPendingSecret (not active until verified).
 * Returns { qrCodeDataUrl, secret, otpAuthUrl }
 */
async function setupMfa(userId, username) {
  const secretObj = speakeasy.generateSecret({ length: 20, name: `${APP_NAME_PREFIX}:${username}`, issuer: APP_NAME_PREFIX });
  const secret = secretObj.base32;
  const otpAuthUrl = secretObj.otpauth_url;
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

  const isValid = speakeasy.totp.verify({ secret: user.mfaPendingSecret, encoding: 'base32', token: code, window: 1 });
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

  _emitMfaAudit('mfa.enrolled', userId, 'success', null);
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

  const isValid = speakeasy.totp.verify({ secret: user.mfaSecret, encoding: 'base32', token: code, window: 1 });
  if (!isValid) {
    _emitMfaAudit('mfa.challenge.failed', userId, 'failure', 'INVALID_OTP');
    logger.warn('MFA OTP verification failed', { userId });
    const err = new Error('Invalid or expired OTP code.');
    err.code = 'INVALID_OTP';
    err.status = 401;
    throw err;
  }

  _emitMfaAudit('mfa.challenge.success', userId, 'success', null);
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
    const isValid = speakeasy.totp.verify({ secret: user.mfaSecret, encoding: 'base32', token: code, window: 1 });
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

  _emitMfaAudit('mfa.disabled', userId, 'success', adminOverride ? 'ADMIN_OVERRIDE' : null);
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

/**
 * Returns true when the given role is required to have MFA by policy (WO-014).
 */
function isMfaRequiredForRole(role) {
  return MFA_REQUIRED_ROLES.has((role || '').toLowerCase());
}

/**
 * Generate 8 single-use backup recovery codes and store them bcrypt-hashed.
 * Returns the plaintext codes ONCE — they cannot be recovered after this call.
 * The caller must display them immediately and store nothing.
 *
 * SECURITY: raw codes are returned only here; hashes are persisted.
 */
async function generateBackupCodes(userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!user.mfaEnabled) {
    const err = new Error('MFA must be enabled before generating backup codes.');
    err.code = 'MFA_NOT_ENABLED';
    err.status = 400;
    throw err;
  }

  // Generate raw codes (UUID fragments for entropy)
  const rawCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    (uuidv4().replace(/-/g, '').slice(0, 8)).toUpperCase()
  );

  // Hash each code — same bcrypt settings as passwords
  const hashes = await Promise.all(
    rawCodes.map((code) => bcrypt.hash(code, BACKUP_CODE_BCRYPT_ROUNDS))
  );

  await User.findByIdAndUpdate(userId, { mfaBackupCodes: hashes });

  logger.info('MFA backup codes generated', { userId });
  // SECURITY: return raw codes only once; they are never stored in plaintext
  return { backupCodes: rawCodes };
}

/**
 * Verify a backup recovery code for a user.
 * On success, the used code is invalidated (removed from the stored list).
 * Returns true on success, throws on failure.
 *
 * SECURITY: timing-safe bcrypt comparison is used to prevent code enumeration.
 */
async function verifyBackupCode(userId, code) {
  const user = await User.findById(userId).select('+mfaBackupCodes +mfaSecret');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!user.mfaEnabled || !user.mfaBackupCodes || user.mfaBackupCodes.length === 0) {
    const err = new Error('No backup codes available for this account.');
    err.code = 'NO_BACKUP_CODES';
    err.status = 400;
    throw err;
  }

  // Find the matching hash using timing-safe comparison
  let matchedIndex = -1;
  for (let i = 0; i < user.mfaBackupCodes.length; i++) {
    const isMatch = await bcrypt.compare(code, user.mfaBackupCodes[i]);
    if (isMatch) {
      matchedIndex = i;
      break; // stop at first match — codes are unique
    }
  }

  if (matchedIndex === -1) {
    logger.warn('MFA backup code verification failed', { userId });
    const err = new Error('Invalid backup code.');
    err.code = 'INVALID_BACKUP_CODE';
    err.status = 401;
    throw err;
  }

  // Invalidate the used code by removing it from the array
  const remaining = user.mfaBackupCodes.filter((_, i) => i !== matchedIndex);
  await User.findByIdAndUpdate(userId, { mfaBackupCodes: remaining });

  _emitMfaAudit('mfa.backup_code.used', userId, 'success', null);
  logger.info('MFA backup code used', { userId, remaining: remaining.length });
  return true;
}

/**
 * Disable MFA for a user, also clearing backup codes.
 * Requires the user to confirm with a valid OTP (unless called by admin with adminOverride=true).
 * Overrides the original disableMfa to also clear backup codes (WO-014).
 */
async function disableMfaWithCleanup(userId, code, adminOverride = false) {
  const result = await disableMfa(userId, code, adminOverride);
  // Clear backup codes on MFA disable
  await User.findByIdAndUpdate(userId, { mfaBackupCodes: [], mfaResetRequired: false });
  logger.info('MFA backup codes cleared on disable', { userId });
  return result;
}

module.exports = {
  setupMfa,
  enableMfa,
  verifyOtp,
  disableMfa: disableMfaWithCleanup,
  getMfaStatus,
  isMfaRequiredForRole,
  generateBackupCodes,
  verifyBackupCode,
};

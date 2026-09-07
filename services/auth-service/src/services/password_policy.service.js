'use strict';

const { User, validatePasswordComplexity } = require('../models/user.model');
const logger = require('../utils/logger');

/**
 * Password policy constants — configurable via environment variables.
 *
 * Default renewal period is 60 days per the platform's stated security policy.
 * Warning window allows UI to prompt the user before enforcement kicks in.
 */
const PASSWORD_MAX_AGE_DAYS = parseInt(process.env.PASSWORD_MAX_AGE_DAYS || '60', 10);
const PASSWORD_WARNING_DAYS = parseInt(process.env.PASSWORD_WARNING_DAYS || '7', 10);

// ── Policy helpers ─────────────────────────────────────────────────────────────

/**
 * Calculate the age of a password in milliseconds from its last-change timestamp.
 * Missing timestamps are treated as maximally aged (expired) to be safe.
 *
 * @param {Date|null} passwordChangedAt
 * @returns {number} age in milliseconds
 */
function passwordAgeMs(passwordChangedAt) {
  if (!passwordChangedAt) {
    // Legacy user with no recorded change date — treat as expired per safe default policy.
    return Infinity;
  }
  return Date.now() - new Date(passwordChangedAt).getTime();
}

/**
 * Returns the policy state for a local user password.
 *
 * @param {Date|null} passwordChangedAt
 * @returns {{ expired: boolean, warning: boolean, expiresAt: Date|null, daysRemaining: number }}
 */
function evaluatePasswordAge(passwordChangedAt) {
  const maxAgeMs = PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const warningMs = PASSWORD_WARNING_DAYS * 24 * 60 * 60 * 1000;

  const ageMs = passwordAgeMs(passwordChangedAt);
  const remainingMs = maxAgeMs - ageMs;
  const daysRemaining = Math.floor(remainingMs / (24 * 60 * 60 * 1000));

  const expiresAt = passwordChangedAt
    ? new Date(new Date(passwordChangedAt).getTime() + maxAgeMs)
    : null;

  return {
    expired: ageMs >= maxAgeMs,
    warning: ageMs >= (maxAgeMs - warningMs) && ageMs < maxAgeMs,
    expiresAt,
    daysRemaining: Math.max(0, daysRemaining),
  };
}

/**
 * Returns true when the user authenticates via a federated identity provider
 * and is NOT using a local password fallback.
 * SSO/LDAP/OIDC/SAML users must not be blocked by local password expiry unless
 * they actually authenticated with a local password (identityProvider === 'local').
 *
 * @param {object} user - mongoose User document
 * @returns {boolean}
 */
function isExemptFromLocalPolicy(user) {
  if (!user) return false;
  // LDAP users are managed by the directory; only exempt if they have no local password
  if (user.isLdapUser && !user.passwordHash) return true;
  // Future: OIDC/SAML users provisioned via SSO have no passwordHash
  if (!user.passwordHash) return true;
  return false;
}

// ── Check-and-enforce gate ──────────────────────────────────────────────────────

/**
 * Check password policy for a local user and return gate result.
 *
 * Returns:
 *   { status: 'ok' }                               – no policy issue
 *   { status: 'warning', expiresAt, daysRemaining } – password expiring soon
 *   { status: 'expired', userId }                   – password must be renewed
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function checkPasswordPolicy(userId) {
  const user = await User.findById(userId).select('passwordChangedAt isLdapUser passwordHash passwordResetRequired');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (isExemptFromLocalPolicy(user)) {
    return { status: 'ok' };
  }

  // Admin-triggered forced reset takes precedence over age calculation
  if (user.passwordResetRequired) {
    return { status: 'expired', userId: String(user._id), reason: 'ADMIN_RESET_REQUIRED' };
  }

  const { expired, warning, expiresAt, daysRemaining } = evaluatePasswordAge(user.passwordChangedAt);

  if (expired) {
    logger.info('Password expired', { userId, passwordChangedAt: user.passwordChangedAt });
    return { status: 'expired', userId: String(user._id), reason: 'PASSWORD_EXPIRED' };
  }

  if (warning) {
    return { status: 'warning', expiresAt, daysRemaining };
  }

  return { status: 'ok', expiresAt, daysRemaining };
}

// ── Password renewal ────────────────────────────────────────────────────────────

/**
 * Execute a forced password renewal for a local user.
 *
 * Validates:
 *   - User is a local user (not SSO/LDAP-only)
 *   - Current password is correct (where currentPassword is provided and user is not admin-reset)
 *   - New password passes complexity requirements
 *   - New password is not a recently used password
 *
 * On success: updates passwordChangedAt, clears passwordResetRequired, and returns the user.
 *
 * @param {string} userId
 * @param {string} newPassword
 * @param {string|null} currentPassword  - required when not an admin-reset
 * @returns {Promise<object>} updated user
 */
async function renewPassword(userId, newPassword, currentPassword) {
  const user = await User.findById(userId).select('+passwordHash +passwordHistory +passwordChangedAt isLdapUser passwordResetRequired');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  // Block federated users from changing a local password they do not own
  if (user.isLdapUser && !user.passwordHash && !user.passwordResetRequired) {
    const err = new Error('Password renewal is not available for externally managed accounts on this login method.');
    err.code = 'POLICY_EXEMPT_USER';
    err.status = 403;
    throw err;
  }

  // When not an admin-forced reset, verify the current password
  if (!user.passwordResetRequired && currentPassword !== undefined) {
    if (!user.passwordHash) {
      const err = new Error('No local password is configured for this account.');
      err.code = 'NO_LOCAL_PASSWORD';
      err.status = 400;
      throw err;
    }
    const valid = await user.verifyPassword(currentPassword);
    if (!valid) {
      const err = new Error('Current password is incorrect.');
      err.code = 'INVALID_CURRENT_PASSWORD';
      err.status = 401;
      throw err;
    }
  }

  // Validate new password complexity
  const complexityError = validatePasswordComplexity(newPassword);
  if (complexityError) {
    const err = new Error(complexityError);
    err.code = 'PASSWORD_COMPLEXITY_VIOLATION';
    err.status = 400;
    throw err;
  }

  // setPassword checks history and throws PASSWORD_REUSE if re-used
  await user.setPassword(newPassword);
  user.passwordResetRequired = false;
  await user.save();

  logger.info('Password renewed', { userId });
  return user;
}

module.exports = {
  checkPasswordPolicy,
  renewPassword,
  evaluatePasswordAge,
  isExemptFromLocalPolicy,
  PASSWORD_MAX_AGE_DAYS,
  PASSWORD_WARNING_DAYS,
};

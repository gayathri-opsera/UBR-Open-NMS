'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const config = require('../config');

const ROLES = Object.freeze(['admin', 'operator', 'user']);

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: ROLES,
      required: true,
      default: 'user',
    },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    passwordHistory: {
      type: [String],
      default: [],
      select: false,
    },
    failedAttempts: {
      type: Number,
      default: 0,
    },
    lockoutUntil: {
      type: Date,
      default: null,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    isLdapUser: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.passwordHistory;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * Verify a plain-text password against the stored bcrypt hash.
 * Returns false for LDAP-only users (no local password).
 */
userSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

/**
 * Hash and set a new password, rotating out old history.
 * Throws if the password was used recently (per ITSAR history policy).
 */
userSchema.methods.setPassword = async function setPassword(plain) {
  const hash = await bcrypt.hash(plain, config.password.bcryptRounds);

  // Load history (field is hidden by default)
  const doc = await User.findById(this._id).select('+passwordHistory');
  const history = doc ? doc.passwordHistory : [];

  for (const oldHash of history) {
    if (await bcrypt.compare(plain, oldHash)) {
      const err = new Error('Password was used recently. Choose a different password.');
      err.code = 'PASSWORD_REUSE';
      throw err;
    }
  }

  const updatedHistory = [hash, ...history].slice(0, config.password.historyDepth);
  this.passwordHash = hash;
  this.passwordHistory = updatedHistory;
  this.passwordChangedAt = new Date();
};

/**
 * True when the account is currently locked out.
 */
userSchema.methods.isLockedOut = function isLockedOut() {
  return this.lockoutUntil && this.lockoutUntil > new Date();
};

/**
 * Validate ITSAR password complexity.
 * Returns null on success, error message string on failure.
 */
function validatePasswordComplexity(password) {
  if (!password || password.length < 12) {
    return 'Password must be at least 12 characters long.';
  }
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit.';
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return 'Password must contain at least one special character.';
  }
  return null;
}

const User = mongoose.model('User', userSchema);

module.exports = { User, ROLES, validatePasswordComplexity };

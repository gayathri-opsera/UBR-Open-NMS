'use strict';

const { User, ROLES, validatePasswordComplexity } = require('../models/user.model');
const sessionService = require('./session.service');
const logger = require('../utils/logger');

async function createUser({ username, email, password, role, permissions }) {
  const complexityError = validatePasswordComplexity(password);
  if (complexityError) {
    const err = new Error(complexityError);
    err.code = 'WEAK_PASSWORD';
    err.status = 422;
    throw err;
  }

  const user = new User({ username, email, role: role || 'user', permissions: permissions || {} });
  await user.setPassword(password);
  await user.save();
  return user.toJSON();
}

async function getUserById(id) {
  const user = await User.findById(id);
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return user.toJSON();
}

async function listUsers({ page = 1, limit = 50 } = {}) {
  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find().skip(skip).limit(limit).lean(),
    User.countDocuments(),
  ]);
  return { users, total, page, limit };
}

async function updateUser(id, updates) {
  const allowedFields = ['email', 'role', 'permissions', 'isActive'];
  const filtered = {};
  for (const f of allowedFields) {
    if (updates[f] !== undefined) filtered[f] = updates[f];
  }

  if (filtered.role && !ROLES.includes(filtered.role)) {
    const err = new Error(`Invalid role. Must be one of: ${ROLES.join(', ')}`);
    err.code = 'INVALID_ROLE';
    err.status = 422;
    throw err;
  }

  const user = await User.findByIdAndUpdate(id, filtered, { new: true, runValidators: true });
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  // If role changed, invalidate all active sessions to force re-login with new claims.
  if (filtered.role) {
    await sessionService.destroyAllSessions(id);
    logger.info('Sessions invalidated after role change', { userId: id, newRole: filtered.role });
  }

  return user.toJSON();
}

async function deleteUser(id) {
  const user = await User.findByIdAndDelete(id);
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }
  await sessionService.destroyAllSessions(id);
  logger.info('User deleted', { userId: id });
}

async function changePassword(id, currentPassword, newPassword) {
  const complexityError = validatePasswordComplexity(newPassword);
  if (complexityError) {
    const err = new Error(complexityError);
    err.code = 'WEAK_PASSWORD';
    err.status = 422;
    throw err;
  }

  const user = await User.findById(id).select('+passwordHash +passwordHistory');
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  if (user.passwordHash) {
    const valid = await user.verifyPassword(currentPassword);
    if (!valid) {
      const err = new Error('Current password is incorrect.');
      err.code = 'INVALID_CREDENTIALS';
      err.status = 401;
      throw err;
    }
  }

  await user.setPassword(newPassword);
  await user.save();
  await sessionService.destroyAllSessions(id);
  logger.info('Password changed — all sessions invalidated', { userId: id });
}

module.exports = { createUser, getUserById, listUsers, updateUser, deleteUser, changePassword };

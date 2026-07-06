'use strict';

const express = require('express');
const userService = require('../services/user.service');
const { authenticate, requireRole } = require('../middleware/rbac.middleware');
const {
  handleValidationErrors,
  createUserRules,
  changePasswordRules,
} = require('../middleware/validate.middleware');
const { validatePasswordComplexity } = require('../models/user.model');

const router = express.Router();

// All /api/v1/users routes require authentication.
router.use(authenticate);

// All user management requires admin role (Operator and User receive 403).
router.use(requireRole('admin'));

/**
 * GET /api/v1/users
 * List users (admin only). Supports ?page=&limit= pagination.
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const result = await userService.listUsers({ page, limit });
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: { code: 'LIST_ERROR', message: err.message } });
  }
});

/**
 * POST /api/v1/users
 * Create a new local user (admin only).
 */
router.post('/', createUserRules, handleValidationErrors, async (req, res) => {
  try {
    const { username, email, password, role, permissions } = req.body;

    const complexityErr = validatePasswordComplexity(password);
    if (complexityErr) {
      return res.status(422).json({
        status: 'error',
        error: { code: 'WEAK_PASSWORD', message: complexityErr },
      });
    }

    const user = await userService.createUser({ username, email, password, role, permissions });
    res.status(201).json({ status: 'ok', data: user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'DUPLICATE_USER', message: 'Username or email already exists.' },
      });
    }
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'CREATE_ERROR', message: err.message },
    });
  }
});

/**
 * GET /api/v1/users/:id
 * Get a single user (admin only).
 */
router.get('/:id', async (req, res) => {
  try {
    const user = await userService.getUserById(req.params.id);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'FETCH_ERROR', message: err.message },
    });
  }
});

/**
 * PUT /api/v1/users/:id
 * Update user role, permissions, or active status (admin only).
 */
router.put('/:id', async (req, res) => {
  try {
    const user = await userService.updateUser(req.params.id, req.body);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'UPDATE_ERROR', message: err.message },
    });
  }
});

/**
 * DELETE /api/v1/users/:id
 * Delete a user (admin only).
 */
router.delete('/:id', async (req, res) => {
  try {
    await userService.deleteUser(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'DELETE_ERROR', message: err.message },
    });
  }
});

/**
 * PUT /api/v1/users/:id/password
 * Change a user's password (admin only — admin can reset any user's password).
 */
router.put('/:id/password', changePasswordRules, handleValidationErrors, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await userService.changePassword(req.params.id, currentPassword || '', newPassword);
    res.status(200).json({ status: 'ok', data: { message: 'Password updated. All sessions have been invalidated.' } });
  } catch (err) {
    res.status(err.status || 500).json({
      status: 'error',
      error: { code: err.code || 'PASSWORD_ERROR', message: err.message },
    });
  }
});

module.exports = router;

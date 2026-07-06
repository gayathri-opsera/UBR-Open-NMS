'use strict';

const { body, validationResult } = require('express-validator');

/**
 * Middleware: return 422 if any express-validator rules failed.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: 'error',
      error: { code: 'VALIDATION_ERROR', details: errors.array() },
    });
  }
  next();
}

const loginRules = [
  body('username').isString().notEmpty().trim().escape(),
  body('password').isString().notEmpty(),
];

const refreshRules = [
  body('refreshToken').isString().notEmpty(),
];

const createUserRules = [
  body('username').isString().notEmpty().trim().isLength({ min: 3, max: 64 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 12 }),
  body('role').optional().isIn(['admin', 'operator', 'user']),
];

const changePasswordRules = [
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isString().isLength({ min: 12 }),
];

module.exports = {
  handleValidationErrors,
  loginRules,
  refreshRules,
  createUserRules,
  changePasswordRules,
};

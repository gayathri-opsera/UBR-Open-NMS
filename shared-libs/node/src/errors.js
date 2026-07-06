'use strict';

/**
 * Standardized error response middleware and ApiError class.
 * All services must use {status:'error', error:{code, message}} format.
 */

class ApiError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }

  static notFound(resource = 'Resource') {
    return new ApiError('NOT_FOUND', `${resource} not found`, 404);
  }

  static forbidden(message = 'Access denied') {
    return new ApiError('FORBIDDEN', message, 403);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError('UNAUTHORIZED', message, 401);
  }

  static conflict(message) {
    return new ApiError('CONFLICT', message, 409);
  }

  static validation(message) {
    return new ApiError('VALIDATION_ERROR', message, 400);
  }

  static serviceUnavailable(message = 'Service temporarily unavailable') {
    return new ApiError('SERVICE_UNAVAILABLE', message, 503);
  }
}

/**
 * Express error handler middleware.
 * Converts ApiError and unexpected errors into the standard error response shape.
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  res.status(statusCode).json({
    status: 'error',
    error: { code, message },
  });
}

module.exports = { ApiError, errorHandler };

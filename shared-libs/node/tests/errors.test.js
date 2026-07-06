'use strict';

const { ApiError, errorHandler } = require('../src/errors');

describe('ApiError', () => {
  it('creates an error with code and statusCode', () => {
    const err = new ApiError('MY_CODE', 'my message', 422);
    expect(err.code).toBe('MY_CODE');
    expect(err.message).toBe('my message');
    expect(err.statusCode).toBe(422);
    expect(err).toBeInstanceOf(Error);
  });

  it('notFound factory returns 404 with NOT_FOUND code', () => {
    const err = ApiError.notFound('Device');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('Device');
  });

  it('forbidden factory returns 403', () => {
    expect(ApiError.forbidden().statusCode).toBe(403);
    expect(ApiError.forbidden().code).toBe('FORBIDDEN');
  });

  it('unauthorized factory returns 401', () => {
    expect(ApiError.unauthorized().statusCode).toBe(401);
  });

  it('conflict factory returns 409', () => {
    expect(ApiError.conflict('conflict').statusCode).toBe(409);
  });

  it('serviceUnavailable factory returns 503', () => {
    expect(ApiError.serviceUnavailable().statusCode).toBe(503);
  });
});

describe('errorHandler middleware', () => {
  function makeRes() {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    return res;
  }

  it('formats ApiError into standard error shape', () => {
    const err = new ApiError('NOT_FOUND', 'not found', 404);
    const res = makeRes();
    errorHandler(err, {}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'not found' },
    });
  });

  it('returns 500 INTERNAL_ERROR for unexpected errors', () => {
    const err = new Error('crash');
    const res = makeRes();
    errorHandler(err, {}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) })
    );
  });
});

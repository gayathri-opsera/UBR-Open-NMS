'use strict';

const { rateLimiter } = require('../../src/middleware/ratelimit.middleware');

jest.mock('../../src/config', () => ({
  rateLimit: { defaultWindowMs: 60000, defaultMax: 3 },
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

function makeRedis(count) {
  return {
    multi: () => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      pexpire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([null, null, count, null]),
    }),
  };
}

describe('ratelimit.middleware', () => {
  it('allows requests under limit', async () => {
    const redis = makeRedis(1);
    const middleware = rateLimiter(redis);
    const req = { user: { sub: 'user-001' }, headers: {} };
    const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 when limit exceeded', async () => {
    const redis = makeRedis(5);
    const middleware = rateLimiter(redis);
    const req = { user: { sub: 'user-001' }, headers: {} };
    const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }));
  });

  it('passes through when req.user is absent', async () => {
    const redis = makeRedis(0);
    const middleware = rateLimiter(redis);
    const req = { user: null };
    const res = {};
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fails open when Redis throws', async () => {
    const redis = { multi: () => ({ zremrangebyscore: jest.fn().mockReturnThis(), zadd: jest.fn().mockReturnThis(), zcard: jest.fn().mockReturnThis(), pexpire: jest.fn().mockReturnThis(), exec: jest.fn().mockRejectedValue(new Error('redis error')) }) };
    const middleware = rateLimiter(redis);
    const req = { user: { sub: 'user-001' }, headers: {} };
    const res = { set: jest.fn() };
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

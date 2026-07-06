'use strict';

const { correlationId } = require('../../src/middleware/correlation.middleware');

describe('correlation.middleware', () => {
  it('injects a new X-Correlation-ID when not present', () => {
    const req = { headers: {} };
    const res = { set: jest.fn() };
    const next = jest.fn();
    correlationId(req, res, next);
    expect(req.correlationId).toBeDefined();
    expect(typeof req.correlationId).toBe('string');
    expect(req.headers['x-correlation-id']).toBe(req.correlationId);
    expect(res.set).toHaveBeenCalledWith('X-Correlation-ID', req.correlationId);
    expect(next).toHaveBeenCalled();
  });

  it('preserves existing X-Correlation-ID from upstream', () => {
    const existing = 'existing-id-12345';
    const req = { headers: { 'x-correlation-id': existing } };
    const res = { set: jest.fn() };
    const next = jest.fn();
    correlationId(req, res, next);
    expect(req.correlationId).toBe(existing);
    expect(res.set).toHaveBeenCalledWith('X-Correlation-ID', existing);
  });
});

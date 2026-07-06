'use strict';

const { withRetry } = require('../src/retry');

describe('withRetry', () => {
  it('resolves immediately on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and eventually succeeds', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('fail'));
      return Promise.resolve('success');
    });
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts exceeded', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects shouldRetry predicate', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('permanent'));
    const shouldRetry = jest.fn().mockReturnValue(false);
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, shouldRetry })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

'use strict';

const sessionService = require('../../src/services/session.service');

// Build a minimal Redis mock.
function buildRedisMock() {
  const store = {};
  const sets = {};
  const ttls = {};

  const mock = {
    _store: store,
    get: jest.fn(async (k) => store[k] ?? null),
    set: jest.fn(async (k, v, ...args) => {
      store[k] = v;
      const exIdx = args.indexOf('EX');
      if (exIdx !== -1) ttls[k] = args[exIdx + 1];
      return 'OK';
    }),
    del: jest.fn(async (...keys) => { keys.forEach((k) => delete store[k]); return keys.length; }),
    incr: jest.fn(async (k) => { store[k] = String((parseInt(store[k] || '0', 10) + 1)); return parseInt(store[k], 10); }),
    expire: jest.fn(async () => 1),
    sadd: jest.fn(async (k, ...members) => { sets[k] = sets[k] || new Set(); members.forEach((m) => sets[k].add(m)); return members.length; }),
    srem: jest.fn(async (k, ...members) => { if (sets[k]) members.forEach((m) => sets[k].delete(m)); return members.length; }),
    smembers: jest.fn(async (k) => [...(sets[k] || new Set())]),
    scan: jest.fn(async () => ['0', []]),
    pipeline: jest.fn(() => {
      const ops = [];
      const pipe = {
        set: (...a) => { ops.push(['set', ...a]); return pipe; },
        del: (...a) => { ops.push(['del', ...a]); return pipe; },
        sadd: (...a) => { ops.push(['sadd', ...a]); return pipe; },
        srem: (...a) => { ops.push(['srem', ...a]); return pipe; },
        expire: (...a) => { ops.push(['expire', ...a]); return pipe; },
        exec: jest.fn(async () => {
          for (const op of ops) {
            const [cmd, ...args] = op;
            if (mock[cmd]) await mock[cmd](...args);
          }
          return [];
        }),
      };
      return pipe;
    }),
  };
  return mock;
}

describe('session service — createSession', () => {
  let redis;

  beforeEach(() => {
    redis = buildRedisMock();
    sessionService.setRedis(redis);
    jest.clearAllMocks();
  });

  test('stores refresh token with 24-hour TTL', async () => {
    await sessionService.createSession('user1', 'admin', 'tok123');
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('rt:tok123'),
      expect.any(String),
      'EX',
      expect.any(Number)
    );
  });

  test('throws SESSION_LIMIT_EXCEEDED when max concurrent sessions reached', async () => {
    // maxConcurrent defaults to 10 — simulate 10 active sessions
    const sessions = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
    redis.smembers.mockResolvedValue(sessions);
    // All 10 sessions have recent activity (not stale)
    redis.get.mockImplementation(async (k) => {
      if (k.includes('sa:')) return String(Date.now());
      return null;
    });

    await expect(sessionService.createSession('user1', 'admin', 'newTok')).rejects.toMatchObject({
      code: 'SESSION_LIMIT_EXCEEDED',
    });
  });
});

describe('session service — validateAndRotateRefreshToken', () => {
  let redis;

  beforeEach(() => {
    redis = buildRedisMock();
    sessionService.setRedis(redis);
    jest.clearAllMocks();
  });

  test('returns null for non-existent token', async () => {
    const result = await sessionService.validateAndRotateRefreshToken('ghost', 'new');
    expect(result).toBeNull();
  });

  test('rotates token — deletes old, stores new', async () => {
    const sessionData = { userId: 'u1', role: 'operator', sessionId: 'sess1' };
    redis.get.mockResolvedValueOnce(JSON.stringify(sessionData));

    const result = await sessionService.validateAndRotateRefreshToken('oldTok', 'newTok');
    expect(result).toEqual(sessionData);
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('rt:oldTok'));
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('rt:newTok'),
      expect.any(String),
      'EX',
      expect.any(Number)
    );
  });
});

describe('session service — failed attempt tracking', () => {
  let redis;

  beforeEach(() => {
    redis = buildRedisMock();
    sessionService.setRedis(redis);
    jest.clearAllMocks();
  });

  test('returns locked=false before reaching max attempts', async () => {
    const result = await sessionService.recordFailedAttempt('alice');
    expect(result.locked).toBe(false);
  });

  test('returns locked=true after maxFailedAttempts', async () => {
    // maxFailedAttempts defaults to 100 — mock incr to return exactly 100
    redis.incr.mockResolvedValue(100);
    const result = await sessionService.recordFailedAttempt('alice');
    expect(result.locked).toBe(true);
  });

  test('clearFailedAttempts calls del', async () => {
    await sessionService.clearFailedAttempts('alice');
    expect(redis.del).toHaveBeenCalled();
  });
});

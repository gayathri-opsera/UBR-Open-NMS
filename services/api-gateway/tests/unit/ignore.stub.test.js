'use strict';
/**
 * Unit tests for ignore.stub.js — discovery host suppress / un-suppress endpoints.
 *
 * Covers:
 *   GET    /api/v1/discovery/ignore          — list ignored IPs
 *   POST   /api/v1/discovery/ignore          — add IPs to ignore list
 *   DELETE /api/v1/discovery/ignore/:ip      — remove IP from ignore list
 *
 * MongoDB is fully mocked; no real database connection is made.
 * All jest.mock factories use ONLY inline values (no outer-scope references)
 * to avoid the jest factory-hoisting constraint.
 */

// ── Mock mongoose ─────────────────────────────────────────────────────────────
// NOTE: jest.mock is hoisted above variable declarations, so we cannot
// reference const/let defined in this file inside the factory. Instead,
// we store the test double on `global` so tests can replace it per-case.

global.__ignoreColMock = {
  find:       jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
  replaceOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  deleteOne:  jest.fn().mockResolvedValue({ deletedCount: 1 }),
};

jest.mock('mongoose', () => {
  const realMongoose = jest.requireActual('mongoose');
  return {
    ...realMongoose,
    createConnection: jest.fn().mockReturnValue({
      asPromise: jest.fn().mockResolvedValue({
        db: {
          collection: jest.fn().mockReturnValue(global.__ignoreColMock),
        },
      }),
    }),
    connection: {
      readyState: 1,
      db: {
        collection: jest.fn().mockReturnValue(global.__ignoreColMock),
      },
    },
  };
});

const { listIgnored, addIgnored, removeIgnored } = require('../../src/routes/ignore.stub');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    body: {},
    params: {},
    query: {},
    user: { username: 'admin' },
    ...overrides,
  };
}

// Short-hand to get the col mock
const col = () => global.__ignoreColMock;

beforeEach(() => {
  jest.clearAllMocks();
  col().find.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
  col().replaceOne.mockResolvedValue({ acknowledged: true });
  col().deleteOne.mockResolvedValue({ deletedCount: 1 });
});

// ── GET /api/v1/discovery/ignore ──────────────────────────────────────────────

describe('listIgnored', () => {
  it('returns empty array when no IPs are ignored', async () => {
    col().find.mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    const res = mockRes();
    await listIgnored(mockReq(), res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });

  it('returns list of ignored IPs with metadata', async () => {
    const docs = [
      { ip: '10.0.0.1', ignoredAt: '2026-09-14T10:00:00Z', ignoredBy: 'admin', reason: 'test' },
      { ip: '10.0.0.2', ignoredAt: '2026-09-14T11:00:00Z', ignoredBy: 'operator', reason: '' },
    ];
    col().find.mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) });
    const res = mockRes();
    await listIgnored(mockReq(), res);

    expect(res._body).toHaveLength(2);
    expect(res._body[0].ip).toBe('10.0.0.1');
    expect(res._body[1].ip).toBe('10.0.0.2');
  });
});

// ── POST /api/v1/discovery/ignore ─────────────────────────────────────────────

describe('addIgnored', () => {
  it('returns 400 when no ips provided', async () => {
    const res = mockRes();
    await addIgnored(mockReq({ body: {} }), res);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('BAD_REQUEST');
  });

  it('upserts a single IP when body.ip is provided', async () => {
    const res = mockRes();
    await addIgnored(mockReq({ body: { ip: '10.0.0.1' } }), res);

    expect(col().replaceOne).toHaveBeenCalledWith(
      { ip: '10.0.0.1' },
      expect.objectContaining({ ip: '10.0.0.1' }),
      { upsert: true },
    );
    expect(res._status).toBe(201);
    expect(res._body.ignored).toEqual(['10.0.0.1']);
  });

  it('upserts multiple IPs when body.ips array is provided', async () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const res = mockRes();
    await addIgnored(mockReq({ body: { ips, reason: 'not managed' } }), res);

    expect(col().replaceOne).toHaveBeenCalledTimes(3);
    expect(res._status).toBe(201);
    expect(res._body.ignored).toEqual(ips);
  });

  it('is idempotent — calling twice does not throw', async () => {
    const req = mockReq({ body: { ips: ['10.0.0.9'] } });
    await addIgnored(req, mockRes());
    await addIgnored(req, mockRes());

    expect(col().replaceOne).toHaveBeenCalledTimes(2);
  });

  it('stores reason and ignoredBy from request user', async () => {
    const res = mockRes();
    await addIgnored(
      mockReq({ body: { ips: ['10.0.0.4'], reason: 'test device' }, user: { username: 'telecom-admin' } }),
      res,
    );

    const docArg = col().replaceOne.mock.calls[0][1];
    expect(docArg.reason).toBe('test device');
    expect(docArg.ignoredBy).toBe('telecom-admin');
  });
});

// ── DELETE /api/v1/discovery/ignore/:ip ──────────────────────────────────────

describe('removeIgnored', () => {
  it('deletes the IP and returns success', async () => {
    const res = mockRes();
    await removeIgnored(mockReq({ params: { ip: '10.0.0.1' } }), res);

    expect(col().deleteOne).toHaveBeenCalledWith({ ip: '10.0.0.1' });
    expect(res._body).toMatchObject({ unignored: '10.0.0.1', wasPresent: true });
  });

  it('returns wasPresent: false when IP was not in the ignore list (idempotent)', async () => {
    col().deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    const res = mockRes();
    await removeIgnored(mockReq({ params: { ip: '10.0.0.99' } }), res);

    expect(res._status).toBe(200);
    expect(res._body.wasPresent).toBe(false);
  });

  it('returns 400 when ip param is missing', async () => {
    const res = mockRes();
    await removeIgnored(mockReq({ params: {} }), res);

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('BAD_REQUEST');
  });
});

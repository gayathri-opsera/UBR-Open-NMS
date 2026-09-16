import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient } from './client';
import {
  createDiscoveryRun,
  getDiscoveryRun,
  getDiscoveryRunResults,
  parseScopeInput,
} from './discovery.api';
import type {
  DiscoveryRunResponse,
  DiscoveryRunDetail,
  DiscoveryResult,
  SnmpDiscoveryRunRequest,
} from './discovery.api';
import {
  mockDiscoveryRunResponse,
  mockDiscoveryRunCompleted,
  mockDiscoveryResults,
} from './mocks/discovery.mocks';

// Mock the shared axios instance so no real HTTP is made.
vi.mock('./client', () => ({
  apiClient: {
    post: vi.fn(),
    get:  vi.fn(),
  },
}));

const mockedPost = vi.mocked(apiClient.post);
const mockedGet  = vi.mocked(apiClient.get);

beforeEach(() => vi.clearAllMocks());

// ── parseScopeInput ───────────────────────────────────────────────────────────

describe('parseScopeInput', () => {
  it('parses a CIDR entry', () => {
    const result = parseScopeInput('192.168.1.0/24');
    expect(result).toEqual([{ type: 'CIDR', value: '192.168.1.0/24' }]);
  });

  it('parses a single IPv4 address', () => {
    const result = parseScopeInput('10.0.0.1');
    expect(result).toEqual([{ type: 'IP', value: '10.0.0.1' }]);
  });

  it('parses an IP range as CIDR type with range label', () => {
    const result = parseScopeInput('10.0.0.1-10.0.0.50');
    expect(result).toEqual([
      { type: 'CIDR', value: '10.0.0.1-10.0.0.50', label: 'range:10.0.0.1-10.0.0.50' },
    ]);
  });

  it('parses a hostname as SEED type', () => {
    const result = parseScopeInput('router.example.com');
    expect(result).toEqual([{ type: 'SEED', value: 'router.example.com' }]);
  });

  it('parses a comma-separated mixed list', () => {
    const result = parseScopeInput('192.168.0.0/24, 10.0.0.1, seed.host');
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: 'CIDR', value: '192.168.0.0/24' });
    expect(result[1]).toMatchObject({ type: 'IP',   value: '10.0.0.1' });
    expect(result[2]).toMatchObject({ type: 'SEED', value: 'seed.host' });
  });

  it('ignores blank and whitespace-only entries', () => {
    const result = parseScopeInput('  ,   , 10.0.0.1,  ');
    expect(result).toEqual([{ type: 'IP', value: '10.0.0.1' }]);
  });

  it('returns empty array for blank input', () => {
    expect(parseScopeInput('')).toEqual([]);
    expect(parseScopeInput('   ')).toEqual([]);
  });
});

// ── createDiscoveryRun ────────────────────────────────────────────────────────

describe('createDiscoveryRun', () => {
  it('posts the request and returns the run response', async () => {
    mockedPost.mockResolvedValueOnce({ data: mockDiscoveryRunResponse });

    const req: SnmpDiscoveryRunRequest = {
      scope:          [{ type: 'CIDR', value: '10.0.0.0/24' }],
      protocol:       'SNMP_V2C',
      credentialId:   'cred-001',
      timeoutSeconds: 5,
      retries:        2,
    };

    const result: DiscoveryRunResponse = await createDiscoveryRun(req);

    expect(mockedPost).toHaveBeenCalledOnce();
    expect(mockedPost).toHaveBeenCalledWith('/discovery/runs', req);
    expect(result.runId).toBe('run-test-001');
    expect(result.status).toBe('CREATED');
  });

  it('propagates HTTP 400 scope validation errors', async () => {
    const validationError = {
      response: { status: 400, data: { reason: 'INVALID_CIDR', message: 'Bad CIDR' } },
    };
    mockedPost.mockRejectedValueOnce(validationError);

    await expect(
      createDiscoveryRun({ scope: [{ type: 'CIDR', value: 'not-a-cidr' }] }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('propagates HTTP 403 insufficient role errors', async () => {
    mockedPost.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(
      createDiscoveryRun({ scope: [{ type: 'IP', value: '10.0.0.1' }] }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('propagates 5xx server errors', async () => {
    mockedPost.mockRejectedValueOnce({ response: { status: 500 } });
    await expect(
      createDiscoveryRun({ scope: [] }),
    ).rejects.toMatchObject({ response: { status: 500 } });
  });
});

// ── getDiscoveryRun ───────────────────────────────────────────────────────────

describe('getDiscoveryRun', () => {
  it('fetches run detail including sweep progress', async () => {
    mockedGet.mockResolvedValueOnce({ data: mockDiscoveryRunCompleted });

    const result: DiscoveryRunDetail = await getDiscoveryRun('run-test-003');

    expect(mockedGet).toHaveBeenCalledWith('/discovery/runs/run-test-003');
    expect(result.status).toBe('COMPLETED');
    expect(result.sweep?.reachableHosts).toBe(18);
    expect(result.snmpSuccessCount).toBe(15);
  });

  it('propagates 404 when run is not found', async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(getDiscoveryRun('missing-run')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

// ── getDiscoveryRunResults ────────────────────────────────────────────────────

describe('getDiscoveryRunResults', () => {
  it('returns an array when backend returns plain array', async () => {
    mockedGet.mockResolvedValueOnce({ data: mockDiscoveryResults });

    const results: DiscoveryResult[] = await getDiscoveryRunResults('run-test-003');

    expect(mockedGet).toHaveBeenCalledWith('/discovery/runs/run-test-003/results');
    expect(results).toHaveLength(mockDiscoveryResults.length);
    expect(results[0].ip).toBe('192.168.1.10');
    expect(results[0].classificationStatus).toBe('RECOGNISED');
  });

  it('unwraps {results:[]} envelope from backend', async () => {
    mockedGet.mockResolvedValueOnce({ data: { results: mockDiscoveryResults } });

    const results = await getDiscoveryRunResults('run-test-003');
    expect(results).toHaveLength(mockDiscoveryResults.length);
  });

  it('returns empty array when backend returns unexpected shape', async () => {
    mockedGet.mockResolvedValueOnce({ data: null });
    const results = await getDiscoveryRunResults('run-test-003');
    expect(results).toEqual([]);
  });

  it('propagates 401 Unauthorized', async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(getDiscoveryRunResults('run-x')).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('propagates 403 Forbidden', async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(getDiscoveryRunResults('run-x')).rejects.toMatchObject({
      response: { status: 403 },
    });
  });

  it('propagates 5xx server error', async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 500 } });
    await expect(getDiscoveryRunResults('run-x')).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it('handles malformed JSON gracefully (empty array)', async () => {
    // Backend 200 OK but the data field is an unexpected shape (no array, no .results)
    mockedGet.mockResolvedValueOnce({ data: {} });
    const results = await getDiscoveryRunResults('run-x');
    expect(results).toEqual([]);
  });
});

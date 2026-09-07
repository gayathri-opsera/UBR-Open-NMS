/**
 * Tests for WO-050: Version Device Configuration History
 *
 * Covers: paginated history type contract, API endpoint routing, cursor handling,
 * limit parameters, empty-history response shape, sanitized diff fields,
 * rollback eligibility, and error propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigHistoryPage, ConfigVersionRecord, ConfigDiffEntry } from '../../api/config.api';

// ── Type contract ─────────────────────────────────────────────────────────────

describe('ConfigVersionRecord type contract', () => {
  it('requires versionId, versionNumber, status, and actor', () => {
    const record: ConfigVersionRecord = {
      versionId: 'v-abc',
      versionNumber: 1,
      status: 'APPLIED',
      jobId: 'job-1',
      templateId: 'tmpl-1',
      actor: 'eng-jsmith',
      approvalReference: null,
      deliveryChannel: 'CLI_PROTOCOL',
      appliedAt: '2026-09-07T09:00:00Z',
      attemptedAt: null,
      diffSummary: 'Changed 2 fields: ssid24, txPower',
      sanitizedDiff: [],
      rollbackEligible: true,
      failureReason: null,
      renderedHash: 'abc123',
    };
    expect(record.versionId).toBe('v-abc');
    expect(record.status).toBe('APPLIED');
    expect(record.rollbackEligible).toBe(true);
  });

  it('allows FAILED status with failureReason', () => {
    const record: ConfigVersionRecord = {
      versionId: 'v-fail',
      versionNumber: 2,
      status: 'FAILED',
      jobId: 'job-2',
      templateId: null,
      actor: 'system',
      approvalReference: null,
      deliveryChannel: 'UBR_REALTIME',
      appliedAt: null,
      attemptedAt: '2026-09-07T09:05:00Z',
      diffSummary: 'Delivery attempt failed',
      sanitizedDiff: [],
      rollbackEligible: false,
      failureReason: 'Kafka publish timeout',
      renderedHash: null,
    };
    expect(record.status).toBe('FAILED');
    expect(record.failureReason).toContain('Kafka');
    expect(record.rollbackEligible).toBe(false);
    expect(record.appliedAt).toBeNull();
    expect(record.attemptedAt).toBeTruthy();
  });

  it('sanitizedDiff contains field, from, to entries', () => {
    const entry: ConfigDiffEntry = { field: 'ssid24', from: 'Old', to: 'New' };
    expect(entry.field).toBe('ssid24');
    expect(entry.from).toBe('Old');
    expect(entry.to).toBe('New');
  });

  it('sanitizedDiff from/to can be REDACTED_SECRET for secrets', () => {
    const entry: ConfigDiffEntry = {
      field: 'password',
      from: 'REDACTED_SECRET',
      to: 'REDACTED_SECRET',
    };
    expect(entry.from).toBe('REDACTED_SECRET');
    expect(entry.to).toBe('REDACTED_SECRET');
  });
});

describe('ConfigHistoryPage type contract', () => {
  it('requires deviceId, items, nextCursor, and totalKnown', () => {
    const page: ConfigHistoryPage = {
      deviceId: 'dev-1',
      items: [],
      nextCursor: null,
      totalKnown: 0,
      page: 0,
      limit: 50,
    };
    expect(page.deviceId).toBe('dev-1');
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('nextCursor is a number when more pages exist', () => {
    const page: ConfigHistoryPage = {
      deviceId: 'dev-1',
      items: [],
      nextCursor: 1,
      totalKnown: 100,
      page: 0,
      limit: 50,
    };
    expect(page.nextCursor).toBe(1);
    expect(page.totalKnown).toBe(100);
  });
});

// ── API client (mocked) ───────────────────────────────────────────────────────

vi.mock('../../api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { apiClient } from '../../api/client';
import { getVersionHistoryPaged } from '../../api/config.api';

const mockGet = vi.mocked(apiClient.get);

const EMPTY_PAGE: ConfigHistoryPage = {
  deviceId: 'dev-1',
  items: [],
  nextCursor: null,
  totalKnown: 0,
  page: 0,
  limit: 50,
};

const SINGLE_PAGE: ConfigHistoryPage = {
  deviceId: 'dev-1',
  items: [
    {
      versionId: 'v-1',
      versionNumber: 5,
      status: 'APPLIED',
      jobId: 'job-abc',
      templateId: 'tmpl-1',
      actor: 'eng-jsmith',
      approvalReference: 'CHG-9999',
      deliveryChannel: 'CLI_PROTOCOL',
      appliedAt: '2026-09-07T09:00:00Z',
      attemptedAt: null,
      diffSummary: 'Changed 2 fields: ssid24, txPower',
      sanitizedDiff: [
        { field: 'ssid24', from: 'Old', to: 'New' },
        { field: 'txPower', from: 20, to: 25 },
      ],
      rollbackEligible: true,
      failureReason: null,
      renderedHash: 'abc123def456',
    },
  ],
  nextCursor: null,
  totalKnown: 1,
  page: 0,
  limit: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ data: SINGLE_PAGE });
});

describe('getVersionHistoryPaged — endpoint routing', () => {
  it('calls GET /config/history/{deviceId}', async () => {
    await getVersionHistoryPaged('dev-1');
    expect(mockGet).toHaveBeenCalledWith(
      '/config/history/dev-1',
      expect.objectContaining({ params: expect.anything() }),
    );
  });

  it('returns the paginated page response', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.deviceId).toBe('dev-1');
    expect(result.items).toHaveLength(1);
  });
});

describe('getVersionHistoryPaged — query parameters', () => {
  it('uses default limit of 50', async () => {
    await getVersionHistoryPaged('dev-1');
    const params = (mockGet.mock.calls[0][1] as { params: Record<string, unknown> }).params;
    expect(params.limit).toBe(50);
  });

  it('uses default cursor of 0', async () => {
    await getVersionHistoryPaged('dev-1');
    const params = (mockGet.mock.calls[0][1] as { params: Record<string, unknown> }).params;
    expect(params.cursor).toBe(0);
  });

  it('passes custom limit', async () => {
    await getVersionHistoryPaged('dev-1', 25);
    const params = (mockGet.mock.calls[0][1] as { params: Record<string, unknown> }).params;
    expect(params.limit).toBe(25);
  });

  it('passes custom cursor for pagination', async () => {
    await getVersionHistoryPaged('dev-1', 50, 2);
    const params = (mockGet.mock.calls[0][1] as { params: Record<string, unknown> }).params;
    expect(params.cursor).toBe(2);
  });
});

describe('getVersionHistoryPaged — empty history (AC3)', () => {
  it('returns empty items array for device with no history, not 404', async () => {
    mockGet.mockResolvedValue({ data: EMPTY_PAGE });
    const result = await getVersionHistoryPaged('dev-new');
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(result.totalKnown).toBe(0);
  });
});

describe('getVersionHistoryPaged — sanitized diff content (AC4)', () => {
  it('items contain sanitizedDiff with field, from, to', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    const diff = result.items[0].sanitizedDiff;
    expect(diff).toHaveLength(2);
    expect(diff[0].field).toBe('ssid24');
    expect(diff[0].from).toBe('Old');
    expect(diff[0].to).toBe('New');
  });

  it('items contain diffSummary', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.items[0].diffSummary).toContain('ssid24');
  });

  it('items contain renderedHash', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.items[0].renderedHash).toBeTruthy();
  });

  it('items contain rollbackEligible flag', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.items[0].rollbackEligible).toBe(true);
  });
});

describe('getVersionHistoryPaged — next cursor for multi-page (AC3)', () => {
  it('nextCursor is set when more pages exist', async () => {
    mockGet.mockResolvedValue({
      data: { ...SINGLE_PAGE, nextCursor: 1, totalKnown: 100 },
    });
    const result = await getVersionHistoryPaged('dev-1', 50, 0);
    expect(result.nextCursor).toBe(1);
    expect(result.totalKnown).toBe(100);
  });
});

describe('getVersionHistoryPaged — error propagation', () => {
  it('throws when server returns 400 invalid params', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Bad Request'), { response: { status: 400 } }));
    await expect(getVersionHistoryPaged('dev-1', -1)).rejects.toThrow();
  });

  it('throws when server returns 500 DB error', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Internal Server Error'), { response: { status: 500 } }));
    await expect(getVersionHistoryPaged('dev-1')).rejects.toThrow();
  });
});

describe('getVersionHistoryPaged — approval reference (AC1)', () => {
  it('version record carries approval reference', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.items[0].approvalReference).toBe('CHG-9999');
  });
});

describe('getVersionHistoryPaged — delivery channel (AC1)', () => {
  it('version record carries delivery channel', async () => {
    const result = await getVersionHistoryPaged('dev-1');
    expect(result.items[0].deliveryChannel).toBe('CLI_PROTOCOL');
  });
});

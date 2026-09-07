/**
 * Tests for WO-045: Confirm Configuration Target Execution
 *
 * Covers: request payload construction, actor role header injection,
 * endpoint routing, error propagation, idempotency key handling,
 * warning acknowledgment, and type contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfirmExecutionRequest, ConfirmExecutionResponse } from '../../api/config.api';

// ── Type contract ─────────────────────────────────────────────────────────────

describe('ConfirmExecutionRequest type contract', () => {
  it('requires previewId, actionType, and expectedTargetCount', () => {
    const req: ConfirmExecutionRequest = {
      previewId: 'prev-123',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 5,
    };
    expect(req.previewId).toBe('prev-123');
    expect(req.actionType).toBe('CONFIG_PUSH');
    expect(req.expectedTargetCount).toBe(5);
  });

  it('allows optional templateId', () => {
    const req: ConfirmExecutionRequest = {
      previewId: 'prev-123',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 5,
      templateId: 'tmpl-xyz',
    };
    expect(req.templateId).toBe('tmpl-xyz');
  });

  it('allows optional approvalReference', () => {
    const req: ConfirmExecutionRequest = {
      previewId: 'prev-123',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      approvalReference: 'CHG-9999',
    };
    expect(req.approvalReference).toBe('CHG-9999');
  });

  it('allows optional idempotencyKey', () => {
    const req: ConfirmExecutionRequest = {
      previewId: 'prev-123',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      idempotencyKey: 'uuid-abc-def',
    };
    expect(req.idempotencyKey).toBe('uuid-abc-def');
  });

  it('allows optional acceptWarnings flag', () => {
    const req: ConfirmExecutionRequest = {
      previewId: 'prev-123',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      acceptWarnings: true,
    };
    expect(req.acceptWarnings).toBe(true);
  });
});

describe('ConfirmExecutionResponse type contract', () => {
  it('contains all required tracking fields', () => {
    const res: ConfirmExecutionResponse = {
      jobId: 'job-abc',
      status: 'ACCEPTED',
      acceptedAt: new Date().toISOString(),
      acceptedBy: 'eng-jsmith',
      targetCount: 5,
      previewId: 'prev-123',
      trackingUrl: '/api/v1/config/jobs/job-abc/status',
    };
    expect(res.jobId).toBe('job-abc');
    expect(res.status).toBe('ACCEPTED');
    expect(res.previewId).toBe('prev-123');
    expect(res.trackingUrl).toContain('job-abc');
  });

  it('allows optional note for idempotent responses', () => {
    const res: ConfirmExecutionResponse = {
      jobId: 'job-abc',
      status: 'ACCEPTED',
      acceptedAt: new Date().toISOString(),
      acceptedBy: 'eng-jsmith',
      targetCount: 5,
      previewId: 'prev-123',
      trackingUrl: '/api/v1/config/jobs/job-abc/status',
      note: 'Idempotent — returning existing job',
    };
    expect(res.note).toContain('Idempotent');
  });
});

// ── API client (mocked) ───────────────────────────────────────────────────────

vi.mock('../../api/client', () => ({
  apiClient: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

import { apiClient } from '../../api/client';
import { confirmConfigExecution } from '../../api/config.api';

const mockPost = vi.mocked(apiClient.post);

const validResponse: ConfirmExecutionResponse = {
  jobId: 'job-001',
  status: 'ACCEPTED',
  acceptedAt: '2026-09-07T09:00:00Z',
  acceptedBy: 'operator',
  targetCount: 3,
  previewId: 'prev-abc',
  trackingUrl: '/api/v1/config/jobs/job-001/status',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ data: validResponse });
});

describe('confirmConfigExecution — endpoint routing', () => {
  it('calls POST /config/actions/confirm', async () => {
    await confirmConfigExecution({ previewId: 'prev-abc', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 });
    expect(mockPost).toHaveBeenCalledWith(
      '/config/actions/confirm',
      expect.objectContaining({ previewId: 'prev-abc' }),
      expect.anything(),
    );
  });

  it('returns the job response from the server', async () => {
    const result = await confirmConfigExecution({
      previewId: 'prev-abc',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
    });
    expect(result.jobId).toBe('job-001');
    expect(result.status).toBe('ACCEPTED');
  });
});

describe('confirmConfigExecution — actor role header', () => {
  it('defaults actor role to network_engineer', async () => {
    await confirmConfigExecution({ previewId: 'prev-abc', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 });
    const callArgs = mockPost.mock.calls[0];
    const options = callArgs[2] as { headers: Record<string, string> };
    expect(options.headers['X-Actor-Role']).toBe('network_engineer');
  });

  it('passes custom actor role when provided', async () => {
    await confirmConfigExecution(
      { previewId: 'prev-abc', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 },
      'admin',
    );
    const callArgs = mockPost.mock.calls[0];
    const options = callArgs[2] as { headers: Record<string, string> };
    expect(options.headers['X-Actor-Role']).toBe('admin');
  });

  it('sets X-Actor header', async () => {
    await confirmConfigExecution({ previewId: 'prev-abc', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 });
    const callArgs = mockPost.mock.calls[0];
    const options = callArgs[2] as { headers: Record<string, string> };
    expect(options.headers['X-Actor']).toBeDefined();
  });
});

describe('confirmConfigExecution — request payload', () => {
  it('passes previewId in request body', async () => {
    await confirmConfigExecution({ previewId: 'prev-xyz', actionType: 'CONFIG_PUSH', expectedTargetCount: 10 });
    const body = mockPost.mock.calls[0][1] as ConfirmExecutionRequest;
    expect(body.previewId).toBe('prev-xyz');
  });

  it('passes expectedTargetCount in request body', async () => {
    await confirmConfigExecution({ previewId: 'prev-xyz', actionType: 'CONFIG_PUSH', expectedTargetCount: 42 });
    const body = mockPost.mock.calls[0][1] as ConfirmExecutionRequest;
    expect(body.expectedTargetCount).toBe(42);
  });

  it('passes approvalReference when provided', async () => {
    await confirmConfigExecution({
      previewId: 'prev-xyz',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      approvalReference: 'JIRA-1234',
    });
    const body = mockPost.mock.calls[0][1] as ConfirmExecutionRequest;
    expect(body.approvalReference).toBe('JIRA-1234');
  });

  it('passes idempotencyKey when provided', async () => {
    await confirmConfigExecution({
      previewId: 'prev-xyz',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      idempotencyKey: 'key-unique-123',
    });
    const body = mockPost.mock.calls[0][1] as ConfirmExecutionRequest;
    expect(body.idempotencyKey).toBe('key-unique-123');
  });

  it('passes acceptWarnings=true when operator acknowledges warnings', async () => {
    await confirmConfigExecution({
      previewId: 'prev-xyz',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      acceptWarnings: true,
    });
    const body = mockPost.mock.calls[0][1] as ConfirmExecutionRequest;
    expect(body.acceptWarnings).toBe(true);
  });
});

describe('confirmConfigExecution — error propagation', () => {
  it('throws when server returns 409 STALE', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Conflict'), { response: { status: 409, data: { reason: 'PREVIEW_EXPIRED' } } }));
    await expect(
      confirmConfigExecution({ previewId: 'stale', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 })
    ).rejects.toThrow();
  });

  it('throws when server returns 403 UNAUTHORIZED', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    await expect(
      confirmConfigExecution({ previewId: 'prev', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 })
    ).rejects.toThrow();
  });

  it('throws when server returns 404 PREVIEW_NOT_FOUND', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    await expect(
      confirmConfigExecution({ previewId: 'not-found', actionType: 'CONFIG_PUSH', expectedTargetCount: 3 })
    ).rejects.toThrow();
  });

  it('throws when server returns 409 TARGET_COUNT_MISMATCH', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Conflict'), { response: { status: 409, data: { reason: 'TARGET_COUNT_MISMATCH' } } }));
    await expect(
      confirmConfigExecution({ previewId: 'prev', actionType: 'CONFIG_PUSH', expectedTargetCount: 5 })
    ).rejects.toThrow();
  });
});

describe('confirmConfigExecution — idempotent responses', () => {
  it('returns existing job for duplicate idempotency key', async () => {
    const idempotentResponse: ConfirmExecutionResponse = {
      ...validResponse,
      note: 'Idempotent — returning existing job',
    };
    mockPost.mockResolvedValue({ data: idempotentResponse });

    const result = await confirmConfigExecution({
      previewId: 'prev-abc',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
      idempotencyKey: 'dup-key',
    });

    expect(result.note).toContain('Idempotent');
    expect(result.jobId).toBe('job-001');
  });
});

describe('confirmConfigExecution — tracking URL', () => {
  it('response contains trackingUrl for job polling', async () => {
    const result = await confirmConfigExecution({
      previewId: 'prev-abc',
      actionType: 'CONFIG_PUSH',
      expectedTargetCount: 3,
    });
    expect(result.trackingUrl).toBeTruthy();
    expect(result.trackingUrl).toContain(result.jobId);
  });
});

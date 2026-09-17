import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient } from './client';
import {
  listProductDefinitions,
  listProductDefinitionVersions,
  getProductDefinitionValidationReport,
  stageProductDefinitionVersion,
  activateProductDefinitionVersion,
  rollbackProductDefinition,
  extractApiError,
  generateIdempotencyKey,
} from './productDefinitions.api';
import {
  mockDefinitionSummaries,
  mockVersionDraft,
  mockVersionStaged,
  mockVersionActive,
  mockValidValidationReport,
  mockStageResult,
  mockActivationResult,
  mockRollbackResult,
  mockTransitionConflictError,
} from './mocks/productDefinitions.mocks';

// Mock the shared Axios instance — no real HTTP calls
vi.mock('./client', () => ({
  apiClient: {
    get:    vi.fn(),
    post:   vi.fn(),
    put:    vi.fn(),
    delete: vi.fn(),
  },
}));

const mockedGet  = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);
const mockedPut  = vi.mocked(apiClient.put);

beforeEach(() => vi.clearAllMocks());

// ── listProductDefinitions ────────────────────────────────────────────────────

describe('listProductDefinitions', () => {
  it('returns an array when backend returns array directly', async () => {
    mockedGet.mockResolvedValueOnce({ data: mockDefinitionSummaries });
    const result = await listProductDefinitions();
    expect(result).toEqual(mockDefinitionSummaries);
    expect(mockedGet).toHaveBeenCalledWith('/framework/product-definitions');
  });

  it('returns an array when backend wraps in { definitions: [...] }', async () => {
    mockedGet.mockResolvedValueOnce({ data: { definitions: mockDefinitionSummaries } });
    const result = await listProductDefinitions();
    expect(result).toEqual(mockDefinitionSummaries);
  });

  it('returns empty array when backend returns unexpected shape', async () => {
    mockedGet.mockResolvedValueOnce({ data: null });
    const result = await listProductDefinitions();
    expect(result).toEqual([]);
  });

  it('throws FrameworkApiError on HTTP 403', async () => {
    const axiosError = { response: { status: 403, data: null }, message: 'Request failed with status code 403' };
    mockedGet.mockRejectedValueOnce(axiosError);
    await expect(listProductDefinitions()).rejects.toMatchObject({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});

// ── listProductDefinitionVersions ─────────────────────────────────────────────

describe('listProductDefinitionVersions', () => {
  it('returns versions from the correct endpoint', async () => {
    const versions = [mockVersionDraft, mockVersionStaged, mockVersionActive];
    mockedGet.mockResolvedValueOnce({ data: versions });
    const result = await listProductDefinitionVersions('def-001');
    expect(result).toEqual(versions);
    expect(mockedGet).toHaveBeenCalledWith('/framework/product-definitions/def-001/versions');
  });

  it('normalises { versions: [...] } envelope', async () => {
    mockedGet.mockResolvedValueOnce({ data: { versions: [mockVersionDraft] } });
    const result = await listProductDefinitionVersions('def-001');
    expect(result).toHaveLength(1);
    expect(result[0].versionId).toBe('1.0.0');
  });
});

// ── getProductDefinitionValidationReport ──────────────────────────────────────

describe('getProductDefinitionValidationReport', () => {
  it('fetches report from the correct endpoint', async () => {
    mockedGet.mockResolvedValueOnce({ data: mockValidValidationReport });
    const result = await getProductDefinitionValidationReport('def-002', '1.0.0');
    expect(result).toEqual(mockValidValidationReport);
    expect(mockedGet).toHaveBeenCalledWith(
      '/framework/product-definitions/def-002/versions/1.0.0/validation-report',
    );
  });

  it('throws FrameworkApiError on 404', async () => {
    const axiosError = { response: { status: 404, data: null }, message: 'Not found' };
    mockedGet.mockRejectedValueOnce(axiosError);
    await expect(getProductDefinitionValidationReport('def-999', '0.0.0')).rejects.toMatchObject({
      status: 'error',
      error: { code: 'NOT_FOUND' },
    });
  });
});

// ── stageProductDefinitionVersion ────────────────────────────────────────────

describe('stageProductDefinitionVersion', () => {
  it('calls PUT /stage and returns the result', async () => {
    mockedPut.mockResolvedValueOnce({ data: mockStageResult });
    const result = await stageProductDefinitionVersion('def-001', '2.2.0');
    expect(result).toEqual(mockStageResult);
    expect(mockedPut).toHaveBeenCalledWith(
      '/framework/product-definitions/def-001/versions/2.2.0/stage',
    );
  });

  it('throws structured error on INVALID_LIFECYCLE_TRANSITION (409)', async () => {
    const axiosError = {
      response: { status: 409, data: mockTransitionConflictError },
      message:  'Request failed with status code 409',
    };
    mockedPut.mockRejectedValueOnce(axiosError);
    await expect(stageProductDefinitionVersion('def-001', '1.0.0')).rejects.toMatchObject({
      status: 'error',
      error: {
        code:    'INVALID_LIFECYCLE_TRANSITION',
        message: expect.stringContaining('DRAFT'),
      },
    });
  });
});

// ── activateProductDefinitionVersion ─────────────────────────────────────────

describe('activateProductDefinitionVersion', () => {
  it('passes idempotencyKey in request body', async () => {
    mockedPut.mockResolvedValueOnce({ data: mockActivationResult });
    await activateProductDefinitionVersion('def-001', '2.2.0', 'idem-key-123');
    expect(mockedPut).toHaveBeenCalledWith(
      '/framework/product-definitions/def-001/versions/2.2.0/activate',
      { idempotencyKey: 'idem-key-123' },
    );
  });

  it('returns activation result with registryVersion', async () => {
    mockedPut.mockResolvedValueOnce({ data: mockActivationResult });
    const result = await activateProductDefinitionVersion('def-001', '2.2.0', 'idem-key-123');
    expect(result.registryVersion).toBe(8);
    expect(result.outcome).toBe('ACTIVATED');
  });
});

// ── rollbackProductDefinition ─────────────────────────────────────────────────

describe('rollbackProductDefinition', () => {
  it('calls PUT /rollback with targetVersionId and reason', async () => {
    mockedPut.mockResolvedValueOnce({ data: mockRollbackResult });
    await rollbackProductDefinition('def-001', '2.0.0', 'Regression in 2.1.0');
    expect(mockedPut).toHaveBeenCalledWith(
      '/framework/product-definitions/def-001/rollback',
      { targetVersionId: '2.0.0', reason: 'Regression in 2.1.0' },
    );
  });

  it('returns rollback result', async () => {
    mockedPut.mockResolvedValueOnce({ data: mockRollbackResult });
    const result = await rollbackProductDefinition('def-001', '2.0.0', 'Reason');
    expect(result.outcome).toBe('ROLLED_BACK');
  });
});

// ── extractApiError ───────────────────────────────────────────────────────────

describe('extractApiError', () => {
  it('extracts a framework envelope error', () => {
    const axiosError = { response: { status: 409, data: mockTransitionConflictError } };
    const result = extractApiError(axiosError);
    expect(result).toEqual(mockTransitionConflictError);
  });

  it('falls back to CONFLICT code on HTTP 409 without envelope', () => {
    const axiosError = { response: { status: 409, data: null }, message: 'Conflict' };
    const result = extractApiError(axiosError);
    expect(result.error.code).toBe('CONFLICT');
  });

  it('falls back to NOT_FOUND code on HTTP 404', () => {
    const axiosError = { response: { status: 404, data: null }, message: 'Not found' };
    const result = extractApiError(axiosError);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('falls back to INTERNAL_ERROR for other status codes', () => {
    const axiosError = { response: { status: 500, data: null }, message: 'Server error' };
    const result = extractApiError(axiosError);
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});

// ── generateIdempotencyKey ────────────────────────────────────────────────────

describe('generateIdempotencyKey', () => {
  it('generates a valid UUID v4 string', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('generates unique keys on each call', () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });
});

/**
 * Product Definition Control Plane API wrapper (WO-003).
 *
 * All functions call the versioned framework endpoints through the shared
 * {@link apiClient} instance, which handles auth token attachment and 401
 * redirect automatically.  Response envelopes follow the existing pattern:
 * success responses return data directly; error responses are re-thrown as
 * {@link FrameworkApiError} for structured error display in the UI.
 *
 * SECURITY: No credential values are ever transmitted through these functions.
 * The validation report and metadata endpoints return sanitized content only.
 */
import type { AxiosError } from 'axios';
import { apiClient } from './client';
import type {
  DefinitionSummary,
  ProductDefinitionVersion,
  ValidationReport,
  LifecycleActionResult,
  ActivationResult,
  LifecycleEvent,
  FrameworkApiError,
} from './productDefinitions.types';

const BASE = '/framework/product-definitions';

// ── Response normalisation ────────────────────────────────────────────────────

/**
 * Extracts a structured {@link FrameworkApiError} from an Axios error.
 * Falls back to a generic error when the response body is not a framework envelope.
 */
export function extractApiError(err: unknown): FrameworkApiError {
  const axiosErr = err as AxiosError<{ status: string; error?: { code: string; message: string; details?: string; correlationId?: string } }>;
  const body = axiosErr?.response?.data;
  if (body?.status === 'error' && body.error) {
    return body as FrameworkApiError;
  }
  const httpStatus = axiosErr?.response?.status;
  const message = axiosErr?.message ?? 'Unexpected error';
  return {
    status: 'error',
    error: {
      code: httpStatus === 409 ? 'CONFLICT' : httpStatus === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      message,
    },
  };
}

// ── Read endpoints ────────────────────────────────────────────────────────────

/**
 * List all Product Definition summaries for the current tenant.
 *
 * @returns Array of definition summaries sorted by updatedAt descending.
 * @throws {@link FrameworkApiError} on any 4xx/5xx response.
 */
export async function listProductDefinitions(): Promise<DefinitionSummary[]> {
  try {
    const res = await apiClient.get<DefinitionSummary[] | { definitions: DefinitionSummary[] }>(
      BASE,
    );
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && 'definitions' in data && Array.isArray(data.definitions)) return data.definitions;
    return [];
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * List all versions for a Product Definition.
 *
 * @param definitionId UUID of the definition.
 * @returns Array of version records, newest first.
 * @throws {@link FrameworkApiError} on 404 or 5xx.
 */
export async function listProductDefinitionVersions(
  definitionId: string,
): Promise<ProductDefinitionVersion[]> {
  try {
    const res = await apiClient.get<ProductDefinitionVersion[] | { versions: ProductDefinitionVersion[] }>(
      `${BASE}/${definitionId}/versions`,
    );
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && 'versions' in data && Array.isArray(data.versions)) return data.versions;
    return [];
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Fetch the validation report for a specific version.
 *
 * @param definitionId UUID of the definition.
 * @param versionId    Semantic version string (e.g. "1.0.0").
 * @throws {@link FrameworkApiError} on 404 (not validated yet) or 5xx.
 */
export async function getProductDefinitionValidationReport(
  definitionId: string,
  versionId: string,
): Promise<ValidationReport> {
  try {
    const res = await apiClient.get<ValidationReport>(
      `${BASE}/${definitionId}/versions/${versionId}/validation-report`,
    );
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Fetch the currently ACTIVE version for a definition.
 *
 * @throws {@link FrameworkApiError} on 404 (no active version) or 5xx.
 */
export async function getActiveProductDefinitionVersion(
  definitionId: string,
): Promise<ProductDefinitionVersion> {
  try {
    const res = await apiClient.get<ProductDefinitionVersion>(`${BASE}/${definitionId}/active`);
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Fetch the lifecycle history (audit trail) for a definition.
 *
 * @param definitionId UUID of the definition.
 * @returns Array of lifecycle events, newest first.
 */
export async function getProductDefinitionLifecycleHistory(
  definitionId: string,
): Promise<LifecycleEvent[]> {
  try {
    const res = await apiClient.get<LifecycleEvent[] | { events: LifecycleEvent[] }>(
      `${BASE}/${definitionId}/lifecycle-history`,
    );
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && 'events' in data && Array.isArray(data.events)) return data.events;
    return [];
  } catch (err) {
    throw extractApiError(err);
  }
}

// ── Write endpoints (lifecycle actions) ──────────────────────────────────────

/**
 * Upload a new Product Definition file and create a DRAFT version.
 *
 * Sends as multipart/form-data.  The file content is submitted once and
 * discarded after server-side parsing — it is never stored in UI state.
 *
 * @param file        The definition file (XML, XLS, or JSON).
 * @param description Optional human-readable description.
 * @param correlationId Optional client-generated correlation ID for tracing.
 * @throws {@link FrameworkApiError} on validation failure (HTTP 422) or 5xx.
 */
export async function uploadProductDefinition(
  file: File,
  description?: string,
  correlationId?: string,
): Promise<ProductDefinitionVersion> {
  const form = new FormData();
  form.append('file', file);
  if (description) form.append('description', description);
  if (correlationId) form.append('correlationId', correlationId);

  try {
    const res = await apiClient.post<ProductDefinitionVersion>(BASE, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Stage a VALID Product Definition version for review before activation.
 *
 * @throws {@link FrameworkApiError} with code INVALID_LIFECYCLE_TRANSITION (HTTP 409)
 *   if the version is not in DRAFT status.
 * @throws {@link FrameworkApiError} with code VALIDATION_REQUIRED (HTTP 422)
 *   if validationStatus is not VALID.
 */
export async function stageProductDefinitionVersion(
  definitionId: string,
  versionId: string,
): Promise<LifecycleActionResult> {
  try {
    const res = await apiClient.put<LifecycleActionResult>(
      `${BASE}/${definitionId}/versions/${versionId}/stage`,
    );
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Activate a STAGED Product Definition version, rebuilding the active registries.
 *
 * The idempotency key ensures that retrying after a network failure returns
 * the same result without re-executing the activation (WO-022).
 *
 * @param definitionId  UUID of the definition.
 * @param versionId     Semantic version string.
 * @param idempotencyKey Client-generated UUID for safe retry.
 * @throws {@link FrameworkApiError} with code CONFLICT (HTTP 409) on activation conflict.
 */
export async function activateProductDefinitionVersion(
  definitionId: string,
  versionId: string,
  idempotencyKey: string,
): Promise<ActivationResult> {
  try {
    const res = await apiClient.put<ActivationResult>(
      `${BASE}/${definitionId}/versions/${versionId}/activate`,
      { idempotencyKey },
    );
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

/**
 * Rollback the active Product Definition to a prior version.
 *
 * @param definitionId    UUID of the definition.
 * @param targetVersionId The version ID to restore as ACTIVE.
 * @param reason          Human-readable reason for the rollback (required for audit trail).
 * @throws {@link FrameworkApiError} with code INVALID_LIFECYCLE_TRANSITION (HTTP 409)
 *   if the target version is not in SUPERSEDED status.
 */
export async function rollbackProductDefinition(
  definitionId: string,
  targetVersionId: string,
  reason: string,
): Promise<LifecycleActionResult> {
  try {
    const res = await apiClient.put<LifecycleActionResult>(
      `${BASE}/${definitionId}/rollback`,
      { targetVersionId, reason },
    );
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Generate a client-side idempotency key (UUID v4) for lifecycle actions.
 * The key must be unique per intent — callers should generate it once per
 * user confirmation and not regenerate on retry.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

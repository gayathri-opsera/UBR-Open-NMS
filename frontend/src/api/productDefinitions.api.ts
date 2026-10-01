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
  ValidationFinding,
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
  // Fast-path: err is already a FrameworkApiError (e.g. re-thrown by a lower-level API helper).
  // Returning it directly avoids losing the structured code/message when callers double-wrap.
  const plain = err as Record<string, unknown>;
  if (plain?.status === 'error' && typeof plain.error === 'object' && plain.error !== null) {
    return plain as unknown as FrameworkApiError;
  }

  const axiosErr = err as AxiosError<Record<string, unknown>>;
  const body = axiosErr?.response?.data;

  // Format A: canonical gateway/service envelope { status: 'error', error: { code, message } }
  if (body?.status === 'error' && body.error && typeof body.error === 'object') {
    return body as unknown as FrameworkApiError;
  }

  // Format B: Java controller flat format { error: 'CODE', message: 'text' }
  // The Java errorBody() helper returns Map.of("error", code, "message", message).
  if (body && typeof body['error'] === 'string' && typeof body['message'] === 'string') {
    return {
      status: 'error',
      error: {
        code:    body['error'] as string,
        message: body['message'] as string,
      },
    };
  }

  // Format C: old-style gateway flat format { code: 'CODE', message: 'text' }
  // Emitted by gateway error handlers before the envelope was standardised.
  if (body && typeof body['code'] === 'string' && typeof body['message'] === 'string') {
    return {
      status: 'error',
      error: {
        code:    body['code'] as string,
        message: body['message'] as string,
      },
    };
  }

  // Fallback: derive a code from the HTTP status and use the Axios network message.
  const httpStatus = axiosErr?.response?.status;
  const message    = axiosErr?.message ?? 'Unexpected error';
  const code =
    httpStatus === 409 ? 'CONFLICT'       :
    httpStatus === 404 ? 'NOT_FOUND'      :
    httpStatus === 422 ? 'UPLOAD_REJECTED':
    httpStatus === 502 ? 'UPSTREAM_RESET' :
    httpStatus === 503 ? 'SERVICE_UNAVAILABLE' :
    httpStatus === 504 ? 'GATEWAY_TIMEOUT':
    'INTERNAL_ERROR';
  return {
    status: 'error',
    error: { code, message },
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
    // The backend listDefinitions() returns keys: productDefinitionId, vendor, model,
    // activeVersionId, registryVersion.  Normalise here so the rest of the UI can use
    // the canonical DefinitionSummary shape (definitionId, name, …) without change.
    const res = await apiClient.get<Record<string, unknown>[] | { definitions: Record<string, unknown>[] }>(
      BASE,
    );
    const raw: Record<string, unknown>[] = Array.isArray(res.data)
      ? res.data
      : (res.data && 'definitions' in res.data && Array.isArray((res.data as { definitions: unknown[] }).definitions))
        ? (res.data as { definitions: Record<string, unknown>[] }).definitions
        : [];

    return raw.map((r): DefinitionSummary => ({
      // Backend uses productDefinitionId; fall back to id or definitionId for future schema alignment
      definitionId:       String(r['productDefinitionId'] ?? r['definitionId'] ?? r['id'] ?? ''),
      name:               String(r['name'] ?? r['model'] ?? ''),
      vendor:             String(r['vendor'] ?? ''),
      model:              String(r['model'] ?? ''),
      versionCount:       typeof r['versionCount'] === 'number' ? r['versionCount'] : 0,
      activeVersionId:    r['activeVersionId'] != null ? String(r['activeVersionId']) : undefined,
      activeVersionStatus: r['activeVersionStatus'] as DefinitionSummary['activeVersionStatus'] | undefined,
      registryVersion:    typeof r['registryVersion'] === 'number' ? r['registryVersion'] : undefined,
      updatedAt:          String(r['updatedAt'] ?? r['createdAt'] ?? new Date().toISOString()),
    }));
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
    const res = await apiClient.get<Record<string, unknown>>(
      `${BASE}/${definitionId}/versions/${versionId}/report`,
    );
    const raw = res.data;
    // The Java service uses { status, errors[], warnings[] } rather than
    // { validationStatus, findings[] } as declared in the TS DTO.
    // Normalise here so both shapes work in the UI.
    const errors   = Array.isArray(raw['errors'])   ? (raw['errors']   as ValidationFinding[]) : [];
    const warnings = Array.isArray(raw['warnings']) ? (raw['warnings'] as ValidationFinding[]) : [];
    return {
      definitionId:    String(raw['definitionId']    ?? definitionId),
      versionId:       String(raw['versionId']       ?? versionId),
      validationStatus: (raw['validationStatus'] ?? raw['status'] ?? 'UNKNOWN') as ValidationReport['validationStatus'],
      errorCount:      errors.length,
      warningCount:    warnings.length,
      infoCount:       0,
      // Merge errors + warnings into findings so the drawer renders correctly.
      findings:        [...errors, ...warnings],
      validatedAt:     raw['createdAt'] as string | undefined,
      correlationId:   raw['correlationId'] as string | undefined,
      // Pass through extra Java fields so the drawer can display them.
      ...(raw['normalizedSummary']  ? { normalizedSummary:  raw['normalizedSummary']  } : {}),
      ...(raw['fingerprintCount']   ? { fingerprintCount:   raw['fingerprintCount']   } : {}),
      ...(raw['parameterCount']     ? { parameterCount:     raw['parameterCount']     } : {}),
      ...(raw['protocolCount']      ? { protocolCount:      raw['protocolCount']      } : {}),
    } as unknown as ValidationReport;
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
    // The apiClient instance has a global "Content-Type: application/json" default.
    // For FormData uploads the browser must set Content-Type automatically so it can
    // include the multipart boundary.  We strip Content-Type inside transformRequest
    // (the only hook that sees the fully-merged headers object) so the browser's
    // XMLHttpRequest takes over and sets "multipart/form-data; boundary=<token>".
    const res = await apiClient.post<ProductDefinitionVersion>(`${BASE}/upload`, form, {
      transformRequest: [
        (data: unknown, headers: Record<string, unknown> | undefined) => {
          if (headers) {
            delete headers['Content-Type'];
            delete headers['content-type'];
          }
          return data; // pass FormData through as-is; browser handles serialisation
        },
      ],
    });
    return res.data;
  } catch (err) {
    // Normalize to FrameworkApiError.  extractApiError fast-paths already-normalised errors,
    // so callers that catch this and call extractApiError again get the same structured value.
    const apiError = extractApiError(err);
    // Attach the original HTTP status as a non-enumerable property so callers can read it
    // without having to unwrap the raw Axios error themselves.
    const httpStatus = (err as AxiosError)?.response?.status;
    if (httpStatus) Object.defineProperty(apiError, '_httpStatus', { value: httpStatus, enumerable: false });
    throw apiError;
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

// ── Admin: global upload history ─────────────────────────────────────────────

/**
 * Returns every uploaded version across ALL definitions, newest first.
 * Restricted to Admin / SuperAdmin at the gateway.
 */
export async function listAllUploadHistory(): Promise<ProductDefinitionVersion[]> {
  try {
    const res = await apiClient.get<ProductDefinitionVersion[]>(`${BASE}/history`);
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    throw extractApiError(err);
  }
}

// ── Version Diff ──────────────────────────────────────────────────────────────

export interface VersionDiffParamChange {
  parameterId: string;
  label: string | null;
  fromGroupId: string | null;
  toGroupId: string | null;
  fromDataType: string | null;
  toDataType: string | null;
  fromReadOnly: boolean | null;
  toReadOnly: boolean | null;
  summary: string;
}

export interface VersionDiffResult {
  definitionId: string;
  fromVersionId: string;
  toVersionId: string;
  vendor: string | null;
  model: string | null;
  fromParamCount: number;
  toParamCount: number;
  added: VersionDiffParamChange[];
  removed: VersionDiffParamChange[];
  modified: VersionDiffParamChange[];
  moved: VersionDiffParamChange[];
  permissionChanged: VersionDiffParamChange[];
}

/**
 * Fetch a parameter-level diff between two Product Definition versions.
 * The backend uses {@code normalizedMetadataJson} stored on each version record
 * so no re-parsing of the original file is required.
 */
export async function getVersionDiff(
  definitionId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<VersionDiffResult> {
  try {
    const res = await apiClient.get<VersionDiffResult>(
      `${BASE}/${definitionId}/versions/${fromVersionId}/diff/${toVersionId}`,
    );
    return res.data;
  } catch (err) {
    throw extractApiError(err);
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Permanently deletes a Product Definition version and its validation report.
 *
 * ACTIVE versions require {@code force=true} (SuperAdmin only).
 * DRAFT, STAGED, SUPERSEDED, and ARCHIVED versions are always eligible.
 *
 * @param definitionId UUID of the definition family.
 * @param versionId    UUID of the version to delete.
 * @param force        Pass true to force-delete an ACTIVE version (SuperAdmin only).
 * @throws {@link FrameworkApiError} with code DELETE_BLOCKED_ACTIVE (HTTP 409) when
 *   trying to delete the currently ACTIVE version without force=true.
 * @throws {@link FrameworkApiError} with code NOT_FOUND (HTTP 404) when the version
 *   does not exist.
 */
export async function deleteProductDefinitionVersion(
  definitionId: string,
  versionId: string,
  force = false,
): Promise<void> {
  try {
    const url = force
      ? `${BASE}/${definitionId}/versions/${versionId}?force=true`
      : `${BASE}/${definitionId}/versions/${versionId}`;
    await apiClient.delete(url);
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

// ── Product Definition Schema (for dynamic Discovery + Config forms) ──────────

/** One parameter field parsed from a product definition's normalizedMetadataJson. */
export interface PdSchemaParameter {
  id: string;
  displayName: string;
  /** GAUGE | COUNTER | STRING | ENUM | FLOAT | BOOLEAN */
  dataType: string;
  unit?: string;
  minValue?: number;
  maxValue?: number;
  enumValues?: string[];
  snmpOid?: string;
  cliCommand?: string;
  thresholdHigh?: string;
  thresholdLow?: string;
}

/** One parameter group from a product definition. */
export interface PdSchemaGroup {
  groupName: string;
  parameters: PdSchemaParameter[];
}

/** SNMP fingerprint entry from a product definition. */
export interface PdFingerprint {
  sysObjectId: string;
  sysDescrPattern?: string;
  firmwareFrom?: string;
  firmwareTo?: string;
}

/** Full parsed schema for a product definition version. */
export interface ProductDefinitionSchema {
  definitionId: string;
  versionId: string;
  vendor: string;
  model: string;
  name: string;
  productFamily?: string;
  fingerprints: PdFingerprint[];
  protocols: string[];
  groups: PdSchemaGroup[];
}

/**
 * Fetches a product definition version record and parses its
 * {@code normalizedMetadataJson} into a typed schema that drives the
 * dynamic Discovery and Config form renderers.
 *
 * Returns null when the version record has no normalized metadata
 * (e.g. the upload failed validation before normalization ran).
 */
export async function getVersionSchema(
  definitionId: string,
  versionId: string,
): Promise<ProductDefinitionSchema | null> {
  try {
    const res = await apiClient.get<Record<string, unknown>>(
      `${BASE}/${definitionId}/versions/${versionId}`,
    );
    const record = res.data;
    const jsonStr = record['normalizedMetadataJson'];
    if (!jsonStr || typeof jsonStr !== 'string') return null;

    const meta = JSON.parse(jsonStr) as Record<string, unknown>;
    const identity = (meta['identity'] ?? meta) as Record<string, unknown>;

    // ── Parse parameter groups ── (XML and JSON formats differ slightly)
    const rawGroups: PdSchemaGroup[] = [];
    const rawParams = meta['parameterGroups'] ?? meta['parameters'];

    if (Array.isArray(rawParams)) {
      for (const g of rawParams as Record<string, unknown>[]) {
        const groupName = String(g['groupName'] ?? g['name'] ?? 'parameters');
        const rawFields = (g['parameters'] ?? []) as Record<string, unknown>[];
        rawGroups.push({
          groupName,
          parameters: rawFields.map((p) => ({
            id:           String(p['id'] ?? ''),
            displayName:  String(p['displayName'] ?? p['id'] ?? ''),
            dataType:     String(p['dataType'] ?? 'STRING').toUpperCase(),
            unit:         p['unit'] != null ? String(p['unit']) : undefined,
            minValue:     typeof p['minValue'] === 'number' ? p['minValue'] : undefined,
            maxValue:     typeof p['maxValue'] === 'number' ? p['maxValue'] : undefined,
            enumValues:   Array.isArray(p['enumValues'])
              ? (p['enumValues'] as string[])
              : (typeof p['enumValues'] === 'string'
                ? (p['enumValues'] as string).split(',').map((v: string) => v.trim())
                : undefined),
            // NormalizedProductDefinition.ParameterEntry stores snmpOid directly;
            // raw XML/JSON upload formats may use a nested snmpMapping.oid.
            snmpOid:      p['snmpOid'] as string | undefined ??
                          (p['snmpMapping'] as Record<string,unknown>)?.['oid'] as string | undefined,
            cliCommand:   p['cliCommand'] as string | undefined ??
                          (p['cliMapping'] as Record<string,unknown>)?.['command'] as string | undefined,
            thresholdHigh: p['thresholdHigh'] != null ? String(p['thresholdHigh']) : undefined,
            thresholdLow:  p['thresholdLow']  != null ? String(p['thresholdLow'])  : undefined,
          })),
        });
      }
    }

    // ── Detect empty groups (Java normalization bug) ────────────────────────
    // When the Java product-definition-service normalizes certain XML/JSON formats,
    // it can produce N groups all named "default" with empty parameters arrays.
    // In that case, fall back to the gateway's parameter registry which has the
    // correctly-seeded parameter data for this definition.
    const allEmpty = rawGroups.length > 0 && rawGroups.every(
      (g) => g.parameters.length === 0 || g.groupName === 'default',
    );
    if (allEmpty) {
      try {
        // Gateway registry endpoint: reads parameter_registry_entries by definitionId
        const regRes = await apiClient.get<Record<string, unknown>>(
          `/config/definition-params/${definitionId}`,
        );
        const regGroups = regRes.data['groups'] as Array<{
          groupId: string; parameters: Array<Record<string, unknown>>;
        }>;
        if (Array.isArray(regGroups) && regGroups.length > 0) {
          rawGroups.length = 0; // clear the broken default groups
          for (const g of regGroups) {
            rawGroups.push({
              groupName: g.groupId,
              parameters: (g.parameters ?? []).map((p) => ({
                id:           String(p['parameterId'] ?? ''),
                displayName:  String(p['displayName'] ?? p['parameterId'] ?? ''),
                dataType:     String(p['dataType'] ?? 'STRING').toUpperCase(),
                unit:         p['unit'] != null ? String(p['unit']) : undefined,
                snmpOid:      p['snmpOid'] as string | undefined,
                enumValues:   Array.isArray(p['enumValues']) ? p['enumValues'] as string[] : undefined,
                minValue:     typeof p['minValue'] === 'number' ? p['minValue'] : undefined,
                maxValue:     typeof p['maxValue'] === 'number' ? p['maxValue'] : undefined,
              })),
            });
          }
        }
      } catch { /* non-fatal — use whatever groups we have */ }
    }

    // ── Parse fingerprints ────────────────────────────────────────────────────
    const rawFps = (meta['fingerprints'] ?? []) as Record<string, unknown>[];
    const fingerprints: PdFingerprint[] = rawFps.map((f) => ({
      sysObjectId:      String(f['sysObjectId'] ?? ''),
      sysDescrPattern:  f['sysDescrPattern'] != null ? String(f['sysDescrPattern']) : undefined,
      firmwareFrom:     f['firmwareFrom']     != null ? String(f['firmwareFrom'])    : undefined,
      firmwareTo:       f['firmwareTo']       != null ? String(f['firmwareTo'])      : undefined,
    }));

    // ── Parse supported protocols ─────────────────────────────────────────────
    const rawProtos = (meta['supportedProtocols'] ?? []) as unknown[];
    const protocols = rawProtos.map((p) =>
      typeof p === 'string' ? p : String((p as Record<string,unknown>)['type'] ?? p),
    );

    return {
      definitionId,
      versionId,
      vendor:        String(identity['vendor'] ?? record['vendor'] ?? ''),
      model:         String(identity['model']  ?? record['model']  ?? ''),
      name:          String(identity['name']   ?? record['name']   ?? ''),
      productFamily: identity['productFamily'] != null ? String(identity['productFamily']) : undefined,
      fingerprints,
      protocols,
      groups: rawGroups,
    };
  } catch {
    return null;
  }
}

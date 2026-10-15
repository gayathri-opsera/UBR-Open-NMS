/**
 * Descriptor Registry API client  (/api/descriptors)
 *
 * All requests go through the shared {@link apiClient} (JWT + 401 redirect).
 * File uploads use FormData with multipart/form-data.
 *
 * Security: Secret parameter values are never sent or displayed.
 *           All API calls are authenticated; RBAC is enforced server-side.
 */
import type { AxiosError } from 'axios';
import { apiClient } from './client';
import type {
  DescriptorVersion,
  DescriptorSummary,
  DependentsResponse,
  ImpactReport,
  ValidationResult,
  MigrateResult,
  DescriptorApiError,
  DescriptorUploadForm,
  LifecycleActionParams,
  MigrateParams,
} from './descriptors.types';

const BASE = '/descriptors';

// ── Error normalisation ───────────────────────────────────────────────────────

export function extractDescriptorError(err: unknown): DescriptorApiError {
  const plain = err as Record<string, unknown>;
  // Already in envelope form
  if (plain?.status === 'error' && typeof plain.error === 'object') {
    return plain as unknown as DescriptorApiError;
  }

  const axiosErr = err as AxiosError<Record<string, unknown>>;
  const body = axiosErr?.response?.data;
  if (body?.status === 'error' && body.error && typeof body.error === 'object') {
    return body as unknown as DescriptorApiError;
  }

  // Flat error object
  if (body && typeof body['error'] === 'string') {
    return {
      status: 'error',
      error: {
        code:    body['error'] as string,
        message: (body['message'] as string) || 'Unknown error',
      },
    };
  }

  const status = axiosErr?.response?.status;
  return {
    status: 'error',
    error: {
      code:    status ? `HTTP_${status}` : 'NETWORK_ERROR',
      message: status ? `Request failed with status ${status}` : 'Network error — check your connection',
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function unwrap<T>(data: { data?: T } | T): T {
  if (data && typeof data === 'object' && 'data' in data && data.data !== undefined) {
    return data.data as T;
  }
  return data as T;
}

// ── List all descriptors ───────────────────────────────────────────────────────

/**
 * List all descriptor versions, optionally filtered by state and/or vendor.
 */
export async function listDescriptors(params?: {
  state?:  string;
  vendor?: string;
}): Promise<DescriptorSummary[]> {
  const res = await apiClient.get<{ data: DescriptorSummary[] }>(BASE, { params });
  return unwrap(res.data);
}

// ── Upload new descriptor ─────────────────────────────────────────────────────

/**
 * Upload a new descriptor file (XML, JSON, XLS/XLSX) to create a Draft.
 * Returns the saved DescriptorVersion document.
 */
export async function uploadDescriptor(form: DescriptorUploadForm): Promise<DescriptorVersion> {
  const fd = new FormData();
  fd.append('productDefinitionId', form.productDefinitionId);
  fd.append('version',             form.version);
  fd.append('file',                form.file, form.file.name);

  const res = await apiClient.post<{ data: DescriptorVersion }>(BASE, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return unwrap(res.data);
}

// ── List versions for a product ────────────────────────────────────────────────

export async function listVersions(productDefinitionId: string): Promise<DescriptorSummary[]> {
  const res = await apiClient.get<{ data: DescriptorSummary[] }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions`,
  );
  return unwrap(res.data);
}

// ── Get single version ─────────────────────────────────────────────────────────

export async function getVersion(
  productDefinitionId: string,
  version: string,
): Promise<DescriptorVersion> {
  const res = await apiClient.get<{ data: DescriptorVersion }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}`,
  );
  return unwrap(res.data);
}

// ── Dependency counts + records ────────────────────────────────────────────────

export async function getDependents(
  productDefinitionId: string,
  version: string,
): Promise<DependentsResponse> {
  const res = await apiClient.get<{ data: DependentsResponse }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}/dependents`,
  );
  return unwrap(res.data);
}

// ── Impact report ──────────────────────────────────────────────────────────────

export async function getImpactReport(
  productDefinitionId: string,
  version: string,
): Promise<ImpactReport> {
  const res = await apiClient.get<{ data: ImpactReport }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}/impact`,
  );
  return unwrap(res.data);
}

// ── Lifecycle actions ──────────────────────────────────────────────────────────

async function lifecycleAction<T>(
  productDefinitionId: string,
  version: string,
  action: string,
  params?: LifecycleActionParams,
): Promise<T> {
  const res = await apiClient.post<{ data: T }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}/${action}`,
    params || {},
  );
  return unwrap(res.data);
}

/** Trigger lint validation: Draft/Invalid → Valid or Invalid */
export function validateDescriptor(
  productDefinitionId: string,
  version: string,
): Promise<ValidationResult> {
  return lifecycleAction<ValidationResult>(productDefinitionId, version, 'validate');
}

/** Approve: Valid → Approved (maker-checker — different user from uploader) */
export function approveDescriptor(
  productDefinitionId: string,
  version: string,
  params?: LifecycleActionParams,
): Promise<DescriptorVersion> {
  return lifecycleAction<DescriptorVersion>(productDefinitionId, version, 'approve', params);
}

/** Activate: Approved → Active (builds wireframe) */
export function activateDescriptor(
  productDefinitionId: string,
  version: string,
  params?: LifecycleActionParams,
): Promise<DescriptorVersion> {
  return lifecycleAction<DescriptorVersion>(productDefinitionId, version, 'activate', params);
}

/** Deprecate: Active → Deprecated (blocks new device bindings) */
export function deprecateDescriptor(
  productDefinitionId: string,
  version: string,
  params?: LifecycleActionParams,
): Promise<DescriptorVersion> {
  return lifecycleAction<DescriptorVersion>(productDefinitionId, version, 'deprecate', params);
}

/** Retire: Deprecated → Retired (delete guard — 409 if still in use) */
export function retireDescriptor(
  productDefinitionId: string,
  version: string,
  params?: LifecycleActionParams,
): Promise<DescriptorVersion> {
  return lifecycleAction<DescriptorVersion>(productDefinitionId, version, 'retire', params);
}

/** Purge: Retired → Purged (retention period check) */
export function purgeDescriptor(
  productDefinitionId: string,
  version: string,
  params?: LifecycleActionParams,
): Promise<{ productDefinitionId: string; version: string; state: string; purgedAt: string }> {
  return lifecycleAction(productDefinitionId, version, 'purge', params);
}

/** Delete: only Draft or Invalid (409 USE_RETIRE_FLOW otherwise) */
export async function deleteDescriptorDraft(
  productDefinitionId: string,
  version: string,
  reason?: string,
): Promise<{ productDefinitionId: string; version: string; deleted: boolean }> {
  const res = await apiClient.delete<{ data: { productDefinitionId: string; version: string; deleted: boolean } }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}`,
    { data: reason ? { reason } : {} },
  );
  return unwrap(res.data);
}

// ── Migrate ────────────────────────────────────────────────────────────────────

/**
 * Bulk migrate devices from one descriptor version to another Active version.
 * Default dryRun=true: inspect diff before committing.
 */
export async function migrateDescriptor(
  productDefinitionId: string,
  version: string,
  params: MigrateParams,
): Promise<MigrateResult> {
  const res = await apiClient.post<{ data: MigrateResult }>(
    `${BASE}/${encodeURIComponent(productDefinitionId)}/versions/${encodeURIComponent(version)}/migrate`,
    { dryRun: true, ...params },
  );
  return unwrap(res.data);
}

// ── Deprovision ────────────────────────────────────────────────────────────────

export async function deprovisionDevices(params: {
  productDefinitionId?: string;
  version?:             string;
  deviceIds?:           string[];
  dryRun?:              boolean;
}): Promise<{ total: number; results: { deviceId: string; success: boolean; error?: string }[] }> {
  const res = await apiClient.post<{ data: unknown }>('/descriptors/devices/deprovision', params);
  return unwrap(res.data) as { total: number; results: { deviceId: string; success: boolean; error?: string }[] };
}

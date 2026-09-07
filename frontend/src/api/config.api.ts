import { apiClient } from './client';
import type { ConfigTemplate, ConfigJob, ConfigVersion, PushResult } from './config.types';

export async function fetchTemplates(): Promise<ConfigTemplate[]> {
  const res = await apiClient.get<Record<string, unknown>[]>('/config/templates');
  // The config-service returns flat fields; normalize them into the parameters shape
  return (res.data ?? []).map(normalizeTemplate);
}

export async function createTemplate(template: ConfigTemplate): Promise<ConfigTemplate> {
  const res = await apiClient.post<Record<string, unknown>>('/config/templates', flattenTemplate(template));
  return normalizeTemplate(res.data);
}

export async function updateTemplate(id: string, template: ConfigTemplate): Promise<ConfigTemplate> {
  const res = await apiClient.put<Record<string, unknown>>(`/config/templates/${id}`, flattenTemplate(template));
  return normalizeTemplate(res.data);
}

export async function deleteTemplate(id: string): Promise<void> {
  await apiClient.delete(`/config/templates/${id}`);
}

export async function pushConfig(
  deviceId: string,
  templateId: string,
  params?: Record<string, string | number | boolean>,
): Promise<PushResult> {
  let actor = 'operator';
  try {
    const raw = localStorage.getItem('nms_user') || localStorage.getItem('user') || localStorage.getItem('auth_user');
    if (raw) { const u = JSON.parse(raw); actor = u.username || u.email || u.name || actor; }
  } catch { /* ignore */ }
  const res = await apiClient.post<PushResult>(
    `/config/push/${deviceId}`,
    { templateId, actor, ...(params ?? {}) },
  );
  return res.data;
}

export async function bulkPush(filter: Record<string, string>, templateId: string): Promise<ConfigJob> {
  const res = await apiClient.post<ConfigJob>('/config/bulk-push', { filter, templateId });
  return res.data;
}

export async function getJobStatus(jobId: string): Promise<ConfigJob> {
  const res = await apiClient.get<ConfigJob>(`/config/jobs/${jobId}/status`);
  return res.data;
}

export async function getVersionHistory(deviceId: string): Promise<ConfigVersion[]> {
  const res = await apiClient.get<ConfigVersion[]>(`/devices/${deviceId}/config-history`);
  return res.data;
}

export async function pushFirmware(deviceId: string, firmwareVersion: string, firmwareUrl?: string): Promise<PushResult> {
  const res = await apiClient.post<PushResult>(`/config/push/${deviceId}`, null, {
    params: { templateId: 'firmware', firmware: 'true', firmwareVersion, firmwareUrl: firmwareUrl ?? '' },
  });
  return res.data;
}

export async function bulkFirmware(deviceIds: string[], firmwareVersion: string, firmwareUrl?: string): Promise<ConfigJob> {
  const res = await apiClient.post<ConfigJob>('/config/bulk-push', null, {
    params: { deviceIds: deviceIds.join(','), templateId: 'firmware', firmware: 'true', firmwareVersion, firmwareUrl: firmwareUrl ?? '' },
  });
  return res.data;
}

export async function pushDeviceParam(deviceId: string, params: Record<string, string | number | boolean>): Promise<PushResult> {
  // Resolve actor from stored auth profile so history shows the real username
  let actor = 'operator';
  try {
    const raw = localStorage.getItem('nms_user') || localStorage.getItem('user') || localStorage.getItem('auth_user');
    if (raw) { const u = JSON.parse(raw); actor = u.username || u.email || u.name || actor; }
  } catch { /* ignore */ }
  const res = await apiClient.post<PushResult>(`/config/push/${deviceId}`, { ...params, actor }, {
    params: { templateId: 'inline' },
  });
  return res.data;
}

export interface MissingDataReport {
  deviceId: string;
  missingMetrics: string[];
  lastDataAt: string | null;
  gapDurationMs: number;
}

export async function fetchMissingData(networkId?: string): Promise<MissingDataReport[]> {
  const res = await apiClient.get<MissingDataReport[]>('/diagnostics/missing-data',
    networkId ? { params: { networkId } } : undefined);
  return res.data;
}

// ── Capability evaluation (WO-003) ────────────────────────────────────────────

export interface DeviceCapabilityResponse {
  deviceId: string;
  capabilityProfileId: string | null;
  supportedOperations: string[];
  unsupportedOperations: Record<string, string>;
  protocolPriorityByOperation: Record<string, string[]>;
  releaseEligible: boolean;
  reason: string | null;
}

export interface BulkEvaluationResult {
  eligible: string[];
  ineligible: Array<{ deviceId: string; reason: string }>;
}

/** Fetch capability profile for a single device. */
export async function fetchDeviceCapability(deviceId: string): Promise<DeviceCapabilityResponse> {
  const res = await apiClient.get<DeviceCapabilityResponse>(`/capabilities/devices/${deviceId}`);
  return res.data;
}

/** Bulk-evaluate which devices support a given operation. */
export async function evaluateCapabilities(
  deviceIds: string[],
  operation: string,
): Promise<BulkEvaluationResult> {
  const res = await apiClient.post<BulkEvaluationResult>('/capabilities/evaluate', { deviceIds, operation });
  return res.data;
}

// ── Target preview types (WO-039) ─────────────────────────────────────────────

export interface ConfigTargetFilters {
  serialNumbers?: string[];
  macAddresses?: string[];
  deviceType?: 'BTS' | 'CPE' | 'IDU' | 'GENERIC';
  sysObjectID?: string;
  vendor?: string;
  model?: string;
  ipAddress?: string;
  region?: string;
  organizationId?: string;
  networkId?: string;
  /** UBR_CALL_HOME | GENERIC_SNMP | GENERIC_CLI */
  discoveryParadigm?: string;
  /** ACTIVE | INACTIVE | FAULTY | DECOMMISSIONED */
  status?: string;
  capabilityProfileId?: string;
  tags?: Array<{ key: string; value: string }>;
  onboardingGateState?: 'MANAGED' | 'PENDING_ASSIGNMENT' | 'CONFIG_WITHHELD';
}

export interface ConfigTargetPreviewRequest {
  /** CONFIG_PUSH | FIRMWARE_UPGRADE | PARAMETER_CHANGE | COMMAND_EXECUTE */
  actionType: string;
  filters: ConfigTargetFilters;
  limit?: number;
  sort?: string;
}

export interface ConfigTargetEntry {
  deviceId: string;
  displayName: string;
  serialNumber: string;
  macAddress: string | null;
  deviceType: string;
  /** Present for GENERIC devices; null for UBR. */
  sysObjectID: string | null;
  discoveryParadigm: string;
  status: string;
  capabilities: string[];
  matchedFilters: string[];
  /**
   * Delivery channel classification:
   * UBR_REALTIME | UBR_CHECKIN | SNMP_PROTOCOL | CLI_PROTOCOL | UNSUPPORTED
   */
  deliveryChannel: string;
  warnings: string[];
}

export interface ConfigUnsupportedTargetEntry {
  deviceId: string;
  serialNumber: string;
  deviceType: string;
  discoveryParadigm: string;
  reason: string;
  unsupportedOperation: string;
}

export interface ConfigTargetPreviewResponse {
  previewId: string;
  totalCount: number;
  targets: ConfigTargetEntry[];
  unsupportedTargets: ConfigUnsupportedTargetEntry[];
  generatedAt: string;
  requiresConfirmation: boolean;
}

/**
 * Preview which devices would be targeted by a configuration action, and how
 * they would be reached, without executing any change (WO-039).
 *
 * Sends POST /api/v1/config/targets/preview via the gateway proxy.
 */
export async function previewConfigTargets(
  request: ConfigTargetPreviewRequest,
): Promise<ConfigTargetPreviewResponse> {
  const res = await apiClient.post<ConfigTargetPreviewResponse>(
    '/config/targets/preview',
    request,
  );
  return res.data;
}

// ── Execution confirmation (WO-045) ──────────────────────────────────────────

/** Payload for POST /api/v1/config/actions/confirm */
export interface ConfirmExecutionRequest {
  /** Preview ID returned by previewConfigTargets. */
  previewId: string;
  /** Must match the actionType used when generating the preview. */
  actionType: string;
  /** Template ID to apply (optional for COMMAND_EXECUTE/PARAMETER_CHANGE). */
  templateId?: string;
  /**
   * Target count the operator is confirming.
   * Server validates this matches the current preview to prevent accidental broad execution.
   */
  expectedTargetCount: number;
  /** Whether the operator acknowledged warnings in the preview. */
  acceptWarnings?: boolean;
  /** External approval reference (change ticket, JIRA ID, etc.). */
  approvalReference?: string;
  /**
   * Client-generated idempotency key (UUID).
   * Duplicate requests with the same key+previewId return the existing job.
   */
  idempotencyKey?: string;
}

/** Response from a successful or idempotent confirmation. */
export interface ConfirmExecutionResponse {
  jobId: string;
  status: string;
  acceptedAt: string;
  acceptedBy: string;
  targetCount: number;
  previewId: string;
  trackingUrl: string;
  /** Only present for idempotent responses. */
  note?: string;
}

/**
 * Confirm a previewed configuration execution (WO-045).
 *
 * Requires network_engineer or admin actor role (sent via X-Actor-Role header).
 * Returns an accepted async job the caller can track via trackingUrl.
 *
 * Throws on 400 (malformed), 403 (unauthorized), 404 (unknown preview),
 * 409 (stale preview or target count mismatch).
 */
export async function confirmConfigExecution(
  request: ConfirmExecutionRequest,
  actorRole = 'network_engineer',
): Promise<ConfirmExecutionResponse> {
  let actor = 'operator';
  try {
    const raw = localStorage.getItem('nms_user') || localStorage.getItem('user') || localStorage.getItem('auth_user');
    if (raw) { const u = JSON.parse(raw); actor = u.username || u.email || u.name || actor; }
  } catch { /* ignore */ }

  const res = await apiClient.post<ConfirmExecutionResponse>(
    '/config/actions/confirm',
    request,
    {
      headers: {
        'X-Actor-Role': actorRole,
        'X-Actor': actor,
      },
    },
  );
  return res.data;
}

// ── Internal shape normalization ──────────────────────────────────────────────

/** Config-service returns flat fields; collect them into a `parameters` map */
function normalizeTemplate(raw: Record<string, unknown>): ConfigTemplate {
  const META_FIELDS = new Set(['id','name','description','deviceType','isDefault','createdBy','createdAt','updatedAt','customFields','hiddenFields']);
  const parameters: Record<string, string | number | boolean> = {};

  for (const [k, v] of Object.entries(raw)) {
    // Skip meta fields and nulls; anything else goes into parameters
    if (!META_FIELDS.has(k) && v !== null && v !== undefined && typeof v !== 'object') {
      parameters[k] = v as string | number | boolean;
    }
  }

  // Merge additionalParams if present
  if (raw.additionalParams && typeof raw.additionalParams === 'object') {
    Object.assign(parameters, raw.additionalParams);
  }

  return {
    id:           raw.id as string | undefined,
    name:         (raw.name as string) ?? '',
    description:  raw.description as string | undefined,
    deviceType:   (raw.deviceType as 'BTS' | 'CPE' | 'IDU' | undefined) ?? 'BTS',
    isDefault:    Boolean(raw.isDefault),
    parameters,
    customFields: (raw.customFields as ConfigTemplate['customFields']) ?? [],
    hiddenFields: (raw.hiddenFields as string[]) ?? [],
    createdAt:    raw.createdAt as string | undefined,
    updatedAt:    raw.updatedAt as string | undefined,
  };
}

/** Flatten a ConfigTemplate back to the shape the config-service accepts */
function flattenTemplate(t: ConfigTemplate): Record<string, unknown> {
  return {
    ...t.parameters,
    name: t.name,
    description: t.description,
    deviceType: t.deviceType,
    isDefault: t.isDefault,
    customFields: t.customFields ?? [],
    hiddenFields: t.hiddenFields ?? [],
  };
}

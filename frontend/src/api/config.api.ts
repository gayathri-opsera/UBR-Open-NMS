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

export async function pushConfig(deviceId: string, templateId: string): Promise<PushResult> {
  const res = await apiClient.post<PushResult>(`/config/push/${deviceId}`, { templateId });
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
  const res = await apiClient.post<PushResult>(`/config/push/${deviceId}`, params, {
    params: { templateId: 'inline', actor: 'nms-operator' },
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

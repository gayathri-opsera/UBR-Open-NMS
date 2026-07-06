import { apiClient } from './client';
import type { ConfigTemplate, ConfigJob, ConfigVersion, PushResult } from './config.types';

export async function fetchTemplates(): Promise<ConfigTemplate[]> {
  const res = await apiClient.get<ConfigTemplate[]>('/config/templates');
  return res.data;
}

export async function createTemplate(template: ConfigTemplate): Promise<ConfigTemplate> {
  const res = await apiClient.post<ConfigTemplate>('/config/templates', template);
  return res.data;
}

export async function updateTemplate(id: string, template: ConfigTemplate): Promise<ConfigTemplate> {
  const res = await apiClient.put<ConfigTemplate>(`/config/templates/${id}`, template);
  return res.data;
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

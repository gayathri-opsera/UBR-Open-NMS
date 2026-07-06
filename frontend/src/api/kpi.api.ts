import { apiClient } from './client';
import type { KpiParam, KpiSeries, KpiThreshold, Granularity } from './kpi.types';

export async function fetchDeviceKpi(
  deviceId: string,
  params: KpiParam[],
  granularity: Granularity,
  from: string,
  to: string,
): Promise<KpiSeries[]> {
  const res = await apiClient.get<{ metrics: Record<string, { avg: number; min: number; max: number }>; bucketStart: string; sampleCount: number }[]>(
    `/kpi/devices/${deviceId}/metrics`,
    { params: { metrics: params.join(','), granularity, from, to } },
  );
  return params.map((p) => ({
    deviceId,
    param: p,
    granularity,
    data: res.data.map((row) => ({
      bucketStart: row.bucketStart,
      avg: row.metrics?.[p]?.avg ?? 0,
      min: row.metrics?.[p]?.min ?? 0,
      max: row.metrics?.[p]?.max ?? 0,
      sampleCount: row.sampleCount,
    })),
  }));
}

export async function fetchThresholds(deviceId?: string): Promise<KpiThreshold[]> {
  const res = await apiClient.get<KpiThreshold[]>('/kpi/thresholds',
    deviceId ? { params: { deviceId } } : undefined);
  return res.data;
}

export async function createThreshold(threshold: Omit<KpiThreshold, 'id'>): Promise<KpiThreshold> {
  const res = await apiClient.post<KpiThreshold>('/kpi/thresholds', threshold);
  return res.data;
}

export async function updateThreshold(id: string, threshold: Partial<KpiThreshold>): Promise<KpiThreshold> {
  const res = await apiClient.put<KpiThreshold>(`/kpi/thresholds/${id}`, threshold);
  return res.data;
}

export async function deleteThreshold(id: string): Promise<void> {
  await apiClient.delete(`/kpi/thresholds/${id}`);
}

export function buildExportUrl(deviceId: string, params: KpiParam[], granularity: Granularity,
                                from: string, to: string, format: 'csv' | 'xls'): string {
  const p = new URLSearchParams({ deviceId, metrics: params.join(','), granularity, from, to, format });
  return `/api/v1/kpi/export?${p}`;
}

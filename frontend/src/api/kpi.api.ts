import { apiClient } from './client';
import type {
  KpiParam, KpiSeries, KpiThreshold, Granularity,
  KpiOperationsSummaryRequest, KpiOperationsSummaryResponse,
} from './kpi.types';

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

export async function downloadKpiExport(deviceId: string, params: KpiParam[], granularity: Granularity,
                                         from: string, to: string, format: 'csv' | 'xls'): Promise<void> {
  const res = await apiClient.get('/kpi/export', {
    params: { deviceId, metrics: params.join(','), granularity, from, to, format },
    responseType: 'blob',
  });
  const ext = format === 'xls' ? 'xlsx' : 'csv';
  const url = URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kpi-${deviceId}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Fetches the KPI operations summary for fleet-level health monitoring (WO-034).
 *
 * GET /api/v1/kpi/operations-summary
 * Accepts: timeRange, networkId, organizationId, deviceType, metricGroup
 * Returns: summaryCards, topImpactedDevices, trendSeries, staleData
 */
export async function fetchKpiOperationsSummary(
  req: KpiOperationsSummaryRequest = {},
): Promise<KpiOperationsSummaryResponse> {
  const params: Record<string, string> = {};
  if (req.timeRange)      params.timeRange      = req.timeRange;
  if (req.networkId)      params.networkId      = req.networkId;
  if (req.organizationId) params.organizationId = req.organizationId;
  if (req.deviceType)     params.deviceType     = req.deviceType;
  if (req.metricGroup)    params.metricGroup    = req.metricGroup;

  const res = await apiClient.get<KpiOperationsSummaryResponse>(
    '/kpi/operations-summary',
    { params },
  );
  return res.data;
}

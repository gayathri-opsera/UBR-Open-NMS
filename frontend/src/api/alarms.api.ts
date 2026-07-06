import { apiClient } from './client';
import type { Alarm, AlarmFilter, AlarmTypeStat, TopAlarm } from './alarms.types';

export async function fetchAlarms(filter: AlarmFilter = {}): Promise<Alarm[]> {
  const res = await apiClient.get<Alarm[]>('/alarms', { params: filter });
  return res.data;
}

export async function acknowledgeAlarm(id: string, actor = 'nms-operator'): Promise<Alarm> {
  const res = await apiClient.put<Alarm>(`/alarms/${id}/acknowledge`, null, { params: { actor } });
  return res.data;
}

// top-reported and type-counts require mandatory from/to params in the backend
function defaultRange() {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  return { from, to };
}

export async function fetchTopAlarms(scope?: { organizationId?: string; networkId?: string; from?: string; to?: string }): Promise<TopAlarm[]> {
  const { from, to } = defaultRange();
  const res = await apiClient.get<TopAlarm[]>('/alarms/top-reported', {
    params: { from, to, limit: 10, ...scope },
  });
  return res.data;
}

export async function fetchAlarmTypeCounts(scope?: { organizationId?: string; networkId?: string; from?: string; to?: string }): Promise<AlarmTypeStat[]> {
  const { from, to } = defaultRange();
  const res = await apiClient.get<AlarmTypeStat[]>('/alarms/type-counts', {
    params: { from, to, ...scope },
  });
  // backend returns Map<String, Long> — convert to array
  const raw = res.data as unknown;
  if (Array.isArray(raw)) return raw as AlarmTypeStat[];
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, number>).map(([alarmType, count]) => ({ alarmType, count }));
  }
  return [];
}

export function buildExportUrl(filter: AlarmFilter, format: 'csv' | 'xls'): string {
  const params = new URLSearchParams({ ...filter as Record<string, string>, format });
  return `/api/v1/alarms/export?${params}`;
}

import { apiClient } from './client';
import type { Alarm, AlarmFilter, AlarmTypeStat, TopAlarm } from './alarms.types';

export async function fetchAlarms(filter: AlarmFilter = {}): Promise<Alarm[]> {
  const res = await apiClient.get<Alarm[]>('/alarms', { params: filter });
  // Normalize backend field names → Alarm interface
  return (res.data ?? []).map((raw: Alarm & {
    raisedAt?: string;
    alarmDescription?: string;
    description?: string;
    message?: string;
    deviceName?: string;
    serialNumber?: string;
  }) => ({
    ...raw,
    timestamp:    raw.timestamp    || raw.raisedAt || '',
    // Prefer a human-readable message from any of these backend fields
    message:      raw.message      || raw.alarmDescription || raw.description || '',
    deviceName:   raw.deviceName   || raw.serialNumber || '',
    serialNumber: raw.serialNumber || '',
  }));
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
  const res = await apiClient.get<unknown>('/alarms/top-reported', {
    params: { from, to, limit: 10, ...scope },
  });
  const raw = res.data;
  if (!raw) return [];
  // Java Map.Entry serializes as [{key, value}] — normalize to [{alarmType, count}]
  if (Array.isArray(raw)) {
    return (raw as Array<Record<string, unknown>>).map((item) => ({
      alarmType: String(item.alarmType ?? item.key ?? item.type ?? ''),
      count: Number(item.count ?? item.value ?? 0),
    }));
  }
  // Map<String, Long> → {SIGNAL_LOSS: 5, ...}
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, number>).map(([alarmType, count]) => ({ alarmType, count }));
  }
  return [];
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

export async function downloadAlarmExport(filter: AlarmFilter, format: 'csv' | 'xls'): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  clean.format = format;
  const res = await apiClient.get('/alarms/export', { params: clean, responseType: 'blob' });
  const ext = format === 'xls' ? 'xlsx' : 'csv';
  const url = URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `alarms-export.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Threshold management (EV-05) ─────────────────────────────────────────────

export interface AlarmThreshold {
  id?: string;
  metricName: string;
  operator: 'GT' | 'LT' | 'GTE' | 'LTE';
  thresholdValue: number;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING';
  alarmName: string;
  deviceType?: 'BTS' | 'CPE' | 'IDU' | 'ALL';
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export async function fetchAlarmThresholds(): Promise<AlarmThreshold[]> {
  const res = await apiClient.get<AlarmThreshold[]>('/alarms/thresholds');
  return res.data;
}

export async function createAlarmThreshold(threshold: Omit<AlarmThreshold, 'id' | 'createdAt' | 'updatedAt'>): Promise<AlarmThreshold> {
  const res = await apiClient.post<AlarmThreshold>('/alarms/thresholds', threshold);
  return res.data;
}


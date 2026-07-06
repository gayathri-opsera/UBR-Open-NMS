export const KPI_PARAMS = [
  'rssi', 'snr', 'cpuUtilization', 'memoryUtilization',
  'throughputUL', 'throughputDL', 'channelUtilization',
  'connectedClients', 'txPower', 'retryRate',
] as const;
export type KpiParam = typeof KPI_PARAMS[number];

export const GRANULARITIES = ['15MIN', '1HOUR', 'DAILY'] as const;
export type Granularity = typeof GRANULARITIES[number];

export interface KpiDataPoint {
  bucketStart: string;
  avg: number;
  min: number;
  max: number;
  sampleCount: number;
}

export interface KpiSeries {
  deviceId: string;
  param: KpiParam;
  granularity: Granularity;
  data: KpiDataPoint[];
}

export interface KpiThreshold {
  id?: string;
  deviceId: string;
  metric: KpiParam;
  raiseThreshold: number;
  clearThreshold: number;
  severity: string;
  direction?: 'ABOVE' | 'BELOW';
}

export type TimeRange = '1h' | '6h' | '24h' | '7d';

export function timeRangeToGranularity(tr: TimeRange): Granularity {
  if (tr === '7d') return 'DAILY';
  if (tr === '24h') return '1HOUR';
  return '15MIN';
}

export function timeRangeToMs(tr: TimeRange): number {
  const h = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
  return h[tr] * 3_600_000;
}

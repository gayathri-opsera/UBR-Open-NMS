export const KPI_PARAMS = [
  'cpuUtilization', 'memoryUtilization',
  'throughputUL', 'throughputDL', 'channelUtilization',
  'connectedClients', 'txPower', 'retryRate',
  'temperature',
  // Radio metrics — present when device reports signal data
  'rssi', 'snr',
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

// ── WO-034: KPI Operations Summary types ──────────────────────────────────────

export type KpiSeverity = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNAVAILABLE' | 'UNKNOWN';

export interface KpiSummaryCard {
  metric: string;
  displayName: string;
  unit: string;
  currentValue: number | null;
  trend: 'UP' | 'DOWN' | 'STABLE' | 'UNAVAILABLE';
  trendPct: number | null;
  severity: KpiSeverity;
  deviceCount: number;
  /** null means metric not supported for this device mix */
  unsupported: boolean;
  lastUpdated: string | null;
}

export interface DeviceImpactEntry {
  deviceId: string;
  serialNumber: string;
  deviceType: string;
  impactedMetrics: string[];
  worstSeverity: KpiSeverity;
  latencyMs: number | null;
  packetLossPct: number | null;
  availabilityPct: number | null;
  lastObservedAt: string | null;
}

export interface KpiTrendSeries {
  metric: string;
  granularity: Granularity;
  points: Array<{
    bucketStart: string;
    fleetAvg: number | null;
    fleetMin: number | null;
    fleetMax: number | null;
    deviceCount: number;
  }>;
}

export interface KpiOperationsSummaryResponse {
  generatedAt: string;
  timeRange: {
    from: string;
    to: string;
    window: TimeRange;
  };
  summaryCards: KpiSummaryCard[];
  topImpactedDevices: DeviceImpactEntry[];
  trendSeries: KpiTrendSeries[];
  staleData: boolean;
  staleReason?: string;
}

export interface KpiOperationsSummaryRequest {
  timeRange?: TimeRange;
  networkId?: string;
  organizationId?: string;
  deviceType?: string;
  metricGroup?: 'radio' | 'system' | 'traffic' | 'all';
}

/** Maps KpiSeverity to a CSS variable color token. */
export function severityColor(s: KpiSeverity): string {
  switch (s) {
    case 'HEALTHY':     return 'var(--vf-success)';
    case 'DEGRADED':    return 'var(--vf-warning)';
    case 'CRITICAL':    return 'var(--vf-danger)';
    case 'UNAVAILABLE': return 'var(--vf-text-muted)';
    default:            return 'var(--vf-text-dim)';
  }
}

/** Maps KpiSeverity to a badge variant. */
export function severityVariant(s: KpiSeverity): 'success' | 'warning' | 'danger' | 'default' {
  switch (s) {
    case 'HEALTHY':  return 'success';
    case 'DEGRADED': return 'warning';
    case 'CRITICAL': return 'danger';
    default:         return 'default';
  }
}

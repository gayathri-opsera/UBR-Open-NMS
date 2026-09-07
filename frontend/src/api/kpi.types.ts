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

// ── WO-040: KPI Drilldown types ───────────────────────────────────────────────

export type DrilldownGranularity = 'RAW' | '15MIN' | '1HOUR' | 'DAILY';

export interface KpiDrilldownRequest {
  deviceId?: string;
  serialNumber?: string;
  networkId?: string;
  organizationId?: string;
  deviceType?: string;
  discoveryParadigm?: string;
  metricName?: string;
  metricGroup?: 'radio' | 'system' | 'traffic' | 'all';
  from: string;
  to: string;
  granularity: DrilldownGranularity;
}

export interface KpiDrilldownTableRow {
  timestamp: string;
  metricName: string;
  deviceId: string;
  serialNumber: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  unit: string;
  sampleCount: number;
}

export interface KpiDrilldownSeries {
  metricName: string;
  deviceId: string;
  serialNumber: string;
  unit: string;
  supported: boolean;
  unsupportedReason?: string;
  data: Array<{
    bucketStart: string;
    avg: number | null;
    min: number | null;
    max: number | null;
    sampleCount: number;
    stale?: boolean;
  }>;
}

export interface KpiDrilldownResponse {
  query: KpiDrilldownRequest;
  series: KpiDrilldownSeries[];
  tableRows: KpiDrilldownTableRow[];
  supportedGranularities: DrilldownGranularity[];
  units: Record<string, string>;
  generatedAt: string;
  staleData: boolean;
  staleReason?: string;
}

/** Validate that `from` is before `to`. Returns an error message or null. */
export function validateDrilldownTimeRange(from: string, to: string): string | null {
  const fromMs = new Date(from).getTime();
  const toMs   = new Date(to).getTime();
  if (isNaN(fromMs) || isNaN(toMs)) return 'Invalid time range: from and to must be valid ISO timestamps.';
  if (fromMs >= toMs) return 'Invalid time range: start time must be before end time.';
  return null;
}

// ── WO-041: Availability Health State types ───────────────────────────────────

export type AvailabilityHealthState = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';

export interface DeviceAvailabilitySummary {
  deviceId: string;
  serialNumber: string;
  deviceType: string;
  healthState: AvailabilityHealthState;
  primaryReason: string;
  secondaryReasons: string[];
  lastObservedAt: string | null;
  source: 'CALL_HOME' | 'KPI' | 'ALARM' | 'SNMP' | 'UNKNOWN';
  confidence: number;
  stale: boolean;
  dampenedUntil: string | null;
}

export interface AvailabilitySummaryResponse {
  generatedAt: string;
  devices: DeviceAvailabilitySummary[];
}

export interface AvailabilitySummaryRequest {
  deviceId?: string;
  serialNumber?: string;
  networkId?: string;
  organizationId?: string;
  deviceType?: string;
  from?: string;
  to?: string;
}

/** Maps AvailabilityHealthState to a CSS color token. */
export function availabilityStateColor(state: AvailabilityHealthState): string {
  switch (state) {
    case 'UP':       return 'var(--vf-success)';
    case 'DEGRADED': return 'var(--vf-warning)';
    case 'DOWN':     return 'var(--vf-danger)';
    default:         return 'var(--vf-text-muted)';
  }
}

/** Maps AvailabilityHealthState to a badge variant. */
export function availabilityStateBadge(state: AvailabilityHealthState): 'success' | 'warning' | 'danger' | 'default' {
  switch (state) {
    case 'UP':       return 'success';
    case 'DEGRADED': return 'warning';
    case 'DOWN':     return 'danger';
    default:         return 'default';
  }
}

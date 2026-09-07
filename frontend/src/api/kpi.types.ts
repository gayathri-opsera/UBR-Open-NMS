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
  /** Threshold definitions applicable to this metric/device, if provided by the API. */
  thresholds?: KpiThresholdDefinition[];
  /** Breach annotations for this series, if provided by the API. */
  breachAnnotations?: KpiBreachAnnotation[];
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
  /** Fleet-level threshold definitions when returned by the API. */
  thresholds?: KpiThresholdDefinition[];
  /** Active breach summary across all series in this response. */
  activeBreaches?: KpiBreachAnnotation[];
}

/** Validate that `from` is before `to`. Returns an error message or null. */
export function validateDrilldownTimeRange(from: string, to: string): string | null {
  const fromMs = new Date(from).getTime();
  const toMs   = new Date(to).getTime();
  if (isNaN(fromMs) || isNaN(toMs)) return 'Invalid time range: from and to must be valid ISO timestamps.';
  if (fromMs >= toMs) return 'Invalid time range: start time must be before end time.';
  return null;
}

// ── WO-046: Threshold breach visualization types ─────────────────────────────

export type ThresholdSeverity = 'WARNING' | 'CRITICAL';
export type ThresholdOperator  = 'ABOVE' | 'BELOW';

/**
 * A configured threshold definition returned alongside drilldown series data.
 * Multiple thresholds may exist for a single metric — warn + crit, or time-ranged.
 */
export interface KpiThresholdDefinition {
  thresholdId: string;
  metricName: string;
  severity: ThresholdSeverity;
  operator: ThresholdOperator;
  value: number;
  unit: string;
  label?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

/**
 * A single breach annotation at a specific sample timestamp.
 * May reference a related alarm when one exists. Alarm may have cleared
 * since the breach — alarmState reflects the current alarm lifecycle state.
 */
export interface KpiBreachAnnotation {
  timestamp: string;
  value: number;
  thresholdId: string;
  severity: ThresholdSeverity;
  relatedAlarmId?: string;
  alarmState?: 'ACTIVE' | 'CLEARED' | 'SUPPRESSED' | string;
  alarmLabel?: string;
}

/** Canonical threshold values used for breach classification (WO-046). */
export const BREACH_THRESHOLDS = {
  latencyMs: { warn: 100, crit: 200, operator: 'ABOVE' as ThresholdOperator },
  packetLossPct: { warn: 1, crit: 5, operator: 'ABOVE' as ThresholdOperator },
  availabilityPct: { warn: 99.5, crit: 99, operator: 'BELOW' as ThresholdOperator },
} as const;

/**
 * Classify a metric sample against threshold definitions.
 * Returns null when no threshold applies or the value is null.
 */
export function classifyBreach(
  metricName: string,
  value: number | null,
  thresholds: KpiThresholdDefinition[],
): ThresholdSeverity | null {
  if (value === null || value === undefined) return null;
  const relevant = thresholds.filter((t) => t.metricName === metricName);
  if (relevant.length === 0) return null;

  // Highest severity wins when multiple thresholds match
  let result: ThresholdSeverity | null = null;
  for (const t of relevant) {
    const breached = t.operator === 'ABOVE' ? value > t.value : value < t.value;
    if (breached) {
      if (t.severity === 'CRITICAL') return 'CRITICAL';
      if (t.severity === 'WARNING') result = 'WARNING';
    }
  }
  return result;
}

/** Map ThresholdSeverity to a CSS color token. */
export function breachSeverityColor(s: ThresholdSeverity | null): string {
  if (s === 'CRITICAL') return 'var(--vf-danger)';
  if (s === 'WARNING')  return 'var(--vf-warning)';
  return 'var(--vf-text-muted)';
}

/** Map ThresholdSeverity to a badge variant. */
export function breachSeverityVariant(s: ThresholdSeverity | null): 'danger' | 'warning' | 'default' {
  if (s === 'CRITICAL') return 'danger';
  if (s === 'WARNING')  return 'warning';
  return 'default';
}


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

import type {
  KpiOperationsSummaryResponse, KpiSummaryCard, DeviceImpactEntry, KpiTrendSeries,
} from '../api/kpi.types';
import type {
  KpiDataPoint, KpiParam, KpiSeries, TimeRange,
  KpiDrilldownResponse, KpiDrilldownRequest, DrilldownGranularity,
  AvailabilitySummaryResponse,
  KpiThresholdDefinition, KpiBreachAnnotation,
} from '../api/kpi.types';

function generateSeries(
  deviceId: string,
  param: KpiParam,
  timeRange: TimeRange,
  baseValue: number,
  variance: number,
): KpiSeries {
  const nowMs = Date.now();
  const msRange = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }[timeRange];
  const buckets = timeRange === '7d' ? 7 : timeRange === '24h' ? 24 : timeRange === '6h' ? 24 : 12;
  const stepMs = msRange / buckets;
  const granularity = timeRange === '7d' ? 'DAILY' : timeRange === '24h' ? '1HOUR' : '15MIN';

  const data: KpiDataPoint[] = Array.from({ length: buckets }, (_, i) => {
    const base = baseValue + (Math.sin(i / 3) * variance);
    return {
      bucketStart: new Date(nowMs - msRange + i * stepMs).toISOString(),
      avg: parseFloat((base + (Math.random() * variance * 0.2)).toFixed(2)),
      min: parseFloat((base - variance * 0.3).toFixed(2)),
      max: parseFloat((base + variance * 0.5).toFixed(2)),
      sampleCount: 4,
    };
  });

  return { deviceId, param, granularity: granularity as KpiSeries['granularity'], data };
}

export function getMockKpiData(deviceId: string, params: KpiParam[], timeRange: TimeRange = '24h'): KpiSeries[] {
  const config: Record<KpiParam, { base: number; variance: number }> = {
    rssi:               { base: -65, variance: 10 },
    snr:                { base: 22, variance: 5 },
    cpuUtilization:     { base: 45, variance: 20 },
    memoryUtilization:  { base: 60, variance: 15 },
    throughputUL:       { base: 50, variance: 30 },
    throughputDL:       { base: 80, variance: 40 },
    channelUtilization: { base: 35, variance: 20 },
    connectedClients:   { base: 12, variance: 5 },
    txPower:            { base: 20, variance: 3 },
    retryRate:          { base: 2, variance: 3 },
    temperature:        { base: 42, variance: 8 },
  };

  return params.map((p) => generateSeries(deviceId, p, timeRange, config[p].base, config[p].variance));
}

// ── WO-034: KPI Operations Summary deterministic fixtures ─────────────────────

function trendPoint(offsetMs: number, now: number, value: number) {
  return {
    bucketStart: new Date(now - offsetMs).toISOString(),
    fleetAvg: parseFloat(value.toFixed(2)),
    fleetMin: parseFloat((value * 0.85).toFixed(2)),
    fleetMax: parseFloat((value * 1.15).toFixed(2)),
    deviceCount: 12,
  };
}

export function getMockKpiOperationsSummary(
  timeRange: TimeRange = '24h',
): KpiOperationsSummaryResponse {
  const now = Date.now();
  const from = new Date(now - { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }[timeRange]).toISOString();
  const to = new Date(now).toISOString();

  const summaryCards: KpiSummaryCard[] = [
    {
      metric: 'availability', displayName: 'Fleet Availability', unit: '%',
      currentValue: 98.4, trend: 'DOWN', trendPct: -0.8,
      severity: 'HEALTHY', deviceCount: 42, unsupported: false,
      lastUpdated: new Date(now - 120_000).toISOString(),
    },
    {
      metric: 'latencyMs', displayName: 'Avg Latency', unit: 'ms',
      currentValue: 12.4, trend: 'UP', trendPct: 4.2,
      severity: 'HEALTHY', deviceCount: 42, unsupported: false,
      lastUpdated: new Date(now - 120_000).toISOString(),
    },
    {
      metric: 'throughputDL', displayName: 'DL Throughput', unit: 'Mbps',
      currentValue: 76.2, trend: 'STABLE', trendPct: 0.1,
      severity: 'HEALTHY', deviceCount: 42, unsupported: false,
      lastUpdated: new Date(now - 120_000).toISOString(),
    },
    {
      metric: 'throughputUL', displayName: 'UL Throughput', unit: 'Mbps',
      currentValue: 42.7, trend: 'DOWN', trendPct: -1.2,
      severity: 'DEGRADED', deviceCount: 42, unsupported: false,
      lastUpdated: new Date(now - 120_000).toISOString(),
    },
    {
      metric: 'cpuUtilization', displayName: 'CPU Utilization', unit: '%',
      currentValue: 68.3, trend: 'UP', trendPct: 12.1,
      severity: 'DEGRADED', deviceCount: 38, unsupported: false,
      lastUpdated: new Date(now - 180_000).toISOString(),
    },
    {
      metric: 'memoryUtilization', displayName: 'Memory Utilization', unit: '%',
      currentValue: 71.5, trend: 'STABLE', trendPct: 0.4,
      severity: 'HEALTHY', deviceCount: 38, unsupported: false,
      lastUpdated: new Date(now - 180_000).toISOString(),
    },
    {
      metric: 'packetLossPct', displayName: 'Packet Loss', unit: '%',
      currentValue: 2.7, trend: 'UP', trendPct: 35.0,
      severity: 'CRITICAL', deviceCount: 3, unsupported: false,
      lastUpdated: new Date(now - 60_000).toISOString(),
    },
    {
      // IDU-class devices don't support radio metrics — must show as unavailable/unsupported
      metric: 'rssi', displayName: 'RSSI', unit: 'dBm',
      currentValue: null, trend: 'UNAVAILABLE', trendPct: null,
      severity: 'UNAVAILABLE', deviceCount: 0, unsupported: true,
      lastUpdated: null,
    },
  ];

  const topImpactedDevices: DeviceImpactEntry[] = [
    {
      deviceId: 'dev-bts-degraded-001', serialNumber: 'SN-BTS-001',
      deviceType: 'BTS', impactedMetrics: ['cpuUtilization', 'throughputUL'],
      worstSeverity: 'DEGRADED', latencyMs: 18.2, packetLossPct: 0.4,
      availabilityPct: 97.1, lastObservedAt: new Date(now - 90_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-critical-001', serialNumber: 'SN-CPE-001',
      deviceType: 'CPE', impactedMetrics: ['packetLossPct', 'throughputDL', 'latencyMs'],
      worstSeverity: 'CRITICAL', latencyMs: 88.4, packetLossPct: 4.2,
      availabilityPct: 89.3, lastObservedAt: new Date(now - 300_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-critical-002', serialNumber: 'SN-CPE-002',
      deviceType: 'CPE', impactedMetrics: ['packetLossPct'],
      worstSeverity: 'CRITICAL', latencyMs: 55.1, packetLossPct: 3.9,
      availabilityPct: 92.0, lastObservedAt: new Date(now - 150_000).toISOString(),
    },
    {
      deviceId: 'dev-idu-001', serialNumber: 'SN-IDU-001',
      deviceType: 'IDU', impactedMetrics: ['memoryUtilization'],
      worstSeverity: 'DEGRADED', latencyMs: null, packetLossPct: null,
      availabilityPct: 99.1, lastObservedAt: new Date(now - 600_000).toISOString(),
    },
    {
      deviceId: 'dev-generic-001', serialNumber: 'GENERIC-IP-10.0.1.1',
      deviceType: 'GENERIC', impactedMetrics: ['cpuUtilization', 'memoryUtilization'],
      worstSeverity: 'DEGRADED', latencyMs: 24.0, packetLossPct: 0.8,
      availabilityPct: 96.5, lastObservedAt: new Date(now - 200_000).toISOString(),
    },
  ];

  const bucketCount = timeRange === '7d' ? 7 : 24;
  const stepMs = { '1h': 300_000, '6h': 900_000, '24h': 3_600_000, '7d': 86_400_000 }[timeRange];
  const trendSeries: KpiTrendSeries[] = [
    {
      metric: 'availability',
      granularity: timeRange === '7d' ? 'DAILY' : '1HOUR',
      points: Array.from({ length: bucketCount }, (_, i) =>
        trendPoint((bucketCount - i) * stepMs, now, 98.2 + Math.sin(i / 4) * 1.2)),
    },
    {
      metric: 'throughputDL',
      granularity: timeRange === '7d' ? 'DAILY' : '1HOUR',
      points: Array.from({ length: bucketCount }, (_, i) =>
        trendPoint((bucketCount - i) * stepMs, now, 74 + Math.sin(i / 3) * 8)),
    },
    {
      metric: 'cpuUtilization',
      granularity: timeRange === '7d' ? 'DAILY' : '1HOUR',
      points: Array.from({ length: bucketCount }, (_, i) =>
        trendPoint((bucketCount - i) * stepMs, now, 60 + i * 0.5)),
    },
  ];

  return {
    generatedAt: to,
    timeRange: { from, to, window: timeRange },
    summaryCards,
    topImpactedDevices,
    trendSeries,
    staleData: false,
  };
}

/** Stale data fixture — for testing stale-data warning banner. */
export function getMockKpiOperationsSummaryStale(): KpiOperationsSummaryResponse {
  const base = getMockKpiOperationsSummary('24h');
  return {
    ...base,
    staleData: true,
    staleReason: 'KPI aggregation service last updated 8 minutes ago; some metrics may be outdated.',
    summaryCards: base.summaryCards.map((c) => ({
      ...c,
      lastUpdated: new Date(Date.now() - 8 * 60_000).toISOString(),
    })),
  };
}

/** Empty fixture — for testing empty state rendering. */
export const MOCK_KPI_OPERATIONS_SUMMARY_EMPTY: KpiOperationsSummaryResponse = {
  generatedAt: new Date().toISOString(),
  timeRange: { from: new Date().toISOString(), to: new Date().toISOString(), window: '24h' },
  summaryCards: [],
  topImpactedDevices: [],
  trendSeries: [],
  staleData: false,
};

// ── WO-040: KPI Drilldown fixtures ────────────────────────────────────────────

function makeDrilldownSeries(
  metricName: string,
  deviceId: string,
  serialNumber: string,
  unit: string,
  granularity: DrilldownGranularity,
  from: string,
  to: string,
  baseValue: number,
  variance: number,
  supported = true,
  unsupportedReason?: string,
) {
  if (!supported) {
    return { metricName, deviceId, serialNumber, unit, supported: false, unsupportedReason, data: [] };
  }
  const intervalMs: Record<DrilldownGranularity, number> = {
    RAW: 60_000, '15MIN': 900_000, '1HOUR': 3_600_000, DAILY: 86_400_000,
  };
  const fromMs = new Date(from).getTime();
  const toMs   = new Date(to).getTime();
  const stepMs = intervalMs[granularity];
  const count  = Math.min(Math.ceil((toMs - fromMs) / stepMs), 48);
  const data = Array.from({ length: count }, (_, i) => ({
    bucketStart: new Date(fromMs + i * stepMs).toISOString(),
    avg: parseFloat((baseValue + Math.sin(i / 4) * variance).toFixed(2)),
    min: parseFloat((baseValue + Math.sin(i / 4) * variance - variance * 0.3).toFixed(2)),
    max: parseFloat((baseValue + Math.sin(i / 4) * variance + variance * 0.3).toFixed(2)),
    sampleCount: 4,
    stale: i === 3,
  }));
  return { metricName, deviceId, serialNumber, unit, supported: true, data };
}

function buildDrilldownResponse(
  req: KpiDrilldownRequest,
  deviceId: string,
  serialNumber: string,
  deviceType: string,
): KpiDrilldownResponse {
  const gran = req.granularity;
  const from = req.from;
  const to   = req.to;

  const metrics = req.metricName
    ? [req.metricName]
    : ['cpuUtilization', 'memoryUtilization', 'throughputDL', 'throughputUL', 'rssi'];

  // IDU does not support radio metrics
  const iduUnsupported = new Set(['rssi', 'snr', 'txPower']);
  const unitMap: Record<string, string> = {
    cpuUtilization: '%', memoryUtilization: '%', throughputDL: 'Mbps', throughputUL: 'Mbps',
    rssi: 'dBm', snr: 'dB', latencyMs: 'ms', packetLossPct: '%', txPower: 'dBm',
    channelUtilization: '%', connectedClients: '', retryRate: '%', temperature: '°C',
  };
  const baseMap: Record<string, { base: number; variance: number }> = {
    cpuUtilization: { base: 55, variance: 15 }, memoryUtilization: { base: 62, variance: 10 },
    throughputDL: { base: 76, variance: 20 }, throughputUL: { base: 42, variance: 15 },
    rssi: { base: -65, variance: 8 }, snr: { base: 22, variance: 5 },
    latencyMs: { base: 12, variance: 5 }, packetLossPct: { base: 0.8, variance: 0.5 },
    txPower: { base: 20, variance: 2 }, channelUtilization: { base: 35, variance: 12 },
    connectedClients: { base: 12, variance: 4 }, retryRate: { base: 2, variance: 2 },
    temperature: { base: 42, variance: 6 },
  };

  const series = metrics.map((m) => {
    const isUnsupported = deviceType === 'IDU' && iduUnsupported.has(m);
    const cfg = baseMap[m] ?? { base: 50, variance: 10 };
    return makeDrilldownSeries(
      m, deviceId, serialNumber, unitMap[m] ?? '', gran, from, to,
      cfg.base, cfg.variance, !isUnsupported,
      isUnsupported ? `IDU devices do not report ${m}` : undefined,
    );
  });

  const tableRows = series
    .filter((s) => s.supported && s.data.length > 0)
    .flatMap((s) =>
      s.data.map((p) => ({
        timestamp: p.bucketStart,
        metricName: s.metricName,
        deviceId: s.deviceId,
        serialNumber: s.serialNumber,
        avg: p.avg,
        min: p.min,
        max: p.max,
        unit: unitMap[s.metricName] ?? '',
        sampleCount: p.sampleCount,
      })),
    );

  return {
    query: req,
    series,
    tableRows,
    supportedGranularities: ['RAW', '15MIN', '1HOUR', 'DAILY'],
    units: unitMap,
    generatedAt: new Date().toISOString(),
    staleData: false,
  };
}

/** BTS drilldown — 1HOUR granularity for radio and system metrics. */
export function getMockKpiDrilldownBts(metricName?: string): KpiDrilldownResponse {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to   = new Date().toISOString();
  const req: KpiDrilldownRequest = {
    deviceId: 'dev-bts-001', from, to, granularity: '1HOUR',
    deviceType: 'BTS', discoveryParadigm: 'UBR_CALL_HOME',
    metricName,
  };
  return buildDrilldownResponse(req, 'dev-bts-001', 'SN-BTS-001', 'BTS');
}

/** CPE drilldown — 15MIN granularity. */
export function getMockKpiDrilldownCpe(): KpiDrilldownResponse {
  const from = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const to   = new Date().toISOString();
  const req: KpiDrilldownRequest = {
    deviceId: 'dev-cpe-critical-001', from, to, granularity: '15MIN',
    deviceType: 'CPE', discoveryParadigm: 'UBR_CALL_HOME',
  };
  return buildDrilldownResponse(req, 'dev-cpe-critical-001', 'SN-CPE-001', 'CPE');
}

/** IDU drilldown — radio metrics marked unsupported. */
export function getMockKpiDrilldownIdu(): KpiDrilldownResponse {
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const to   = new Date().toISOString();
  const req: KpiDrilldownRequest = {
    deviceId: 'dev-idu-001', from, to, granularity: 'DAILY',
    deviceType: 'IDU',
  };
  return buildDrilldownResponse(req, 'dev-idu-001', 'SN-IDU-001', 'IDU');
}

/** Generic device drilldown — SNMP-polled device. */
export function getMockKpiDrilldownGeneric(): KpiDrilldownResponse {
  const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const to   = new Date().toISOString();
  const req: KpiDrilldownRequest = {
    networkId: 'net-001', from, to, granularity: '1HOUR',
    deviceType: 'GENERIC', discoveryParadigm: 'GENERIC_SNMP',
  };
  return buildDrilldownResponse(req, 'dev-generic-001', 'GENERIC-IP-10.0.1.1', 'GENERIC');
}

/** Empty drilldown — no matching metrics. */
export const MOCK_KPI_DRILLDOWN_EMPTY: KpiDrilldownResponse = {
  query: {
    deviceId: 'dev-unknown-999',
    from: new Date(Date.now() - 3_600_000).toISOString(),
    to: new Date().toISOString(),
    granularity: '1HOUR',
  },
  series: [],
  tableRows: [],
  supportedGranularities: ['RAW', '15MIN', '1HOUR', 'DAILY'],
  units: {},
  generatedAt: new Date().toISOString(),
  staleData: false,
};

/** Stale drilldown — for testing stale-data warning. */
export function getMockKpiDrilldownStale(): KpiDrilldownResponse {
  const base = getMockKpiDrilldownBts();
  return {
    ...base,
    staleData: true,
    staleReason: 'KPI aggregation last updated 12 minutes ago; some buckets may be incomplete.',
  };
}

// ── WO-041: Availability health state fixtures ────────────────────────────────

export const MOCK_AVAILABILITY_SUMMARY: AvailabilitySummaryResponse = {
  generatedAt: new Date().toISOString(),
  devices: [
    {
      deviceId: 'dev-bts-001', serialNumber: 'SN-BTS-001', deviceType: 'BTS',
      healthState: 'UP', primaryReason: 'All KPI metrics within normal thresholds',
      secondaryReasons: [], source: 'KPI', confidence: 0.97, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(Date.now() - 90_000).toISOString(),
    },
    {
      deviceId: 'dev-bts-degraded-001', serialNumber: 'SN-BTS-002', deviceType: 'BTS',
      healthState: 'DEGRADED', primaryReason: 'CPU utilization elevated (68%)',
      secondaryReasons: ['UL throughput trending down'], source: 'KPI', confidence: 0.82, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-critical-001', serialNumber: 'SN-CPE-001', deviceType: 'CPE',
      healthState: 'DOWN', primaryReason: 'Critical alarm: packet loss 4.2%',
      secondaryReasons: ['Latency 88ms above threshold', 'Availability below 90%'],
      source: 'ALARM', confidence: 0.99, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(Date.now() - 300_000).toISOString(),
    },
    {
      deviceId: 'dev-idu-001', serialNumber: 'SN-IDU-001', deviceType: 'IDU',
      healthState: 'DEGRADED', primaryReason: 'Memory utilization near threshold (71%)',
      secondaryReasons: [], source: 'KPI', confidence: 0.76, stale: false, dampenedUntil: null,
      lastObservedAt: new Date(Date.now() - 600_000).toISOString(),
    },
    {
      deviceId: 'dev-generic-001', serialNumber: 'GENERIC-IP-10.0.1.1', deviceType: 'GENERIC',
      healthState: 'UNKNOWN', primaryReason: 'No KPI data in last 15 minutes',
      secondaryReasons: ['SNMP poll may be failing'], source: 'UNKNOWN', confidence: 0.3, stale: true, dampenedUntil: null,
      lastObservedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    },
    {
      deviceId: 'dev-bts-flapping-001', serialNumber: 'SN-BTS-FLAP-001', deviceType: 'BTS',
      healthState: 'DEGRADED',
      primaryReason: 'Flap dampening active: device alternating UP/DOWN rapidly',
      secondaryReasons: ['Last DOWN event: 2 minutes ago'], source: 'KPI', confidence: 0.6, stale: false,
      dampenedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
      lastObservedAt: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      deviceId: 'dev-cpe-new-001', serialNumber: 'SN-CPE-NEW-001', deviceType: 'CPE',
      healthState: 'UNKNOWN', primaryReason: 'Newly onboarded device — no KPI history yet',
      secondaryReasons: [], source: 'UNKNOWN', confidence: 0.0, stale: false, dampenedUntil: null,
      lastObservedAt: null,
    },
  ],
};

// ── WO-046: Threshold breach visualization fixtures ───────────────────────────

/** No-threshold scenario: drilldown response with no threshold data. */
export function getMockKpiDrilldownNoThreshold(): KpiDrilldownResponse {
  const base = getMockKpiDrilldownBts();
  return { ...base, thresholds: undefined, activeBreaches: undefined };
}

/** Warning-threshold scenario: latency above 100ms warn level. */
export const MOCK_THRESHOLD_LATENCY_WARN: KpiThresholdDefinition = {
  thresholdId: 'thr-latency-warn',
  metricName: 'latencyMs',
  severity: 'WARNING',
  operator: 'ABOVE',
  value: 100,
  unit: 'ms',
  label: 'Latency Warning',
};

/** Critical-threshold scenario: latency above 200ms crit level. */
export const MOCK_THRESHOLD_LATENCY_CRIT: KpiThresholdDefinition = {
  thresholdId: 'thr-latency-crit',
  metricName: 'latencyMs',
  severity: 'CRITICAL',
  operator: 'ABOVE',
  value: 200,
  unit: 'ms',
  label: 'Latency Critical',
};

/** Packet-loss warning threshold: above 1%. */
export const MOCK_THRESHOLD_PACKET_LOSS_WARN: KpiThresholdDefinition = {
  thresholdId: 'thr-pkt-warn',
  metricName: 'packetLossPct',
  severity: 'WARNING',
  operator: 'ABOVE',
  value: 1,
  unit: '%',
  label: 'Packet Loss Warning',
};

/** Packet-loss critical threshold: above 5%. */
export const MOCK_THRESHOLD_PACKET_LOSS_CRIT: KpiThresholdDefinition = {
  thresholdId: 'thr-pkt-crit',
  metricName: 'packetLossPct',
  severity: 'CRITICAL',
  operator: 'ABOVE',
  value: 5,
  unit: '%',
  label: 'Packet Loss Critical',
};

/** Availability warning threshold: below 99.5%. */
export const MOCK_THRESHOLD_AVAIL_WARN: KpiThresholdDefinition = {
  thresholdId: 'thr-avail-warn',
  metricName: 'availabilityPct',
  severity: 'WARNING',
  operator: 'BELOW',
  value: 99.5,
  unit: '%',
  label: 'Availability Warning',
};

/** Breach annotation: warning-level breach without an active alarm (alarm cleared). */
export const MOCK_BREACH_WARN_NO_ALARM: KpiBreachAnnotation = {
  timestamp: new Date(Date.now() - 600_000).toISOString(),
  value: 115,
  thresholdId: 'thr-latency-warn',
  severity: 'WARNING',
  relatedAlarmId: 'alm-cleared-001',
  alarmState: 'CLEARED',
  alarmLabel: 'Latency Warning — cleared',
};

/** Breach annotation: critical-level breach with an active alarm. */
export const MOCK_BREACH_CRIT_WITH_ALARM: KpiBreachAnnotation = {
  timestamp: new Date(Date.now() - 120_000).toISOString(),
  value: 245,
  thresholdId: 'thr-latency-crit',
  severity: 'CRITICAL',
  relatedAlarmId: 'alm-active-001',
  alarmState: 'ACTIVE',
  alarmLabel: 'CRITICAL: Latency 245ms exceeds 200ms threshold',
};

/** Breach annotation: breach with no alarm (alarm was suppressed or never created). */
export const MOCK_BREACH_NO_ALARM: KpiBreachAnnotation = {
  timestamp: new Date(Date.now() - 300_000).toISOString(),
  value: 3.2,
  thresholdId: 'thr-pkt-warn',
  severity: 'WARNING',
};

/** Multi-threshold drilldown: latency with warning + critical thresholds and active breaches. */
export function getMockKpiDrilldownWithBreaches(): KpiDrilldownResponse {
  const base = getMockKpiDrilldownBts();
  const allThresholds: KpiThresholdDefinition[] = [
    MOCK_THRESHOLD_LATENCY_WARN,
    MOCK_THRESHOLD_LATENCY_CRIT,
    MOCK_THRESHOLD_PACKET_LOSS_WARN,
    MOCK_THRESHOLD_PACKET_LOSS_CRIT,
    MOCK_THRESHOLD_AVAIL_WARN,
  ];
  return {
    ...base,
    thresholds: allThresholds,
    activeBreaches: [MOCK_BREACH_WARN_NO_ALARM, MOCK_BREACH_CRIT_WITH_ALARM, MOCK_BREACH_NO_ALARM],
    series: base.series.map((s) => ({
      ...s,
      thresholds: allThresholds.filter((t) => t.metricName === s.metricName),
      breachAnnotations: [MOCK_BREACH_CRIT_WITH_ALARM].filter((b) =>
        allThresholds.some((t) => t.thresholdId === b.thresholdId && t.metricName === s.metricName),
      ),
    })),
  };
}

/** Drilldown where threshold units differ from display units — must not crash. */
export function getMockKpiDrilldownMismatchedUnits(): KpiDrilldownResponse {
  const base = getMockKpiDrilldownBts();
  return {
    ...base,
    thresholds: [{
      thresholdId: 'thr-mismatched',
      metricName: 'latencyMs',
      severity: 'WARNING',
      operator: 'ABOVE',
      value: 100,
      unit: 's', // intentional mismatch vs ms display
      label: 'Latency (s) — unit mismatch test',
    }],
  };
}

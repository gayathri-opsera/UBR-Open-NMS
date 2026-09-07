import type {
  KpiOperationsSummaryResponse, KpiSummaryCard, DeviceImpactEntry, KpiTrendSeries,
} from '../api/kpi.types';
import type { KpiDataPoint, KpiParam, KpiSeries, TimeRange } from '../api/kpi.types';

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

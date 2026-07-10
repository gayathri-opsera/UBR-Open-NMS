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

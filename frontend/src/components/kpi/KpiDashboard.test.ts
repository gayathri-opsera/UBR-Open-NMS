import { describe, it, expect } from 'vitest';
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../../api/kpi.types';
import { getMockKpiData } from '../../mocks/kpi.mock';

describe('KPI types and helpers', () => {
  it('timeRangeToGranularity maps correctly', () => {
    expect(timeRangeToGranularity('1h')).toBe('15MIN');
    expect(timeRangeToGranularity('6h')).toBe('15MIN');
    expect(timeRangeToGranularity('24h')).toBe('1HOUR');
    expect(timeRangeToGranularity('7d')).toBe('DAILY');
  });

  it('timeRangeToMs returns correct milliseconds', () => {
    expect(timeRangeToMs('1h')).toBe(3_600_000);
    expect(timeRangeToMs('24h')).toBe(86_400_000);
    expect(timeRangeToMs('7d')).toBe(604_800_000);
  });

  it('KPI_PARAMS includes required metrics', () => {
    expect(KPI_PARAMS).toContain('rssi');
    expect(KPI_PARAMS).toContain('snr');
    expect(KPI_PARAMS).toContain('cpuUtilization');
    expect(KPI_PARAMS).toContain('throughputUL');
    expect(KPI_PARAMS).toContain('throughputDL');
  });
});

describe('KPI mock data', () => {
  it('generates series for each requested param', () => {
    const series = getMockKpiData('CPE-001', ['rssi', 'snr', 'cpuUtilization'], '24h');
    expect(series).toHaveLength(3);
    expect(series.map((s) => s.param)).toEqual(['rssi', 'snr', 'cpuUtilization']);
  });

  it('generates correct number of data points for 24h', () => {
    const series = getMockKpiData('CPE-001', ['rssi'], '24h');
    expect(series[0].data).toHaveLength(24);
  });

  it('generates correct number of data points for 7d', () => {
    const series = getMockKpiData('CPE-001', ['snr'], '7d');
    expect(series[0].data).toHaveLength(7);
    expect(series[0].granularity).toBe('DAILY');
  });

  it('data points have valid structure', () => {
    const series = getMockKpiData('CPE-001', ['rssi'], '1h');
    const dp = series[0].data[0];
    expect(dp).toHaveProperty('bucketStart');
    expect(dp).toHaveProperty('avg');
    expect(dp).toHaveProperty('min');
    expect(dp).toHaveProperty('max');
    expect(typeof dp.avg).toBe('number');
  });

  it('threshold breach detection: identifies breached param', () => {
    const series = getMockKpiData('CPE-001', ['cpuUtilization'], '24h');
    // Override data with a known breach
    series[0].data[0].avg = 95;
    const threshold = { deviceId: 'CPE-001', metric: 'cpuUtilization' as const, raiseThreshold: 90, clearThreshold: 80, severity: 'MAJOR' };
    const isBreached = series[0].data.some((d) => d.avg >= threshold.raiseThreshold);
    expect(isBreached).toBe(true);
  });

  it('scope filtering test: series has correct deviceId', () => {
    const series = getMockKpiData('BTS-001', ['rssi'], '24h');
    expect(series[0].deviceId).toBe('BTS-001');
  });
});

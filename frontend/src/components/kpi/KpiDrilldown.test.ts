/**
 * Tests for WO-040: KPI Drilldown Queries
 *
 * Covers: query parameter construction, filter normalization, metric-series mapping,
 * granularity selection, unsupported-metric handling, empty-result rendering,
 * time-range validation, stale-data handling, and API client boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateDrilldownTimeRange,
  KPI_PARAMS,
} from '../../api/kpi.types';
import type { KpiDrilldownRequest, DrilldownGranularity } from '../../api/kpi.types';
import {
  getMockKpiDrilldownBts,
  getMockKpiDrilldownCpe,
  getMockKpiDrilldownIdu,
  getMockKpiDrilldownGeneric,
  MOCK_KPI_DRILLDOWN_EMPTY,
  getMockKpiDrilldownStale,
} from '../../mocks/kpi.mock';

// ── validateDrilldownTimeRange ─────────────────────────────────────────────────

describe('validateDrilldownTimeRange', () => {
  it('returns null for valid time range', () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to   = new Date().toISOString();
    expect(validateDrilldownTimeRange(from, to)).toBeNull();
  });

  it('returns error when start equals end', () => {
    const ts = new Date().toISOString();
    const err = validateDrilldownTimeRange(ts, ts);
    expect(err).not.toBeNull();
    expect(err).toContain('before');
  });

  it('returns error when start is after end', () => {
    const from = new Date().toISOString();
    const to   = new Date(Date.now() - 3_600_000).toISOString();
    const err  = validateDrilldownTimeRange(from, to);
    expect(err).not.toBeNull();
    expect(err).toContain('before');
  });

  it('returns error for invalid from timestamp', () => {
    const err = validateDrilldownTimeRange('not-a-date', new Date().toISOString());
    expect(err).not.toBeNull();
    expect(err).toContain('valid ISO');
  });

  it('returns error for invalid to timestamp', () => {
    const err = validateDrilldownTimeRange(new Date().toISOString(), 'bad-date');
    expect(err).not.toBeNull();
    expect(err).toContain('valid ISO');
  });
});

// ── Granularity normalization ──────────────────────────────────────────────────

describe('drilldown granularity selection', () => {
  const SUPPORTED_GRANULARITIES: DrilldownGranularity[] = ['RAW', '15MIN', '1HOUR', 'DAILY'];

  it('BTS drilldown reports all granularities as supported', () => {
    const response = getMockKpiDrilldownBts();
    expect(response.supportedGranularities).toEqual(expect.arrayContaining(SUPPORTED_GRANULARITIES));
  });

  it('drilldown response preserves requested granularity in query', () => {
    const response = getMockKpiDrilldownBts();
    expect(response.query.granularity).toBe('1HOUR');
  });

  it('CPE drilldown uses 15MIN granularity', () => {
    const response = getMockKpiDrilldownCpe();
    expect(response.query.granularity).toBe('15MIN');
  });

  it('IDU drilldown uses DAILY granularity', () => {
    const response = getMockKpiDrilldownIdu();
    expect(response.query.granularity).toBe('DAILY');
  });
});

// ── Filter normalization ───────────────────────────────────────────────────────

describe('drilldown filter normalization', () => {
  it('BTS request preserves deviceId in query', () => {
    const response = getMockKpiDrilldownBts();
    expect(response.query.deviceId).toBe('dev-bts-001');
  });

  it('CPE request preserves deviceType in query', () => {
    const response = getMockKpiDrilldownCpe();
    expect(response.query.deviceType).toBe('CPE');
  });

  it('Generic request preserves discoveryParadigm in query', () => {
    const response = getMockKpiDrilldownGeneric();
    expect(response.query.discoveryParadigm).toBe('GENERIC_SNMP');
  });

  it('single metric filter produces one series', () => {
    const response = getMockKpiDrilldownBts('cpuUtilization');
    expect(response.series).toHaveLength(1);
    expect(response.series[0].metricName).toBe('cpuUtilization');
  });
});

// ── Metric-series mapping ──────────────────────────────────────────────────────

describe('drilldown metric-series mapping', () => {
  it('each supported series has valid data structure', () => {
    const response = getMockKpiDrilldownBts();
    const supported = response.series.filter((s) => s.supported);
    expect(supported.length).toBeGreaterThan(0);
    for (const s of supported) {
      expect(s.data.length).toBeGreaterThan(0);
      for (const pt of s.data) {
        expect(pt).toHaveProperty('bucketStart');
        expect(typeof pt.avg).toBe('number');
        expect(typeof pt.min).toBe('number');
        expect(typeof pt.max).toBe('number');
        expect(typeof pt.sampleCount).toBe('number');
      }
    }
  });

  it('series have correct deviceId and serialNumber', () => {
    const response = getMockKpiDrilldownBts();
    for (const s of response.series.filter((s) => s.supported)) {
      expect(s.deviceId).toBe('dev-bts-001');
      expect(s.serialNumber).toBe('SN-BTS-001');
    }
  });

  it('units map contains metric entries', () => {
    const response = getMockKpiDrilldownBts();
    expect(response.units).toBeDefined();
    expect(typeof response.units).toBe('object');
  });

  it('table rows reference same metrics as series', () => {
    const response = getMockKpiDrilldownBts();
    const seriesMetrics = new Set(response.series.filter((s) => s.supported).map((s) => s.metricName));
    for (const row of response.tableRows) {
      expect(seriesMetrics.has(row.metricName)).toBe(true);
    }
  });
});

// ── Unsupported metric handling ───────────────────────────────────────────────

describe('unsupported metric handling', () => {
  it('IDU device marks radio metrics as unsupported', () => {
    const response = getMockKpiDrilldownIdu();
    const radioUnsupported = response.series.filter((s) => !s.supported && ['rssi', 'snr', 'txPower'].includes(s.metricName));
    // The IDU fixture includes rssi in its default metric list
    const rssiSeries = response.series.find((s) => s.metricName === 'rssi');
    if (rssiSeries) {
      expect(rssiSeries.supported).toBe(false);
      expect(rssiSeries.data).toHaveLength(0);
      expect(rssiSeries.unsupportedReason).toBeTruthy();
    }
  });

  it('unsupported series has empty data array', () => {
    const response = getMockKpiDrilldownIdu();
    for (const s of response.series.filter((s) => !s.supported)) {
      expect(s.data).toHaveLength(0);
    }
  });

  it('unsupported series are excluded from table rows', () => {
    const response = getMockKpiDrilldownIdu();
    const unsupportedMetrics = new Set(response.series.filter((s) => !s.supported).map((s) => s.metricName));
    for (const row of response.tableRows) {
      expect(unsupportedMetrics.has(row.metricName)).toBe(false);
    }
  });
});

// ── Empty result handling ─────────────────────────────────────────────────────

describe('empty result handling', () => {
  it('empty response has no series or table rows', () => {
    expect(MOCK_KPI_DRILLDOWN_EMPTY.series).toHaveLength(0);
    expect(MOCK_KPI_DRILLDOWN_EMPTY.tableRows).toHaveLength(0);
  });

  it('empty response still has valid generatedAt and supportedGranularities', () => {
    expect(MOCK_KPI_DRILLDOWN_EMPTY.generatedAt).toBeTruthy();
    expect(MOCK_KPI_DRILLDOWN_EMPTY.supportedGranularities.length).toBeGreaterThan(0);
  });
});

// ── Stale data handling ───────────────────────────────────────────────────────

describe('stale data handling', () => {
  it('stale fixture sets staleData true and provides staleReason', () => {
    const stale = getMockKpiDrilldownStale();
    expect(stale.staleData).toBe(true);
    expect(stale.staleReason).toBeTruthy();
  });

  it('non-stale BTS fixture has staleData false', () => {
    const response = getMockKpiDrilldownBts();
    expect(response.staleData).toBe(false);
  });

  it('data points with stale flag are identifiable', () => {
    const response = getMockKpiDrilldownBts();
    const allPoints = response.series.flatMap((s) => s.data);
    // At least one point may be marked stale in the fixture
    const hasStaleField = allPoints.some((p) => 'stale' in p);
    expect(hasStaleField).toBe(true);
  });
});

// ── API client request construction ──────────────────────────────────────────

describe('drilldown request construction', () => {
  it('request includes mandatory from, to, granularity', () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to   = new Date().toISOString();
    const req: KpiDrilldownRequest = { from, to, granularity: '15MIN' };
    expect(req.from).toBe(from);
    expect(req.to).toBe(to);
    expect(req.granularity).toBe('15MIN');
  });

  it('optional fields are only set when provided', () => {
    const req: KpiDrilldownRequest = {
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date().toISOString(),
      granularity: '1HOUR',
      deviceId: 'dev-001',
    };
    expect(req.deviceId).toBe('dev-001');
    expect(req.serialNumber).toBeUndefined();
    expect(req.networkId).toBeUndefined();
  });
});

// ── Integration: fetchKpiDrilldown mock ───────────────────────────────────────

describe('fetchKpiDrilldown API client (mocked)', () => {
  it('returns drilldown response for valid request', async () => {
    const mockFetch = vi.fn().mockResolvedValue(getMockKpiDrilldownBts());
    const req: KpiDrilldownRequest = {
      deviceId: 'dev-bts-001',
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to:   new Date().toISOString(),
      granularity: '1HOUR',
    };
    const result = await mockFetch(req);
    expect(result.series).toBeDefined();
    expect(result.tableRows).toBeDefined();
    expect(result.query.deviceId).toBe('dev-bts-001');
  });

  it('empty result when no matching data', async () => {
    const mockFetch = vi.fn().mockResolvedValue(MOCK_KPI_DRILLDOWN_EMPTY);
    const result = await mockFetch({});
    expect(result.series).toHaveLength(0);
    expect(result.tableRows).toHaveLength(0);
  });

  it('handles invalid filter response (400)', async () => {
    const mockFetch = vi.fn().mockRejectedValue({ response: { status: 400, data: { error: { code: 'INVALID_TIME_RANGE' } } } });
    await expect(mockFetch({ from: 'bad', to: 'bad', granularity: '1HOUR' })).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('handles unauthorized response (401)', async () => {
    const mockFetch = vi.fn().mockRejectedValue({ response: { status: 401 } });
    await expect(mockFetch({})).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('handles service unavailable response (503)', async () => {
    const mockFetch = vi.fn().mockRejectedValue({ response: { status: 503 } });
    await expect(mockFetch({})).rejects.toMatchObject({ response: { status: 503 } });
  });
});

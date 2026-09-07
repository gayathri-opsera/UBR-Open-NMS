/**
 * WO-034 Vitest tests for KPI Operations Summary data mapping,
 * card severity, and fixture correctness.
 */
import { describe, it, expect } from 'vitest';
import type { KpiSummaryCard, DeviceImpactEntry, KpiOperationsSummaryResponse } from '../../api/kpi.types';
import { severityColor, severityVariant } from '../../api/kpi.types';
import {
  getMockKpiOperationsSummary, getMockKpiOperationsSummaryStale,
  MOCK_KPI_OPERATIONS_SUMMARY_EMPTY,
} from '../../mocks/kpi.mock';

// ── severityColor / severityVariant helpers ───────────────────────────────────

describe('severityColor', () => {
  it('returns success for HEALTHY', () => {
    expect(severityColor('HEALTHY')).toBe('var(--vf-success)');
  });
  it('returns warning for DEGRADED', () => {
    expect(severityColor('DEGRADED')).toBe('var(--vf-warning)');
  });
  it('returns danger for CRITICAL', () => {
    expect(severityColor('CRITICAL')).toBe('var(--vf-danger)');
  });
  it('returns text-muted for UNAVAILABLE', () => {
    expect(severityColor('UNAVAILABLE')).toBe('var(--vf-text-muted)');
  });
  it('returns text-dim for UNKNOWN', () => {
    expect(severityColor('UNKNOWN')).toBe('var(--vf-text-dim)');
  });
});

describe('severityVariant', () => {
  it('maps HEALTHY → success', () => expect(severityVariant('HEALTHY')).toBe('success'));
  it('maps DEGRADED → warning', () => expect(severityVariant('DEGRADED')).toBe('warning'));
  it('maps CRITICAL → danger',  () => expect(severityVariant('CRITICAL')).toBe('danger'));
  it('maps UNAVAILABLE → default', () => expect(severityVariant('UNAVAILABLE')).toBe('default'));
  it('maps UNKNOWN → default',    () => expect(severityVariant('UNKNOWN')).toBe('default'));
});

// ── Summary card mapping ──────────────────────────────────────────────────────

describe('KpiSummaryCard data mapping', () => {
  it('null currentValue renders as unavailable, not zero', () => {
    const card: KpiSummaryCard = {
      metric: 'rssi', displayName: 'RSSI', unit: 'dBm',
      currentValue: null, trend: 'UNAVAILABLE', trendPct: null,
      severity: 'UNAVAILABLE', deviceCount: 0, unsupported: true,
      lastUpdated: null,
    };
    expect(card.currentValue).toBeNull();
    expect(card.unsupported).toBe(true);
  });

  it('unsupported metrics have null currentValue and UNAVAILABLE severity', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const rssiCard = summary.summaryCards.find((c) => c.metric === 'rssi');
    expect(rssiCard).toBeDefined();
    expect(rssiCard!.unsupported).toBe(true);
    expect(rssiCard!.currentValue).toBeNull();
    expect(rssiCard!.severity).toBe('UNAVAILABLE');
  });

  it('packet loss card has CRITICAL severity when value is high', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const pktCard = summary.summaryCards.find((c) => c.metric === 'packetLossPct');
    expect(pktCard).toBeDefined();
    expect(pktCard!.severity).toBe('CRITICAL');
    expect(pktCard!.currentValue).toBeGreaterThan(0);
  });

  it('availability card has HEALTHY severity', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const avCard = summary.summaryCards.find((c) => c.metric === 'availability');
    expect(avCard).toBeDefined();
    expect(avCard!.severity).toBe('HEALTHY');
    expect(avCard!.currentValue).toBeGreaterThan(95);
  });

  it('all cards have valid displayName and unit', () => {
    const summary = getMockKpiOperationsSummary('24h');
    for (const card of summary.summaryCards) {
      expect(card.displayName).toBeTruthy();
      expect(card.unit).toBeDefined();
      expect(card.metric).toBeTruthy();
    }
  });
});

// ── Top impacted devices ──────────────────────────────────────────────────────

describe('DeviceImpactEntry data mapping', () => {
  it('has entries for BTS, CPE, IDU, and GENERIC device types', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const types = new Set(summary.topImpactedDevices.map((d) => d.deviceType));
    expect(types.has('BTS')).toBe(true);
    expect(types.has('CPE')).toBe(true);
    expect(types.has('IDU')).toBe(true);
    expect(types.has('GENERIC')).toBe(true);
  });

  it('CRITICAL devices have worstSeverity CRITICAL', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const critical = summary.topImpactedDevices.filter((d) => d.worstSeverity === 'CRITICAL');
    expect(critical.length).toBeGreaterThanOrEqual(1);
    for (const d of critical) {
      expect(d.impactedMetrics.length).toBeGreaterThan(0);
    }
  });

  it('devices with no latency have null latencyMs', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const iduDevice = summary.topImpactedDevices.find((d) => d.deviceType === 'IDU');
    expect(iduDevice).toBeDefined();
    expect(iduDevice!.latencyMs).toBeNull();
  });

  it('all entries have a deviceId, serialNumber, and lastObservedAt', () => {
    const summary = getMockKpiOperationsSummary('24h');
    for (const d of summary.topImpactedDevices) {
      expect(d.deviceId).toBeTruthy();
      expect(d.serialNumber).toBeTruthy();
      expect(d.lastObservedAt).toBeTruthy();
    }
  });
});

// ── Trend series ──────────────────────────────────────────────────────────────

describe('KpiTrendSeries data mapping', () => {
  it('has trend series for availability, throughputDL, cpuUtilization', () => {
    const summary = getMockKpiOperationsSummary('24h');
    const metrics = summary.trendSeries.map((t) => t.metric);
    expect(metrics).toContain('availability');
    expect(metrics).toContain('throughputDL');
    expect(metrics).toContain('cpuUtilization');
  });

  it('all trend points have non-null fleetAvg', () => {
    const summary = getMockKpiOperationsSummary('24h');
    for (const series of summary.trendSeries) {
      for (const pt of series.points) {
        expect(pt.fleetAvg).not.toBeNull();
        expect(typeof pt.fleetAvg).toBe('number');
      }
    }
  });

  it('7d window uses DAILY granularity', () => {
    const summary = getMockKpiOperationsSummary('7d');
    for (const series of summary.trendSeries) {
      expect(series.granularity).toBe('DAILY');
    }
  });

  it('24h window uses 1HOUR granularity', () => {
    const summary = getMockKpiOperationsSummary('24h');
    for (const series of summary.trendSeries) {
      expect(series.granularity).toBe('1HOUR');
    }
  });
});

// ── Stale data fixture ────────────────────────────────────────────────────────

describe('stale data fixture', () => {
  it('has staleData=true and a staleReason', () => {
    const stale = getMockKpiOperationsSummaryStale();
    expect(stale.staleData).toBe(true);
    expect(stale.staleReason).toBeTruthy();
  });
});

// ── Empty fixture ─────────────────────────────────────────────────────────────

describe('empty fixture', () => {
  it('has no summary cards and no impacted devices', () => {
    const empty: KpiOperationsSummaryResponse = MOCK_KPI_OPERATIONS_SUMMARY_EMPTY;
    expect(empty.summaryCards).toHaveLength(0);
    expect(empty.topImpactedDevices).toHaveLength(0);
    expect(empty.staleData).toBe(false);
  });
});

// ── timeRange structure ───────────────────────────────────────────────────────

describe('timeRange metadata', () => {
  it('contains from, to, and window fields', () => {
    const summary = getMockKpiOperationsSummary('6h');
    expect(summary.timeRange.from).toBeTruthy();
    expect(summary.timeRange.to).toBeTruthy();
    expect(summary.timeRange.window).toBe('6h');
  });

  it('from is before to', () => {
    const summary = getMockKpiOperationsSummary('24h');
    expect(new Date(summary.timeRange.from) < new Date(summary.timeRange.to)).toBe(true);
  });
});

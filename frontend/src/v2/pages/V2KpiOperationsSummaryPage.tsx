/**
 * KPI Operations Summary Page — WO-034
 *
 * Displays a fleet-level operational KPI summary for NOC operators:
 *   - Summary cards: availability, latency, throughput, CPU, memory, packet loss
 *   - Top impacted devices with primary degraded metrics
 *   - Trend mini-charts per metric
 *   - Loading, empty, error, stale-data, and permission-denied states
 *
 * Authorization: operator and admin. Auditors see read-only view.
 * Data: GET /api/v1/kpi/operations-summary
 */
import React, { useEffect, useState, useCallback } from 'react';
import { fetchKpiOperationsSummary } from '../../api/kpi.api';
import type {
  KpiOperationsSummaryResponse, KpiSummaryCard, DeviceImpactEntry, KpiTrendSeries, TimeRange,
} from '../../api/kpi.types';
import { severityColor, severityVariant } from '../../api/kpi.types';
import { Card } from '../components/common/Card';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'populated' | 'empty' | 'error' | 'denied';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h',  label: 'Last 1 hour' },
  { value: '6h',  label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
];

const DEVICE_TYPE_OPTIONS = [
  { value: '',        label: 'All device types' },
  { value: 'BTS',     label: 'BTS' },
  { value: 'CPE',     label: 'CPE' },
  { value: 'IDU',     label: 'IDU' },
  { value: 'GENERIC', label: 'Generic' },
];

const METRIC_GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'all',     label: 'All metrics' },
  { value: 'radio',   label: 'Radio' },
  { value: 'system',  label: 'System' },
  { value: 'traffic', label: 'Traffic' },
];

// ── Helper: trend sparkline ────────────────────────────────────────────────────

function TrendSparkline({ series }: { series: KpiTrendSeries }) {
  const pts = series.points.filter((p) => p.fleetAvg != null);
  if (pts.length < 2) return <span style={{ fontSize: 11, color: 'var(--vf-text-dim)' }}>—</span>;

  const values = pts.map((p) => p.fleetAvg as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 120; const H = 36; const px = 3; const py = 4;

  const coords = pts.map((p, i) => {
    const x = px + (i / (pts.length - 1)) * (W - 2 * px);
    const y = py + ((max - (p.fleetAvg as number)) / range) * (H - 2 * py);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={coords.join(' ')} fill="none"
        stroke="var(--vf-accent)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Helper: summary card ───────────────────────────────────────────────────────

function SummaryCard({ card, trendSeries }: { card: KpiSummaryCard; trendSeries?: KpiTrendSeries }) {
  const color = severityColor(card.severity);
  const variant = severityVariant(card.severity);
  const trendIcon = card.trend === 'UP' ? '↑' : card.trend === 'DOWN' ? '↓' : card.trend === 'STABLE' ? '→' : '';
  const trendColor = card.trend === 'UP'
    ? (card.metric === 'packetLossPct' || card.metric === 'latencyMs' ? 'var(--vf-danger)' : 'var(--vf-success)')
    : card.trend === 'DOWN'
      ? (card.metric === 'packetLossPct' || card.metric === 'latencyMs' ? 'var(--vf-success)' : 'var(--vf-warning)')
      : 'var(--vf-text-muted)';

  return (
    <div style={{
      background: 'var(--vf-surface)', border: `1px solid var(--vf-border-subtle)`,
      borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8,
      borderLeft: `3px solid ${color}`,
      boxShadow: 'var(--vf-shadow-low)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)' }}>
          {card.displayName}
        </span>
        <Badge variant={variant} aria-label={`Severity: ${card.severity}`}>{card.severity}</Badge>
      </div>

      {card.unsupported ? (
        <span style={{ fontSize: 13, color: 'var(--vf-text-dim)', fontStyle: 'italic' }}>
          Not supported for selected device mix
        </span>
      ) : card.currentValue == null ? (
        <span style={{ fontSize: 13, color: 'var(--vf-text-dim)' }}>Unavailable</span>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
              {card.currentValue.toFixed(1)}
            </span>
            <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>{card.unit}</span>
            {card.trendPct != null && (
              <span style={{ fontSize: 12, color: trendColor, fontWeight: 600 }}
                aria-label={`Trend: ${trendIcon}${Math.abs(card.trendPct).toFixed(1)}%`}>
                {trendIcon}{Math.abs(card.trendPct).toFixed(1)}%
              </span>
            )}
          </div>
          {trendSeries && <TrendSparkline series={trendSeries} />}
          <div style={{ fontSize: 11, color: 'var(--vf-text-dim)' }}>
            {card.deviceCount} device{card.deviceCount !== 1 ? 's' : ''}
            {card.lastUpdated && (
              <span> · {new Date(card.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Helper: impacted devices table ────────────────────────────────────────────

function ImpactedDevicesTable({ devices }: { devices: DeviceImpactEntry[] }) {
  if (devices.length === 0) {
    return (
      <div style={{ color: 'var(--vf-success)', fontSize: 13, padding: '16px 0' }}>
        ✓ No devices currently impacted
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--vf-elevated)' }}>
            {['Serial', 'Type', 'Impacted Metrics', 'Severity', 'Latency', 'Pkt Loss', 'Availability', 'Last Seen'].map((h) => (
              <th key={h} style={{
                padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'var(--vf-text-muted)', borderBottom: 'var(--vf-card-border)',
                whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.deviceId} style={{ borderBottom: 'var(--vf-card-border)' }}>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)' }}>
                {d.serialNumber}
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-secondary)' }}>
                {d.deviceType}
              </td>
              <td style={{ padding: '8px 12px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {d.impactedMetrics.map((m) => (
                    <span key={m} style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 4,
                      background: 'var(--vf-elevated)', color: 'var(--vf-warning)',
                      border: '1px solid var(--vf-border-subtle)', fontFamily: 'var(--vf-font-mono)',
                    }}>{m}</span>
                  ))}
                </div>
              </td>
              <td style={{ padding: '8px 12px' }}>
                <Badge
                  variant={severityVariant(d.worstSeverity)}
                  aria-label={`Severity: ${d.worstSeverity}`}
                >
                  {d.worstSeverity}
                </Badge>
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--vf-text-primary)' }}>
                {d.latencyMs != null ? `${d.latencyMs.toFixed(1)} ms` : '—'}
              </td>
              <td style={{ padding: '8px 12px', color: d.packetLossPct != null && d.packetLossPct > 1 ? 'var(--vf-danger)' : 'var(--vf-text-primary)' }}>
                {d.packetLossPct != null ? `${d.packetLossPct.toFixed(2)}%` : '—'}
              </td>
              <td style={{ padding: '8px 12px', color: d.availabilityPct != null && d.availabilityPct < 95 ? 'var(--vf-warning)' : 'var(--vf-text-primary)' }}>
                {d.availabilityPct != null ? `${d.availabilityPct.toFixed(1)}%` : '—'}
              </td>
              <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--vf-text-muted)' }}>
                {d.lastObservedAt
                  ? new Date(d.lastObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function V2KpiOperationsSummaryPage() {
  const { addToast } = useToast();

  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [deviceType, setDeviceType] = useState('');
  const [metricGroup, setMetricGroup] = useState('all');
  const [data, setData] = useState<KpiOperationsSummaryResponse | null>(null);
  const [pageState, setPageState] = useState<PageState>('loading');

  const load = useCallback(async () => {
    setPageState('loading');
    setData(null);
    try {
      const result = await fetchKpiOperationsSummary({
        timeRange,
        deviceType: deviceType || undefined,
        metricGroup: metricGroup as 'radio' | 'system' | 'traffic' | 'all',
      });
      if (result.summaryCards.length === 0 && result.topImpactedDevices.length === 0) {
        setPageState('empty');
      } else {
        setData(result);
        setPageState('populated');
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) {
        setPageState('denied');
      } else {
        logger.error('KPI operations summary fetch failed', err);
        setPageState('error');
        addToast('Failed to load KPI operations summary', 'error');
      }
    }
  }, [timeRange, deviceType, metricGroup, addToast]);

  useEffect(() => { load(); }, [load]);

  // ── Render states ─────────────────────────────────────────────────────────

  if (pageState === 'denied') {
    return (
      <div className="vf-page">
        <div className="vf-page-header">
          <h1 className="vf-page-title">KPI Operations Summary</h1>
        </div>
        <EmptyState
          title="Access Denied"
          description="Your role does not have permission to view KPI operations data. Contact your administrator."
          icon="🔒"
        />
      </div>
    );
  }

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">KPI Operations Summary</h1>
        <div className="vf-page-actions">
          <Button variant="primary" size="sm" onClick={load} disabled={pageState === 'loading'}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 20 }}>
        <Select label="Time Range" options={TIME_RANGE_OPTIONS} value={timeRange}
          onChange={(e) => setTimeRange(e.target.value as TimeRange)} style={{ width: 160 }} />
        <Select label="Device Type" options={DEVICE_TYPE_OPTIONS} value={deviceType}
          onChange={(e) => setDeviceType(e.target.value)} style={{ width: 160 }} />
        <Select label="Metric Group" options={METRIC_GROUP_OPTIONS} value={metricGroup}
          onChange={(e) => setMetricGroup(e.target.value)} style={{ width: 150 }} />
      </div>

      {/* Stale data banner */}
      {data?.staleData && (
        <div role="alert" style={{
          background: 'var(--vf-warning-bg, rgba(245,158,11,0.08))',
          border: '1px solid var(--vf-warning)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          color: 'var(--vf-warning)', fontSize: 13,
        }}>
          ⚠ Stale data: {data.staleReason ?? 'Some metrics may be outdated.'}
        </div>
      )}

      {/* Loading */}
      {pageState === 'loading' && <LoadingState label="Loading KPI operations summary…" />}

      {/* Empty */}
      {pageState === 'empty' && (
        <EmptyState
          title="No KPI data available"
          description="No metrics found for the selected time range and filters."
        />
      )}

      {/* Error */}
      {pageState === 'error' && (
        <EmptyState
          title="Failed to load KPI data"
          description="The KPI service returned an error. Check service health and retry."
          action={<Button variant="primary" size="sm" onClick={load}>Retry</Button>}
        />
      )}

      {/* Populated */}
      {pageState === 'populated' && data && (
        <>
          {/* Last updated */}
          <div style={{ fontSize: 11, color: 'var(--vf-text-dim)', marginBottom: 16 }}>
            Last updated: {new Date(data.generatedAt).toLocaleString()} ·
            Window: {data.timeRange.window}
          </div>

          {/* Summary cards grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
            {data.summaryCards.map((card) => {
              const trend = data.trendSeries.find((t) => t.metric === card.metric);
              return <SummaryCard key={card.metric} card={card} trendSeries={trend} />;
            })}
          </div>

          {/* Top impacted devices */}
          <Card title="Top Impacted Devices">
            <ImpactedDevicesTable devices={data.topImpactedDevices} />
          </Card>
        </>
      )}
    </div>
  );
}

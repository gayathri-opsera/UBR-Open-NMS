/**
 * KPI Drilldown Page — WO-040
 *
 * Operators can drill from KPI summary cards into filtered per-device
 * time-series views with configurable granularity.
 *
 * Navigation context: linked from /v2/kpi/operations via query params.
 * Filter controls: deviceId, deviceType, metricName, metricGroup, from, to, granularity.
 * States: loading, populated, empty, error, denied, validation.
 * Authorization: NOC operator and admin. Auditors: read-only.
 *
 * Data: GET /api/v1/kpi/drilldown
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { fetchKpiDrilldown } from '../../api/kpi.api';
import type {
  KpiDrilldownRequest, KpiDrilldownResponse, KpiDrilldownSeries,
  KpiDrilldownTableRow, DrilldownGranularity,
} from '../../api/kpi.types';
import { validateDrilldownTimeRange } from '../../api/kpi.types';
import { Card } from '../components/common/Card';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState = 'idle' | 'loading' | 'populated' | 'empty' | 'error' | 'denied' | 'validation';

// ── Constants ─────────────────────────────────────────────────────────────────

const GRANULARITY_OPTIONS: { value: DrilldownGranularity; label: string }[] = [
  { value: 'RAW',    label: 'Raw' },
  { value: '15MIN',  label: '15 Minutes' },
  { value: '1HOUR',  label: '1 Hour' },
  { value: 'DAILY',  label: 'Daily' },
];

const DEVICE_TYPE_OPTIONS = [
  { value: '',        label: 'All device types' },
  { value: 'BTS',     label: 'BTS' },
  { value: 'CPE',     label: 'CPE' },
  { value: 'IDU',     label: 'IDU' },
  { value: 'GENERIC', label: 'Generic' },
];

const METRIC_GROUP_OPTIONS = [
  { value: '',        label: 'All metrics' },
  { value: 'radio',   label: 'Radio' },
  { value: 'system',  label: 'System' },
  { value: 'traffic', label: 'Traffic' },
];

const PARADIGM_OPTIONS = [
  { value: '',                  label: 'All paradigms' },
  { value: 'UBR_CALL_HOME',    label: 'UBR Call-Home' },
  { value: 'GENERIC_SNMP',     label: 'Generic SNMP' },
  { value: 'GENERIC_CLI',      label: 'Generic CLI' },
];

const defaultTo   = () => new Date().toISOString().slice(0, 16);
const defaultFrom = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 16);

// ── Mini sparkline component ──────────────────────────────────────────────────

function Sparkline({ series }: { series: KpiDrilldownSeries }) {
  if (!series.supported) {
    return (
      <span style={{ fontSize: 11, color: 'var(--vf-text-dim)', fontStyle: 'italic' }}>
        Unsupported{series.unsupportedReason ? `: ${series.unsupportedReason}` : ''}
      </span>
    );
  }

  const pts = series.data.filter((p) => p.avg != null);
  if (pts.length < 2) {
    return (
      <span style={{ fontSize: 11, color: 'var(--vf-text-dim)' }}>
        No data points
      </span>
    );
  }

  const values = pts.map((p) => p.avg as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 200; const H = 48; const px = 4; const py = 6;

  const coords = pts.map((p, i) => {
    const x = px + (i / (pts.length - 1)) * (W - 2 * px);
    const y = py + ((max - (p.avg as number)) / range) * (H - 2 * py);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
        <polyline points={coords.join(' ')} fill="none"
          stroke="var(--vf-accent)" strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--vf-text-dim)', marginTop: 2 }}>
        <span>Min: {min.toFixed(2)}</span>
        <span>Max: {max.toFixed(2)}</span>
        <span>{series.unit}</span>
      </div>
    </div>
  );
}

// ── Series card ───────────────────────────────────────────────────────────────

function SeriesCard({ series }: { series: KpiDrilldownSeries }) {
  const hasGap = series.data.some((p) => p.stale);
  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: '1px solid var(--vf-border-subtle)',
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)' }}>
          {series.metricName}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!series.supported && <Badge variant="default">Unsupported</Badge>}
          {hasGap && <span style={{ fontSize: 10, color: 'var(--vf-warning)' }}>⚠ Gaps</span>}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
        Device: <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{series.serialNumber || series.deviceId}</span>
      </div>
      <Sparkline series={series} />
    </div>
  );
}

// ── Table row component ───────────────────────────────────────────────────────

function DrilldownTable({ rows }: { rows: KpiDrilldownTableRow[] }) {
  if (rows.length === 0) {
    return (
      <div style={{ color: 'var(--vf-text-dim)', fontSize: 13, padding: '16px 0' }}>
        No metric points match the selected filters.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--vf-elevated)' }}>
            {['Timestamp', 'Metric', 'Device', 'Avg', 'Min', 'Max', 'Unit', 'Samples'].map((h) => (
              <th key={h} style={{
                padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                color: 'var(--vf-text-muted)', borderBottom: 'var(--vf-card-border)', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.deviceId}-${row.metricName}-${i}`} style={{ borderBottom: 'var(--vf-card-border)' }}>
              <td style={{ padding: '6px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
                {new Date(row.timestamp).toLocaleString()}
              </td>
              <td style={{ padding: '6px 10px', fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)', fontSize: 11 }}>
                {row.metricName}
              </td>
              <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--vf-text-secondary)' }}>
                {row.serialNumber || row.deviceId}
              </td>
              <td style={{ padding: '6px 10px' }}>
                {row.avg != null ? row.avg.toFixed(2) : '—'}
              </td>
              <td style={{ padding: '6px 10px' }}>
                {row.min != null ? row.min.toFixed(2) : '—'}
              </td>
              <td style={{ padding: '6px 10px' }}>
                {row.max != null ? row.max.toFixed(2) : '—'}
              </td>
              <td style={{ padding: '6px 10px', color: 'var(--vf-text-muted)' }}>
                {row.unit}
              </td>
              <td style={{ padding: '6px 10px', color: 'var(--vf-text-dim)' }}>
                {row.sampleCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function V2KpiDrilldownPage() {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Seed initial filter values from navigation context (summary page drilldown)
  const [deviceId,         setDeviceId]         = useState(searchParams.get('deviceId')         ?? '');
  const [serialNumber,     setSerialNumber]     = useState(searchParams.get('serialNumber')     ?? '');
  const [deviceType,       setDeviceType]       = useState(searchParams.get('deviceType')       ?? '');
  const [metricName,       setMetricName]       = useState(searchParams.get('metricName')       ?? '');
  const [metricGroup,      setMetricGroup]      = useState(searchParams.get('metricGroup')      ?? '');
  const [discoveryParadigm, setDiscoveryParadigm] = useState(searchParams.get('discoveryParadigm') ?? '');
  const [from,             setFrom]             = useState(searchParams.get('from')             ?? defaultFrom());
  const [to,               setTo]               = useState(searchParams.get('to')               ?? defaultTo());
  const [granularity,      setGranularity]      = useState<DrilldownGranularity>(
    (searchParams.get('granularity') as DrilldownGranularity) ?? '1HOUR',
  );

  const [data,      setData]      = useState<KpiDrilldownResponse | null>(null);
  const [pageState, setPageState] = useState<PageState>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Validate time range before issuing request
    const rangeErr = validateDrilldownTimeRange(from, to);
    if (rangeErr) {
      setValidationError(rangeErr);
      setPageState('validation');
      return;
    }
    setValidationError(null);
    setPageState('loading');
    setData(null);

    const req: KpiDrilldownRequest = {
      from: new Date(from).toISOString(),
      to:   new Date(to).toISOString(),
      granularity,
    };
    if (deviceId)          req.deviceId          = deviceId;
    if (serialNumber)      req.serialNumber      = serialNumber;
    if (deviceType)        req.deviceType        = deviceType;
    if (metricName)        req.metricName        = metricName;
    if (metricGroup)       req.metricGroup       = metricGroup as KpiDrilldownRequest['metricGroup'];
    if (discoveryParadigm) req.discoveryParadigm = discoveryParadigm;

    try {
      const result = await fetchKpiDrilldown(req);
      if (result.series.length === 0 && result.tableRows.length === 0) {
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
        logger.error('KPI drilldown fetch failed', err);
        setPageState('error');
        addToast('Failed to load KPI drilldown data', 'error');
      }
    }
  }, [from, to, granularity, deviceId, serialNumber, deviceType, metricName, metricGroup, discoveryParadigm, addToast]);

  // Auto-load when navigation params are present (drilldown from summary page)
  useEffect(() => {
    if (searchParams.get('deviceId') || searchParams.get('metricName')) {
      load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render: denied ─────────────────────────────────────────────────────────
  if (pageState === 'denied') {
    return (
      <div className="vf-page">
        <div className="vf-page-header">
          <h1 className="vf-page-title">KPI Drilldown</h1>
        </div>
        <EmptyState
          title="Access Denied"
          description="Your role does not have permission to view KPI drilldown data."
          icon="🔒"
        />
      </div>
    );
  }

  return (
    <div className="vf-page">
      {/* Page header */}
      <div className="vf-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
          <h1 className="vf-page-title">KPI Drilldown</h1>
        </div>
        <div className="vf-page-actions">
          <Button variant="primary" size="sm" onClick={load} disabled={pageState === 'loading'}>
            {pageState === 'loading' ? 'Loading…' : 'Query'}
          </Button>
        </div>
      </div>

      {/* Breadcrumb context */}
      <div style={{ fontSize: 11, color: 'var(--vf-text-dim)', marginBottom: 16 }}>
        KPI Operations Summary → Drilldown
        {deviceId && <> · Device: <code style={{ fontFamily: 'var(--vf-font-mono)' }}>{deviceId}</code></>}
        {metricName && <> · Metric: <code style={{ fontFamily: 'var(--vf-font-mono)' }}>{metricName}</code></>}
      </div>

      {/* Filters */}
      <Card title="Drilldown Filters">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600 }}>Device ID</label>
            <input
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              placeholder="e.g. dev-bts-001"
              style={{
                background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 6, padding: '6px 10px', fontSize: 13, color: 'var(--vf-text-primary)',
                width: 180,
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600 }}>Serial Number</label>
            <input
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              placeholder="e.g. SN-BTS-001"
              style={{
                background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 6, padding: '6px 10px', fontSize: 13, color: 'var(--vf-text-primary)',
                width: 160,
              }}
            />
          </div>
          <Select
            label="Device Type"
            options={DEVICE_TYPE_OPTIONS}
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value)}
            style={{ width: 150 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600 }}>Metric Name</label>
            <input
              value={metricName}
              onChange={(e) => setMetricName(e.target.value)}
              placeholder="e.g. cpuUtilization"
              style={{
                background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 6, padding: '6px 10px', fontSize: 13, color: 'var(--vf-text-primary)',
                width: 160,
              }}
            />
          </div>
          <Select
            label="Metric Group"
            options={METRIC_GROUP_OPTIONS}
            value={metricGroup}
            onChange={(e) => setMetricGroup(e.target.value)}
            style={{ width: 140 }}
          />
          <Select
            label="Paradigm"
            options={PARADIGM_OPTIONS}
            value={discoveryParadigm}
            onChange={(e) => setDiscoveryParadigm(e.target.value)}
            style={{ width: 150 }}
          />
          <Select
            label="Granularity"
            options={GRANULARITY_OPTIONS}
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as DrilldownGranularity)}
            style={{ width: 140 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600 }}>From</label>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={{
                background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--vf-text-primary)',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600 }}>To</label>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={{
                background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--vf-text-primary)',
              }}
            />
          </div>
        </div>
      </Card>

      {/* Validation error */}
      {pageState === 'validation' && validationError && (
        <div role="alert" style={{
          background: 'var(--vf-danger-bg, rgba(239,68,68,0.08))',
          border: '1px solid var(--vf-danger)',
          borderRadius: 8, padding: '10px 16px', marginTop: 16,
          color: 'var(--vf-danger)', fontSize: 13,
        }}>
          ⚠ {validationError}
        </div>
      )}

      {/* Stale data warning */}
      {data?.staleData && (
        <div role="alert" style={{
          background: 'var(--vf-warning-bg, rgba(245,158,11,0.08))',
          border: '1px solid var(--vf-warning)',
          borderRadius: 8, padding: '10px 16px', marginTop: 16,
          color: 'var(--vf-warning)', fontSize: 13,
        }}>
          ⚠ Stale data: {data.staleReason ?? 'Some metrics may be outdated.'}
        </div>
      )}

      {/* Loading */}
      {pageState === 'loading' && (
        <div style={{ marginTop: 24 }}>
          <LoadingState label="Loading KPI drilldown…" />
        </div>
      )}

      {/* Idle — prompt user to run query */}
      {pageState === 'idle' && (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            title="Set filters and click Query"
            description="Configure a device, time range, and granularity above, then click Query to load drilldown data."
          />
        </div>
      )}

      {/* Empty */}
      {pageState === 'empty' && (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            title="No data for selected filters"
            description="No KPI time-series data matches the selected device, metric, and time range. Adjust filters or try a wider time window."
            action={<Button variant="secondary" size="sm" onClick={load}>Retry</Button>}
          />
        </div>
      )}

      {/* Error */}
      {pageState === 'error' && (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            title="Failed to load KPI drilldown"
            description="The KPI service returned an error. Check filters and service health, then retry."
            action={<Button variant="primary" size="sm" onClick={load}>Retry</Button>}
          />
        </div>
      )}

      {/* Populated */}
      {pageState === 'populated' && data && (
        <div style={{ marginTop: 24 }}>
          {/* Query metadata */}
          <div style={{ fontSize: 11, color: 'var(--vf-text-dim)', marginBottom: 16 }}>
            Generated: {new Date(data.generatedAt).toLocaleString()} ·
            Granularity: {data.query.granularity} ·
            {data.series.length} series · {data.tableRows.length} rows
          </div>

          {/* Supported granularities */}
          {data.supportedGranularities.length > 0 && (
            <div style={{ marginBottom: 16, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>Supported granularities:</span>
              {data.supportedGranularities.map((g) => (
                <Badge key={g} variant={g === granularity ? 'success' : 'default'}>
                  {g}
                </Badge>
              ))}
            </div>
          )}

          {/* Series charts grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 24 }}>
            {data.series.map((s, i) => (
              <SeriesCard key={`${s.deviceId}-${s.metricName}-${i}`} series={s} />
            ))}
          </div>

          {/* Raw data table */}
          <Card title="Metric Time-Series Table">
            <DrilldownTable rows={data.tableRows} />
          </Card>
        </div>
      )}
    </div>
  );
}

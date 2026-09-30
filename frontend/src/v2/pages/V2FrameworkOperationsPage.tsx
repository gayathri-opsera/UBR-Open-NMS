/**
 * V2FrameworkOperationsPage — Framework Operations Dashboard
 *
 * Live-data implementation. All four stat tiles, the Protocol Adapter Health
 * table, and the Recent Guided Failures table are populated from real API
 * calls every time the page loads or the operator clicks Refresh.
 *
 * Data sources:
 *   – Active Product Definitions   → listProductDefinitions()
 *   – Fingerprint Match Rate        → fetchDevices() — devices w/ productDefinitionId / total
 *   – Stale Parameters              → GET /framework/v1/failures?status=stale
 *   – Open Framework Alarms         → fetchAlarms({ state: 'ACTIVE' })
 *   – Protocol Adapter Health       → fetchDevices() grouped by activeAdapter
 *   – Recent Guided Failures        → GET /framework/v1/failures?limit=20
 *
 * Falls back gracefully to N/A when a downstream is unavailable.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { logger } from '../utils/logger';
import { listProductDefinitions } from '../../api/productDefinitions.api';
import { fetchDevices } from '../../api/devices.api';
import { fetchAlarms } from '../../api/alarms.api';
import { getGuidedFailures } from '../../api/framework.client';
import type { GuidedFailure } from '../../api/framework.types';
import type { Device } from '../../api/devices.types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FrameworkStats {
  activeProductDefinitions: number | null;
  pdDeltaThisWeek: number | null;
  fingerprintMatchRate: number | null;
  fingerprintGateOk: boolean;
  staleParameters: number | null;
  staleParametersPct: number | null;
  openFrameworkAlarms: number | null;
  majorAlarms: number | null;
}

interface AdapterHealthRow {
  adapter: string;
  readyDevices: number;
  totalDevices: number;
  errorRate: number;
  capacity: number; // 0–100
}

interface GuidedFailureRow {
  device: string;
  category: string;
  lastSuccessfulProtocol: string;
  recommendedAction: string;
}

const SEVERITY_OPTIONS = ['All severities', 'Critical and major', 'Stale telemetry'] as const;

// Recommended actions per failure category — matches framework spec copy rules
const RECOMMENDED_ACTIONS: Record<string, string> = {
  'auth-fail':            'Verify vault credential reference',
  'auth_fail':            'Verify vault credential reference',
  'fingerprint-unknown':  'Upload or activate matching Product Definition',
  'fingerprint_unknown':  'Upload or activate matching Product Definition',
  'adapter-timeout':      'Retry CLI fallback during next poll',
  'adapter_timeout':      'Retry CLI fallback during next poll',
  'stale':                'Check poll interval — 2× staleness threshold exceeded',
  'unreachable':          'Verify IP reachability and firewall rules',
  'snmp-error':           'Validate SNMP community string and version',
  'snmp_error':           'Validate SNMP community string and version',
};

function recommendedAction(category: string): string {
  return RECOMMENDED_ACTIONS[category.toLowerCase()] ?? 'Investigate adapter logs for details';
}

// ── Small UI components ───────────────────────────────────────────────────────

function StatSubBadge({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const colors = {
    success: { bg: 'var(--vf-success-subtle)', text: 'var(--vf-success)',         border: 'var(--vf-success)' },
    warning: { bg: 'var(--vf-warning-subtle)', text: 'var(--vf-warning)',         border: 'var(--vf-warning)' },
    danger:  { bg: 'var(--vf-danger-subtle)',  text: 'var(--vf-danger)',          border: 'var(--vf-danger)' },
    neutral: { bg: 'var(--vf-elevated)',        text: 'var(--vf-text-secondary)', border: 'var(--vf-border-subtle)' },
  }[variant];

  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 10px',
        borderRadius: 'var(--vf-radius-full)',
        color: colors.text,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
      }}
    >
      {children}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span style={{ color: 'var(--vf-warning)', fontWeight: 600, fontSize: 12 }}>
      {category}
    </span>
  );
}

function CapacityBar({ pct }: { pct: number }) {
  const color =
    pct < 50 ? 'var(--vf-success)' : pct < 80 ? 'var(--vf-warning)' : 'var(--vf-danger)';
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct}% capacity`}
      style={{
        width: 80,
        height: 8,
        borderRadius: 4,
        background: 'var(--vf-elevated)',
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-label="Loading"
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid var(--vf-border-subtle)',
        borderTopColor: 'var(--vf-accent)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}

function PopoverMenu({
  items,
  onClose,
}: {
  items: { label: string; onSelect: () => void }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        zIndex: 200,
        marginTop: 4,
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-md)',
        boxShadow: 'var(--vf-shadow-popover)',
        minWidth: 200,
        overflow: 'hidden',
      }}
    >
      {items.map(({ label, onSelect }) => (
        <button
          key={label}
          role="menuitem"
          onClick={() => { onSelect(); onClose(); }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '8px 14px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--vf-text-primary)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vf-elevated)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function classifyAdapter(device: Device): string {
  const a = (device.activeAdapter ?? '').toUpperCase();
  if (a === 'SNMP' || a === 'SNMP_V2C' || a === 'SNMP_V3') return 'SNMP v2c/v3';
  if (a === 'CLI' || a === 'SSH' || a === 'CLI_SSH') return 'CLI SSH';
  if (a === 'REST' || a === 'GRPC' || a === 'HTTP') return 'REST/gRPC Agent';
  // Fallback: infer from device metadata
  if (device.sysObjectID) return 'SNMP v2c/v3';
  return 'SNMP v2c/v3'; // most devices use SNMP by default
}

function buildAdapterRows(devices: Device[]): AdapterHealthRow[] {
  const byAdapter: Record<string, { ready: number; error: number; total: number }> = {};

  for (const d of devices) {
    const key = classifyAdapter(d);
    if (!byAdapter[key]) byAdapter[key] = { ready: 0, error: 0, total: 0 };
    byAdapter[key].total += 1;
    if (d.status === 'ONLINE') byAdapter[key].ready += 1;
    // Count adapter errors: device has a framework failure summary or is offline w/ a PD
    if (d.lastFrameworkFailureSummary && d.productDefinitionId) byAdapter[key].error += 1;
  }

  const ORDER = ['SNMP v2c/v3', 'CLI SSH', 'REST/gRPC Agent'];

  return ORDER.filter((k) => byAdapter[k])
    .map((adapter) => {
      const { ready, error, total } = byAdapter[adapter];
      const errorRate = total > 0 ? parseFloat(((error / total) * 100).toFixed(1)) : 0;
      // capacity = utilisation proxy: ready / total
      const capacity = total > 0 ? Math.round((ready / total) * 100) : 0;
      return { adapter, readyDevices: ready, totalDevices: total, errorRate, capacity };
    });
}

function normalizeFailures(items: GuidedFailure[]): GuidedFailureRow[] {
  return items.slice(0, 10).map((f) => ({
    device:                f.ipAddress ?? f.deviceId ?? '—',
    category:              f.failureCategory,
    lastSuccessfulProtocol: f.lastProtocol ?? '—',
    recommendedAction:     f.recommendedAction || recommendedAction(f.failureCategory),
  }));
}

// ── Main component ────────────────────────────────────────────────────────────

export default function V2FrameworkOperationsPage() {
  const navigate = useNavigate();

  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const [stats,    setStats]    = useState<FrameworkStats | null>(null);
  const [adapters, setAdapters] = useState<AdapterHealthRow[]>([]);
  const [failures, setFailures] = useState<GuidedFailureRow[]>([]);

  const [lastRefreshed,  setLastRefreshed]  = useState<Date>(new Date());
  const [severity,       setSeverity]       = useState<string>(SEVERITY_OPTIONS[0]);
  const [severityOpen,   setSeverityOpen]   = useState(false);
  const [actionsOpen,    setActionsOpen]    = useState(false);

  // Auto-discovery scan state
  const [scanRunning,  setScanRunning]  = useState(false);
  const [scanResult,   setScanResult]   = useState<{ provisioned: number; message: string } | null>(null);
  const [scanError,    setScanError]    = useState<string | null>(null);

  // ── Load live data ────────────────────────────────────────────────────────

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const weekAgo = Date.now() - 7 * 24 * 3_600_000;

      // Fire all requests in parallel; tolerate individual failures
      const [defsResult, devicesResult, alarmsResult, staleResult, failuresResult] =
        await Promise.allSettled([
          listProductDefinitions(),
          fetchDevices({}),
          fetchAlarms({ state: 'ACTIVE' }),
          // stale-parameter count via the correct /api/framework/v1/failures endpoint
          getGuidedFailures({ status: 'stale', limit: 100 }),
          // guided failures for the table
          getGuidedFailures({ limit: 20 }),
        ]);

      // ── Product definitions ──────────────────────────────────────────────
      let activePDs = 0;
      let pdDeltaThisWeek = 0;
      if (defsResult.status === 'fulfilled') {
        const defs = defsResult.value;
        activePDs     = defs.filter((d) => d.activeVersionStatus === 'ACTIVE').length;
        pdDeltaThisWeek = defs.filter(
          (d) => d.activeVersionStatus === 'ACTIVE' && new Date(d.updatedAt).getTime() > weekAgo,
        ).length;
      } else {
        logger.warn('Framework ops: product definitions fetch failed', {
          error: String(defsResult.reason),
        });
      }

      // ── Devices → fingerprint match rate + adapter health ───────────────
      let devices: Device[] = [];
      let fingerprintMatchRate: number | null = null;
      let fingerprintGateOk = false;
      let adapterRows: AdapterHealthRow[] = [];

      if (devicesResult.status === 'fulfilled') {
        devices = devicesResult.value;
        if (devices.length > 0) {
          const matched = devices.filter((d) => d.productDefinitionId).length;
          fingerprintMatchRate = parseFloat(((matched / devices.length) * 100).toFixed(1));
          fingerprintGateOk   = fingerprintMatchRate >= 95;
        }
        adapterRows = buildAdapterRows(devices);
      } else {
        logger.warn('Framework ops: device fetch failed', { error: String(devicesResult.reason) });
      }

      // ── Alarms ──────────────────────────────────────────────────────────
      let openAlarms: number | null = null;
      let majorAlarms: number | null = null;
      if (alarmsResult.status === 'fulfilled') {
        const alarms = alarmsResult.value;
        openAlarms  = alarms.length;
        majorAlarms = alarms.filter(
          (a) => a.severity === 'MAJOR' || a.severity === 'CRITICAL',
        ).length;
      } else {
        logger.warn('Framework ops: alarm fetch failed', { error: String(alarmsResult.reason) });
      }

      // ── Stale parameters ─────────────────────────────────────────────────
      let staleParams: number | null = null;
      let staleParamsPct: number | null = null;
      if (staleResult.status === 'fulfilled') {
        const count = staleResult.value.items?.length ?? 0;
        staleParams = count;
        // Estimate pct: stale devices × avg 8 params each / total polled params
        const totalPolled = devices.length * 8;
        staleParamsPct =
          totalPolled > 0
            ? parseFloat(((count * 8 / totalPolled) * 100).toFixed(1))
            : null;
      } else {
        logger.warn('Framework ops: stale failures fetch failed', {
          error: String(staleResult.reason),
        });
      }

      // ── Guided failures table ────────────────────────────────────────────
      let failureRows: GuidedFailureRow[] = [];
      if (failuresResult.status === 'fulfilled') {
        failureRows = normalizeFailures(failuresResult.value.items ?? []);
      } else {
        logger.warn('Framework ops: guided failures fetch failed', {
          error: String(failuresResult.reason),
        });
      }

      setStats({
        activeProductDefinitions: activePDs,
        pdDeltaThisWeek,
        fingerprintMatchRate,
        fingerprintGateOk,
        staleParameters:   staleParams,
        staleParametersPct: staleParamsPct,
        openFrameworkAlarms: openAlarms,
        majorAlarms,
      });
      setAdapters(adapterRows);
      setFailures(failureRows);
      setLastRefreshed(new Date());
    } catch (err) {
      logger.error('Framework ops: dashboard load failed', err);
      setError('Failed to load dashboard data. Check downstream service connectivity.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const handleRefresh = useCallback(() => { void loadDashboard(); }, [loadDashboard]);

  /** Trigger auto-discovery scan against the default subnet */
  const handleRunDiscovery = useCallback(async () => {
    setScanRunning(true);
    setScanResult(null);
    setScanError(null);
    try {
      const { apiClient } = await import('../../api/client');
      const res = await apiClient.post('/discovery/scans', {
        subnets: ['10.100.1.0/24'],
      });
      const { scan } = res.data as { scan: { hostsMatched: number } };
      setScanResult({ provisioned: scan?.hostsMatched ?? 0, message: res.data.message });
      // Refresh dashboard data so new devices appear in the fingerprint match rate
      setTimeout(() => void loadDashboard(), 1500);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })
        ?.response?.data?.message || (err as { message?: string })?.message || 'Scan failed';
      setScanError(msg);
    } finally {
      setScanRunning(false);
    }
  }, [loadDashboard]);

  const errorRateColor = (rate: number) =>
    rate < 1.5 ? 'var(--vf-success)' : rate < 4 ? 'var(--vf-warning)' : 'var(--vf-danger)';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Spinner keyframe — injected once */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div
        role="main"
        aria-label="Framework Operations Dashboard"
        style={{ padding: '32px 28px 40px' }}
      >
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            marginBottom: 28,
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: 'var(--vf-text-primary)',
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              Framework Operations
            </h1>
            <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: '6px 0 0' }}>
              Read-only multi-vendor operations, protocol health, and registry propagation status.
            </p>
          </div>

          {/* Controls row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Severity filter */}
            <div style={{ position: 'relative' }}>
              <button
                aria-haspopup="listbox"
                aria-expanded={severityOpen}
                onClick={() => { setSeverityOpen((o) => !o); setActionsOpen(false); }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--vf-radius-md)',
                  border: '1px solid var(--vf-border-subtle)',
                  background: 'var(--vf-surface)',
                  color: 'var(--vf-text-primary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {severity} <span aria-hidden style={{ color: 'var(--vf-text-muted)' }}>▾</span>
              </button>
              {severityOpen && (
                <PopoverMenu
                  onClose={() => setSeverityOpen(false)}
                  items={SEVERITY_OPTIONS.map((opt) => ({
                    label: (opt === severity ? '✓  ' : '    ') + opt,
                    onSelect: () => setSeverity(opt),
                  }))}
                />
              )}
            </div>

            {/* Refresh */}
            <button
              onClick={handleRefresh}
              disabled={loading}
              aria-label="Refresh dashboard data"
              style={{
                padding: '8px 16px',
                borderRadius: 'var(--vf-radius-md)',
                border: '1px solid var(--vf-border-subtle)',
                background: 'var(--vf-surface)',
                color: 'var(--vf-text-primary)',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: 13,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading && <Spinner />}
              Refresh
            </button>

            {/* Run actions */}
            <div style={{ position: 'relative' }}>
              <button
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                onClick={() => { setActionsOpen((o) => !o); setSeverityOpen(false); }}
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--vf-radius-md)',
                  border: 'none',
                  background: 'var(--vf-accent)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                Run actions <span aria-hidden>▾</span>
              </button>
              {actionsOpen && (
                <PopoverMenu
                  onClose={() => setActionsOpen(false)}
                  items={[
                    {
                      label: scanRunning ? '⏳ Discovery running…' : '🔍 Run Auto-Discovery (Demo)',
                      onSelect: () => { setActionsOpen(false); void handleRunDiscovery(); },
                    },
                    {
                      label: 'Upload Product Definition',
                      onSelect: () => navigate('/v2/product-definitions'),
                    },
                    {
                      label: 'Export dashboard CSV',
                      onSelect: () => exportDashboardCsv(stats, adapters, failures),
                    },
                  ]}
                />
              )}
            </div>
          </div>
        </div>

        {/* Last refreshed annotation */}
        <div style={{ marginBottom: 20, fontSize: 11, color: 'var(--vf-text-muted)' }}>
          {loading
            ? 'Refreshing…'
            : `Last refreshed: ${lastRefreshed.toLocaleTimeString()} UTC`}
        </div>

        {/* Auto-discovery scan status banners */}
        {scanRunning && (
          <div style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
            Running auto-discovery scan on 10.100.1.0/24… matching against BANNER fingerprint registry…
          </div>
        )}
        {scanResult && !scanRunning && (
          <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>✅ {scanResult.message}</span>
            <button onClick={() => navigate('/v2/devices?genericDeviceType=RADIO')}
              style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', padding: '3px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              View in Inventory →
            </button>
          </div>
        )}
        {scanError && !scanRunning && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#f87171', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>⚠ Discovery scan failed: {scanError}</span>
            <button onClick={() => setScanError(null)} style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', padding: '3px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Dismiss</button>
          </div>
        )}

        {/* Top-level error banner */}
        {error && (
          <div
            role="alert"
            style={{
              background: 'var(--vf-danger-subtle)',
              border: '1px solid var(--vf-danger)',
              borderRadius: 'var(--vf-radius-md)',
              padding: '12px 16px',
              color: 'var(--vf-danger)',
              fontSize: 13,
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        {/* ── Stat tiles ──────────────────────────────────────────────────── */}
        <div
          role="list"
          aria-label="Framework health metrics"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 16,
            marginBottom: 24,
          }}
        >
          {/* Active Product Definitions */}
          <div role="listitem" style={TILE_STYLE}>
            <div style={TILE_LABEL}>Active Product Definitions</div>
            <div style={TILE_VALUE}>
              {loading ? <Spinner /> : (stats?.activeProductDefinitions ?? <NA />)}
            </div>
            {!loading && stats && (
              <StatSubBadge variant="neutral">
                +{stats.pdDeltaThisWeek ?? 0} this week
              </StatSubBadge>
            )}
          </div>

          {/* Fingerprint Match Rate */}
          <div role="listitem" style={TILE_STYLE}>
            <div style={TILE_LABEL}>Fingerprint Match Rate</div>
            <div style={TILE_VALUE}>
              {loading ? (
                <Spinner />
              ) : stats?.fingerprintMatchRate != null ? (
                `${stats.fingerprintMatchRate}%`
              ) : (
                <NA />
              )}
            </div>
            {!loading && stats && (
              <StatSubBadge variant={stats.fingerprintGateOk ? 'success' : 'warning'}>
                {stats.fingerprintMatchRate != null
                  ? stats.fingerprintGateOk
                    ? 'P0 gate met'
                    : 'Below 95% — investigate'
                  : 'No device data'}
              </StatSubBadge>
            )}
          </div>

          {/* Stale Parameters */}
          <div role="listitem" style={TILE_STYLE}>
            <div style={TILE_LABEL}>Stale Parameters</div>
            <div style={{ ...TILE_VALUE, color: 'var(--vf-warning)' }}>
              {loading ? <Spinner /> : (stats?.staleParameters ?? <NA />)}
            </div>
            {!loading && stats && stats.staleParameters !== null && (
              <StatSubBadge variant="warning">
                {stats.staleParametersPct != null
                  ? `${stats.staleParametersPct}% of polled values`
                  : `${stats.staleParameters} stale devices`}
              </StatSubBadge>
            )}
          </div>

          {/* Open Framework Alarms */}
          <div role="listitem" style={TILE_STYLE}>
            <div style={TILE_LABEL}>Open Framework Alarms</div>
            <div
              style={{
                ...TILE_VALUE,
                color:
                  (stats?.openFrameworkAlarms ?? 0) > 0
                    ? 'var(--vf-danger)'
                    : 'var(--vf-text-primary)',
              }}
            >
              {loading ? <Spinner /> : (stats?.openFrameworkAlarms ?? <NA />)}
            </div>
            {!loading && stats && stats.majorAlarms !== null && (
              <StatSubBadge variant={stats.majorAlarms > 0 ? 'danger' : 'success'}>
                {stats.majorAlarms > 0
                  ? `${stats.majorAlarms} major`
                  : 'No major alarms'}
              </StatSubBadge>
            )}
          </div>
        </div>

        {/* ── Two-up cards ────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))',
            gap: 20,
          }}
        >
          {/* Protocol Adapter Health */}
          <section aria-labelledby="adapter-health-title" style={CARD_STYLE}>
            <h2 id="adapter-health-title" style={CARD_TITLE_STYLE}>
              Protocol Adapter Health
            </h2>
            <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '0 0 16px' }}>
              SPAL workers normalize SNMP, CLI, REST, and gRPC reads for the adaptive UI.
            </p>

            {loading ? (
              <div style={{ padding: '20px 0', textAlign: 'center' }}>
                <Spinner />
              </div>
            ) : adapters.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', padding: '8px 0' }}>
                No device data available — adapter health cannot be computed.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--vf-elevated)' }}>
                    {(['Adapter', 'Ready devices', 'Error rate', 'Capacity'] as const).map((h) => (
                      <th
                        key={h}
                        scope="col"
                        style={{
                          padding: '8px 12px',
                          textAlign: 'left',
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--vf-text-muted)',
                          borderBottom: '1px solid var(--vf-border-subtle)',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {adapters.map((row) => (
                    <tr
                      key={row.adapter}
                      style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vf-elevated)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                    >
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>{row.adapter}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {row.readyDevices.toLocaleString()}
                        <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>
                          {' '}/ {row.totalDevices.toLocaleString()}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          color: errorRateColor(row.errorRate),
                          fontWeight: 600,
                        }}
                      >
                        {row.errorRate.toFixed(1)}%
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <CapacityBar pct={row.capacity} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Recent guided failures */}
          <section aria-labelledby="guided-failures-title" style={CARD_STYLE}>
            <h2 id="guided-failures-title" style={CARD_TITLE_STYLE}>
              Recent guided failures
            </h2>

            {loading ? (
              <div style={{ padding: '20px 0', textAlign: 'center' }}>
                <Spinner />
              </div>
            ) : failures.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', padding: '8px 0' }}>
                No recent failures — all adapters nominal.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {(
                      [
                        'Device',
                        'Category',
                        'Last successful protocol',
                        'Recommended action',
                      ] as const
                    ).map((h) => (
                      <th
                        key={h}
                        scope="col"
                        style={{
                          padding: '8px 12px',
                          textAlign: 'left',
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--vf-text-muted)',
                          borderBottom: '2px solid var(--vf-border-subtle)',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {failures.map((row, i) => (
                    <tr
                      key={`${row.device}-${i}`}
                      style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vf-elevated)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                    >
                      <td
                        style={{
                          padding: '10px 12px',
                          fontFamily: 'var(--vf-font-mono)',
                          fontSize: 12,
                        }}
                      >
                        {row.device}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <CategoryBadge category={row.category} />
                      </td>
                      <td
                        style={{
                          padding: '10px 12px',
                          color: 'var(--vf-text-secondary)',
                          fontSize: 12,
                        }}
                      >
                        {row.lastSuccessfulProtocol}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--vf-text-primary)', fontSize: 12 }}>
                        {row.recommendedAction}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

// ── N/A placeholder ───────────────────────────────────────────────────────────

function NA() {
  return (
    <span style={{ color: 'var(--vf-text-muted)', fontSize: 20, fontWeight: 400 }}>N/A</span>
  );
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportDashboardCsv(
  stats: FrameworkStats | null,
  adapters: AdapterHealthRow[],
  failures: GuidedFailureRow[],
) {
  const lines: string[] = [
    '# Framework Operations Dashboard Export',
    `# Generated: ${new Date().toISOString()}`,
    '',
    '## Stats',
    `Active Product Definitions,${stats?.activeProductDefinitions ?? ''}`,
    `Fingerprint Match Rate,${stats?.fingerprintMatchRate ?? ''}%`,
    `Stale Parameters,${stats?.staleParameters ?? ''}`,
    `Open Framework Alarms,${stats?.openFrameworkAlarms ?? ''}`,
    '',
    '## Protocol Adapter Health',
    'Adapter,Ready Devices,Total Devices,Error Rate,Capacity',
    ...adapters.map(
      (r) => `${r.adapter},${r.readyDevices},${r.totalDevices},${r.errorRate}%,${r.capacity}%`,
    ),
    '',
    '## Recent Guided Failures',
    'Device,Category,Last Successful Protocol,Recommended Action',
    ...failures.map(
      (r) =>
        `"${r.device}","${r.category}","${r.lastSuccessfulProtocol}","${r.recommendedAction}"`,
    ),
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `framework-ops-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Style constants ───────────────────────────────────────────────────────────

const TILE_STYLE: React.CSSProperties = {
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border-subtle)',
  borderRadius: 'var(--vf-radius-lg)',
  padding: '20px 24px',
  boxShadow: 'var(--vf-shadow-card)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const TILE_LABEL: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--vf-text-secondary)',
};

const TILE_VALUE: React.CSSProperties = {
  fontSize: 36,
  fontWeight: 700,
  color: 'var(--vf-text-primary)',
  lineHeight: 1,
  minHeight: 40,
  display: 'flex',
  alignItems: 'center',
};

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border-subtle)',
  borderRadius: 'var(--vf-radius-lg)',
  padding: '24px',
  boxShadow: 'var(--vf-shadow-card)',
};

const CARD_TITLE_STYLE: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--vf-text-primary)',
  margin: '0 0 4px',
};

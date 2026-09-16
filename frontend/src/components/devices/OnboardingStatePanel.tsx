/**
 * OnboardingStatePanel — WO-026
 *
 * Renders the bootstrap state progress for UBR call-home devices.
 * Handles loading, empty, permission-denied, and error states without
 * collapsing the surrounding operator workspace.
 *
 * No sensitive authentication material is ever rendered — only state
 * metadata and categorised failure reasons.
 */
import React, { useEffect, useState, useCallback } from 'react';
import type { DeviceOnboardingState, BootstrapStateValue } from '../../api/devices.types';
import { fetchOnboardingStates } from '../../api/devices.api';

// ── Style constants ───────────────────────────────────────────────────────────

const STATE_META: Record<string, { bg: string; color: string; label: string }> = {
  PENDING:               { bg: '#1e293b', color: '#94a3b8', label: 'Pending' },
  AUTHENTICATED:         { bg: '#172554', color: '#93c5fd', label: 'Authenticated' },
  CHECK_IN_RECEIVED:     { bg: '#1e3a5f', color: '#60a5fa', label: 'Check-In' },
  REALTIME_ESTABLISHED:  { bg: '#14532d', color: '#86efac', label: 'Realtime' },
  ONLINE:                { bg: '#14532d', color: '#86efac', label: 'Online' },
  OFFLINE:               { bg: '#7f1d1d', color: '#fca5a5', label: 'Offline' },
  FAILED:                { bg: '#78350f', color: '#fcd34d', label: 'Failed' },
  UNKNOWN:               { bg: '#374151', color: '#9ca3af', label: 'Unknown' },
};

const DEFAULT_STATE_META = { bg: '#1e293b', color: '#94a3b8', label: 'Unknown' };

// ── Sub-components ────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: BootstrapStateValue }) {
  const meta = STATE_META[state] ?? DEFAULT_STATE_META;
  return (
    <span
      style={{
        background: meta.bg, color: meta.color,
        padding: '2px 8px', borderRadius: 4,
        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
      }}
      aria-label={`Bootstrap state: ${state}`}
    >
      {meta.label}
    </span>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  let label: string;
  if (s < 60) label = `${s}s ago`;
  else if (s < 3600) label = `${Math.floor(s / 60)}m ago`;
  else if (s < 86400) label = `${Math.floor(s / 3600)}h ago`;
  else label = `${Math.floor(s / 86400)}d ago`;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{label}</time>;
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  /** Optional state filter — pass a BootstrapStateValue to show only those devices */
  stateFilter?: string;
  /** Polling interval in ms; 0 = no polling (default: 30 000 ms) */
  pollIntervalMs?: number;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error' | 'forbidden';

export function OnboardingStatePanel({ stateFilter, pollIntervalMs = 30_000 }: Props): React.ReactElement {
  const [states, setStates] = useState<DeviceOnboardingState[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const items = await fetchOnboardingStates(stateFilter);
      setStates(items);
      setLoadState('loaded');
      setErrorMsg('');
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) {
        setLoadState('forbidden');
      } else {
        setLoadState('error');
        setErrorMsg(
          err instanceof Error ? err.message : 'Failed to load onboarding state data.',
        );
      }
    }
  }, [stateFilter]);

  useEffect(() => {
    load();
    if (pollIntervalMs > 0) {
      const id = setInterval(load, pollIntervalMs);
      return () => clearInterval(id);
    }
    return undefined;
  }, [load, pollIntervalMs]);

  const container: React.CSSProperties = {
    background: '#0d1b2a', borderRadius: 8,
    border: '1px solid #1e293b', overflow: 'hidden',
    marginTop: 16,
  };

  const header: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', background: '#0f172a',
    borderBottom: '1px solid #1e293b',
  };

  const th: React.CSSProperties = {
    padding: '8px 12px', background: '#0f172a', color: '#94a3b8',
    fontSize: 11, textAlign: 'left', fontWeight: 700,
    borderBottom: '1px solid #1e293b',
    textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap',
  };

  const td: React.CSSProperties = {
    padding: '8px 12px', borderBottom: '1px solid #0f172a',
    fontSize: 12, color: '#cbd5e1', verticalAlign: 'middle',
  };

  // ── Render states ─────────────────────────────────────────────────────────

  const renderBody = () => {
    if (loadState === 'forbidden') {
      return (
        <tr>
          <td colSpan={7} style={{ ...td, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
            <div style={{ color: '#fca5a5', fontWeight: 600, marginBottom: 4 }}>Access Denied</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>
              You do not have permission to view onboarding state data.
            </div>
          </td>
        </tr>
      );
    }

    if (loadState === 'error') {
      return (
        <tr>
          <td colSpan={7} style={{ ...td, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
            <div style={{ color: '#fcd34d', fontWeight: 600, marginBottom: 4 }}>Failed to load</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>{errorMsg}</div>
            <button
              onClick={load}
              style={{
                marginTop: 12, padding: '6px 16px', background: '#1e3a5f',
                color: '#93c5fd', border: '1px solid #2563eb',
                borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Retry
            </button>
          </td>
        </tr>
      );
    }

    if (loadState === 'loading' && states.length === 0) {
      return Array.from({ length: 4 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 7 }).map((__, j) => (
            <td key={j} style={td}>
              <div style={{ height: 12, background: '#1e293b', borderRadius: 4, width: '70%' }} />
            </td>
          ))}
        </tr>
      ));
    }

    if (loadState === 'loaded' && states.length === 0) {
      return (
        <tr>
          <td colSpan={7} style={{ ...td, textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📡</div>
            <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: 4 }}>
              No onboarding activity
            </div>
            <div style={{ color: '#64748b', fontSize: 12 }}>
              No call-home devices have attempted onboarding, or call-home mode is disabled.
            </div>
          </td>
        </tr>
      );
    }

    return states.map((s) => (
      <tr
        key={s.deviceId}
        style={{ background: s.bootstrapState === 'FAILED' ? '#110a0a' : '#0d1b2a' }}
      >
        <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{s.serialNumber}</td>
        <td style={{ ...td, fontSize: 11, color: '#94a3b8' }}>{s.deviceType}</td>
        <td style={td}>
          <StateBadge state={s.bootstrapState} />
        </td>
        <td style={{ ...td, color: '#64748b', fontSize: 11 }}>
          {s.lastSuccessfulState ?? '—'}
        </td>
        <td style={{ ...td, color: '#fca5a5', fontSize: 11 }}>
          {s.failureReason ? (
            <span title={s.failureReason}>{s.failureReason}</span>
          ) : (
            s.commissioningPendingFields ? (
              <span title={`Pending: ${s.commissioningPendingFields}`} style={{ color: '#fcd34d' }}>
                ⏳ {s.commissioningPendingFields}
              </span>
            ) : '—'
          )}
        </td>
        <td style={{ ...td, color: '#64748b', fontSize: 11 }}>
          {s.lastCheckInAt ? <RelativeTime iso={s.lastCheckInAt} /> : '—'}
        </td>
        <td style={{ ...td, color: '#64748b', fontSize: 11 }}>
          {s.lastRealtimeAt ? <RelativeTime iso={s.lastRealtimeAt} /> : '—'}
        </td>
      </tr>
    ));
  };

  return (
    <div style={container} role="region" aria-label="UBR device onboarding state">
      <div style={header}>
        <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 14 }}>
          Device Onboarding Progress
        </span>
        <span style={{ color: '#64748b', fontSize: 11 }}>
          {loadState === 'loaded'
            ? `${states.length} device${states.length !== 1 ? 's' : ''}`
            : loadState === 'loading' ? 'Loading…' : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-busy={loadState === 'loading'}>
          <thead>
            <tr>
              <th style={th}>Serial</th>
              <th style={th}>Type</th>
              <th style={th}>Bootstrap State</th>
              <th style={th}>Last Success</th>
              <th style={th}>Failure / Pending</th>
              <th style={th}>Last Check-In</th>
              <th style={th}>Last Realtime</th>
            </tr>
          </thead>
          <tbody>
            {renderBody()}
          </tbody>
        </table>
      </div>
    </div>
  );
}

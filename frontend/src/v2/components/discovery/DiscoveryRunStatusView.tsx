/**
 * DiscoveryRunStatusView — real-time status monitor for an active discovery run.
 *
 * Polls GET /discovery/runs/:runId every 2 seconds while the run is RUNNING.
 * Displays a progress bar for the ICMP sweep phase, plus key metric counters.
 * Automatically transitions to the results view on COMPLETED, or shows an
 * error message on FAILED/CANCELLED.
 *
 * Polling is unconditionally stopped when the component unmounts (React cleanup).
 */
import { useEffect, useState, useRef, useCallback } from 'react';

import { LoadingState } from '../common/States';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { ProgressIndicator } from './ProgressIndicator';
import { getDiscoveryRun } from '../../../api/discovery.api';
import type { DiscoveryRunDetail, DiscoveryRunStatus } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_ERRORS = 3;
const TERMINAL_STATUSES: DiscoveryRunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

// ── Helper: status → badge variant mapping ────────────────────────────────────

function statusVariant(status: DiscoveryRunStatus): 'success' | 'danger' | 'warning' | 'info' | 'default' {
  switch (status) {
    case 'COMPLETED':  return 'success';
    case 'FAILED':     return 'danger';
    case 'CANCELLED':  return 'warning';
    case 'RUNNING':    return 'info';
    case 'QUEUED':     return 'default';
    default:           return 'default';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryRunStatusViewProps {
  /** UUID of the discovery run to monitor. */
  runId: string;
  /**
   * Called when the run reaches COMPLETED status.
   * Parent should transition to the results view.
   */
  onComplete: () => void;
  /** Optional handler for navigating back to the trigger form. */
  onBack?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * DiscoveryRunStatusView polls a discovery run and shows real-time progress.
 * It is the middle step in the Form → Status → Results workflow.
 */
export function DiscoveryRunStatusView({ runId, onComplete, onBack }: DiscoveryRunStatusViewProps) {
  const [run, setRun] = useState<DiscoveryRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const consecutiveErrors = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false); // prevent double-call of onComplete

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const detail = await getDiscoveryRun(runId);
      consecutiveErrors.current = 0;
      setError(null);
      setRun(detail);
      setLoading(false);

      if (TERMINAL_STATUSES.includes(detail.status)) {
        stopPolling();
        if (detail.status === 'COMPLETED' && !completedRef.current) {
          completedRef.current = true;
          // Brief delay so the user sees "100%" before the view switches.
          setTimeout(() => onComplete(), 800);
        }
      }
    } catch (err: unknown) {
      consecutiveErrors.current += 1;
      logger.error('DiscoveryRunStatusView: poll error', err);

      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setError(`Discovery run "${runId}" was not found. It may have been deleted.`);
        stopPolling();
        return;
      }

      if (consecutiveErrors.current >= MAX_CONSECUTIVE_ERRORS) {
        setError('Lost connection to the discovery service. Please check your network and try again.');
        stopPolling();
        return;
      }

      setError(`Polling error (attempt ${consecutiveErrors.current}/${MAX_CONSECUTIVE_ERRORS}) — retrying…`);
    } finally {
      setLoading(false);
    }
  }, [runId, stopPolling, onComplete]);

  // Start polling on mount; clean up on unmount.
  useEffect(() => {
    poll(); // first fetch immediately
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return stopPolling; // cleanup
  }, [poll, stopPolling]);

  // ── Render helpers ──────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState label="Fetching discovery run status…" />;
  }

  // Sticky error shown after MAX_CONSECUTIVE_ERRORS or 404
  if (error && !run) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          padding: 24,
          border: '1px solid var(--vf-danger)',
          borderRadius: 'var(--vf-radius-lg)',
          background: 'var(--vf-danger-subtle)',
          color: 'var(--vf-danger)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>Discovery status unavailable</span>
        <span style={{ fontSize: 13 }}>{error}</span>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Back to form
          </Button>
        )}
      </div>
    );
  }

  if (!run) return null;

  const sweep = run.sweep;
  const pct = sweep && sweep.totalHosts > 0
    ? Math.round((sweep.hostsScanned / sweep.totalHosts) * 100)
    : run.status === 'COMPLETED' ? 100 : 0;

  const unreachableHosts = sweep
    ? sweep.hostsScanned - sweep.reachableHosts
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Status header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--vf-text-primary)' }}>
            Run {run.runId}
          </span>
          <Badge variant={statusVariant(run.status)} dot>
            {run.status}
          </Badge>
        </div>

        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Back
          </Button>
        )}
      </div>

      {/* Progress bar */}
      <ProgressIndicator
        pct={pct}
        label="ICMP Host Sweep"
        description={
          sweep
            ? `${sweep.hostsScanned} / ${sweep.totalHosts} hosts scanned`
            : run.status === 'QUEUED' ? 'Waiting for worker capacity…' : undefined
        }
        ariaLabel="ICMP sweep progress"
      />

      {/* Metric counters */}
      {sweep && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: 12,
          }}
        >
          <MetricCard label="Total Hosts" value={sweep.totalHosts} />
          <MetricCard label="Scanned" value={sweep.hostsScanned} />
          <MetricCard label="Reachable" value={sweep.reachableHosts} tone="success" />
          {unreachableHosts !== undefined && (
            <MetricCard label="Unreachable" value={unreachableHosts} tone={unreachableHosts > 0 ? 'danger' : undefined} />
          )}
        </div>
      )}

      {/* SNMP metrics (when available) */}
      {run.snmpAttemptCount !== undefined && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge variant="info">SNMP attempted: {run.snmpAttemptCount}</Badge>
          {run.snmpSuccessCount !== undefined && (
            <Badge variant="success">SNMP successful: {run.snmpSuccessCount}</Badge>
          )}
        </div>
      )}

      {/* Transient polling error (still retrying) */}
      {error && (
        <div
          role="status"
          aria-live="polite"
          style={{ fontSize: 12, color: 'var(--vf-warning)', padding: '6px 10px', background: 'var(--vf-warning-subtle)', borderRadius: 'var(--vf-radius-md)' }}
        >
          {error}
        </div>
      )}

      {/* FAILED reason */}
      {run.status === 'FAILED' && run.failureReason && (
        <div
          role="alert"
          style={{ fontSize: 13, color: 'var(--vf-danger)', padding: '10px 14px', background: 'var(--vf-danger-subtle)', borderRadius: 'var(--vf-radius-md)', fontWeight: 500 }}
        >
          <strong>Run failed:</strong> {run.failureReason}
        </div>
      )}
    </div>
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'danger';
}) {
  const color = tone === 'success'
    ? 'var(--vf-success)'
    : tone === 'danger'
    ? 'var(--vf-danger)'
    : 'var(--vf-text-primary)';

  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 'var(--vf-radius-md)',
        background: 'var(--vf-elevated)',
        border: '1px solid var(--vf-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 600, letterSpacing: '0.04em' }}>
        {label.toUpperCase()}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'var(--vf-font-mono)' }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

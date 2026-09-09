/**
 * DiscoveryRunHistory — paginated table of past discovery runs.
 *
 * Fetches runs via the paginated GET /discovery/runs endpoint (WO-003 / WO-015).
 * Supports optional status filter, page navigation, and a "Re-run" callback.
 *
 * Edge cases:
 * - Empty list: shows EmptyState.
 * - API error: shows an error banner and a retry button.
 * - Long status words: rendered as coloured Badge components.
 */
import { useEffect, useState, useCallback } from 'react';

import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { EmptyState, LoadingState } from '../common/States';
import { Select } from '../common/Select';
import { listDiscoveryRuns } from '../../../api/discovery.api';
import type { DiscoveryRunSummary, DiscoveryRunStatus, PaginatedRunsResponse } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryRunHistoryProps {
  /**
   * Optional callback invoked when the user clicks "Re-run" on a completed run.
   * Receives the original scope so the trigger form can be pre-populated.
   */
  onRerun?: (run: DiscoveryRunSummary) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: '',           label: 'All statuses' },
  { value: 'COMPLETED',  label: 'Completed' },
  { value: 'FAILED',     label: 'Failed' },
  { value: 'RUNNING',    label: 'Running' },
  { value: 'QUEUED',     label: 'Queued' },
  { value: 'CANCELLED',  label: 'Cancelled' },
];

const PAGE_SIZE = 15;

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusVariant(status: DiscoveryRunStatus): 'success' | 'danger' | 'warning' | 'default' {
  switch (status) {
    case 'COMPLETED':  return 'success';
    case 'FAILED':     return 'danger';
    case 'RUNNING':    return 'warning';
    case 'QUEUED':     return 'warning';
    case 'CANCELLED':  return 'default';
    default:           return 'default';
  }
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

/** Compute approximate run duration from createdAt and completedAt. */
function duration(run: DiscoveryRunSummary): string {
  if (!run.completedAt || !run.createdAt) return '—';
  try {
    const ms = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime();
    if (ms < 0) return '—';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  } catch {
    return '—';
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * DiscoveryRunHistory renders a paginated, filterable table of past discovery
 * runs. Each row shows run ID, status, scope summary, timestamps, and a
 * "Re-run" action that pre-populates the trigger form with the original scope.
 */
export function DiscoveryRunHistory({ onRerun }: DiscoveryRunHistoryProps) {
  const [page, setPage]             = useState(1);
  const [statusFilter, setStatus]   = useState('');
  const [result, setResult]         = useState<PaginatedRunsResponse | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listDiscoveryRuns(page, PAGE_SIZE, statusFilter || undefined);
      setResult(data);
    } catch (err: unknown) {
      logger.error('DiscoveryRunHistory: listDiscoveryRuns failed', err);
      setError('Failed to load discovery run history. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 whenever the filter changes.
  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setPage(1);
    setStatus(e.target.value);
  }

  const runs   = result?.data ?? [];
  const total  = result?.pagination.total ?? 0;
  const pages  = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ width: 200 }}>
          <Select
            label="Filter by status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={handleStatusChange}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--vf-text-muted)' }}>
          {total > 0 ? `${total} run${total !== 1 ? 's' : ''}` : ''}
        </span>
      </div>

      {/* Error banner */}
      {error && !loading && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            fontSize: 13,
            color: '#f87171',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>⚠️</span>
          <span style={{ flex: 1 }}>{error}</span>
          <Button variant="ghost" size="sm" onClick={load}>Retry</Button>
        </div>
      )}

      {/* Table body */}
      {loading && <LoadingState label="Loading run history…" />}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          icon="📋"
          title="No runs found"
          description={
            statusFilter
              ? `No discovery runs with status "${statusFilter}" found.`
              : 'No discovery runs yet. Use the SNMP Discovery tab to start your first run.'
          }
        />
      )}

      {!loading && runs.length > 0 && (
        <div
          role="table"
          aria-label="Discovery run history"
          style={{ overflowX: 'auto' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {[
                  'Run ID', 'Status', 'Scope', 'Devices Found',
                  'Started', 'Duration', 'Created By', '',
                ].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      padding: '8px 12px',
                      textAlign: 'left',
                      fontWeight: 600,
                      fontSize: 11,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'var(--vf-text-muted)',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run, idx) => (
                <tr
                  key={run.runId}
                  style={{
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                  }}
                >
                  {/* Run ID */}
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {run.runId.slice(0, 8)}…
                  </td>

                  {/* Status */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <Badge variant={statusVariant(run.status)} dot>
                      {run.status}
                    </Badge>
                  </td>

                  {/* Scope summary */}
                  <td style={{ padding: '10px 12px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {run.scopeSummary ?? '—'}
                  </td>

                  {/* Devices found */}
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    {run.devicesFound != null ? run.devicesFound : '—'}
                  </td>

                  {/* Started */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {formatDate(run.createdAt)}
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {duration(run)}
                  </td>

                  {/* Created by */}
                  <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--vf-text-muted)' }}>
                    {run.createdBy ?? '—'}
                  </td>

                  {/* Actions */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    {onRerun && run.status === 'COMPLETED' && run.normalizedScope && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRerun(run)}
                        aria-label={`Re-run discovery run ${run.runId}`}
                      >
                        ↺ Re-run
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
          >
            ← Prev
          </Button>
          <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
            Page {page} of {pages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages || loading}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}

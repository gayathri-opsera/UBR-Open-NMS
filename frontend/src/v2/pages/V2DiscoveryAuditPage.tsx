/**
 * V2DiscoveryAuditPage — Discovery Audit Trail UI (WO-019).
 *
 * Displays a filterable, paginated table of discovery audit events emitted by
 * the discovery-service Kafka publisher (WO-011). Operators can filter by:
 *  - Action type (created, completed, failed)
 *  - Outcome (success, failure)
 *  - Run ID (resourceId)
 *  - Time range (from / to)
 *
 * Edge cases handled:
 *  - API error → error banner + retry button
 *  - Empty results → EmptyState with filter-clear CTA
 *  - Deleted run referenced in audit → resourceId shown as-is (no lookup)
 *  - Audit service unavailable → error banner, does not crash the page
 */
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { EmptyState, LoadingState } from '../components/common/States';
import { Select } from '../components/common/Select';
import { logger } from '../utils/logger';
import {
  listDiscoveryAuditEvents,
  type DiscoveryAuditEvent,
  type DiscoveryAuditPage,
  type DiscoveryAuditQuery,
} from '../../api/discovery-audit.api';

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTION_OPTIONS = [
  { value: '',                          label: 'All actions' },
  { value: 'discovery.run.started',     label: 'Run Started' },
  { value: 'discovery.run.completed',   label: 'Run Completed' },
  { value: 'discovery.run.failed',      label: 'Run Failed' },
];

const OUTCOME_OPTIONS = [
  { value: '',         label: 'All outcomes' },
  { value: 'success',  label: 'Success' },
  { value: 'failure',  label: 'Failure' },
];

const PAGE_SIZE = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    'discovery.run.started':   'Run Started',
    'discovery.run.completed': 'Run Completed',
    'discovery.run.failed':    'Run Failed',
  };
  return map[action] ?? action;
}

function outcomeBadgeVariant(outcome: string): 'success' | 'error' | 'default' {
  if (outcome === 'success') return 'success';
  if (outcome === 'failure') return 'error';
  return 'default';
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function V2DiscoveryAuditPage() {
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [page, setPage]         = useState<DiscoveryAuditPage | null>(null);
  const [currentPage, setCurrentPage] = useState(0);

  // Filters
  const [action,  setAction]   = useState('');
  const [outcome, setOutcome]  = useState('');
  const [runId,   setRunId]    = useState('');
  const [from,    setFrom]     = useState('');
  const [to,      setTo]       = useState('');

  const load = useCallback(
    async (pg: number) => {
      setLoading(true);
      setError(null);
      try {
        const query: DiscoveryAuditQuery = {
          page:  pg,
          limit: PAGE_SIZE,
        };
        if (action)  query.action  = action;
        if (runId)   query.runId   = runId.trim();
        if (from)    query.from    = from;
        if (to)      query.to      = to;

        const result = await listDiscoveryAuditEvents(query);
        // Client-side outcome filter (audit-service may not support it directly).
        const filtered: DiscoveryAuditEvent[] = outcome
          ? result.data.filter((e) => e.outcome === outcome)
          : result.data;
        setPage({ ...result, data: filtered });
        setCurrentPage(pg);
      } catch (err) {
        logger.error('V2DiscoveryAuditPage: failed to load audit events', err);
        setError('Failed to load audit events. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [action, outcome, runId, from, to],
  );

  // Initial load and reload on filter change.
  useEffect(() => {
    load(0);
  }, [load]);

  function clearFilters() {
    setAction('');
    setOutcome('');
    setRunId('');
    setFrom('');
    setTo('');
    setCurrentPage(0);
  }

  const hasFilters = !!(action || outcome || runId || from || to);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Discovery Audit Trail</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Immutable log of all discovery run events for compliance and troubleshooting.
          </p>
        </div>
        {hasFilters && (
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
        <Select
          label="Action"
          value={action}
          onChange={(v) => { setAction(v); setCurrentPage(0); }}
          options={ACTION_OPTIONS}
        />
        <Select
          label="Outcome"
          value={outcome}
          onChange={(v) => { setOutcome(v); setCurrentPage(0); }}
          options={OUTCOME_OPTIONS}
        />
        <Input
          label="Run ID"
          placeholder="Filter by run ID…"
          value={runId}
          onChange={(e) => { setRunId(e.target.value); setCurrentPage(0); }}
        />
        <Input
          label="From"
          type="datetime-local"
          value={from}
          onChange={(e) => { setFrom(e.target.value); setCurrentPage(0); }}
        />
        <Input
          label="To"
          type="datetime-local"
          value={to}
          onChange={(e) => { setTo(e.target.value); setCurrentPage(0); }}
        />
      </div>

      {/* Content */}
      {loading ? (
        <LoadingState message="Loading audit events…" />
      ) : error ? (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => load(currentPage)}>
            Retry
          </Button>
        </div>
      ) : !page || page.data.length === 0 ? (
        <EmptyState
          title="No audit events found"
          description={hasFilters ? 'Try adjusting your filters.' : 'No discovery events have been recorded yet.'}
          action={hasFilters ? { label: 'Clear filters', onClick: clearFilters } : undefined}
        />
      ) : (
        <>
          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  {['Timestamp', 'Action', 'Run ID', 'Outcome', 'Detail'].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
                {page.data.map((evt) => (
                  <tr key={evt.eventId} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600 dark:text-gray-300 font-mono text-xs">
                      {formatTimestamp(evt.producedAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-medium text-gray-900 dark:text-white">{actionLabel(evt.action)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 max-w-[160px] truncate">
                      <span title={evt.resourceId}>{evt.resourceId}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={outcomeBadgeVariant(evt.outcome)}>
                        {evt.outcome}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-[320px] truncate">
                      <span title={evt.detail}>{evt.detail ?? '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 pt-1">
            <span>
              Showing {page.data.length} of {page.totalElements} events
              {page.totalPages > 1 && ` — page ${currentPage + 1} of ${page.totalPages}`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage === 0}
                onClick={() => load(currentPage - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={currentPage >= page.totalPages - 1}
                onClick={() => load(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

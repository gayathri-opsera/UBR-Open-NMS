/**
 * DiscoveryResultsTable — displays the per-host results of a completed discovery run.
 *
 * Fetches results via `getDiscoveryRunResults`, renders them in an `AdvancedTable`
 * with sortable columns, a global text filter, expandable rows for sysDescr detail,
 * and checkbox selection for bulk "Add to Inventory" actions.
 *
 * Edge cases handled:
 * - Empty result set: shows EmptyState component.
 * - Null/undefined fields: rendered as 'N/A'.
 * - Large result sets: client-side filtering via AdvancedTable (up to 5k rows).
 */
import { useEffect, useState, useCallback } from 'react';

import { AdvancedTable } from '../common/AdvancedTable';
import type { ColumnDef } from '../common/AdvancedTable';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { EmptyState, LoadingState } from '../common/States';
import { IcmpStatusBadge, SnmpStatusBadge, ClassificationBadge } from './StatusBadge';
import { getDiscoveryRunResults } from '../../../api/discovery.api';
import type { DiscoveryResult } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely render a nullable string field as 'N/A' when absent. */
function val(v: string | undefined | null): string {
  return v && v.trim() ? v : 'N/A';
}

// ── Column definitions ────────────────────────────────────────────────────────

const COLUMNS: ColumnDef<DiscoveryResult>[] = [
  {
    key: 'ip',
    header: 'IP Address',
    sortable: true,
    width: 140,
    render: (row) => (
      <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 13 }}>{row.ip}</span>
    ),
  },
  {
    key: 'icmpStatus',
    header: 'ICMP',
    sortable: true,
    width: 120,
    render: (row) => <IcmpStatusBadge status={row.icmpStatus} />,
  },
  {
    key: 'snmpStatus',
    header: 'SNMP',
    sortable: true,
    width: 130,
    render: (row) => <SnmpStatusBadge status={row.snmpStatus} />,
  },
  {
    key: 'vendor',
    header: 'Manufacturer',
    sortable: true,
    render: (row) => <span>{val(row.vendor)}</span>,
  },
  {
    key: 'model',
    header: 'Model',
    sortable: true,
    render: (row) => <span>{val(row.model)}</span>,
  },
  {
    key: 'genericDeviceType',
    header: 'Device Type',
    sortable: true,
    width: 120,
    render: (row) => <span>{val(row.genericDeviceType)}</span>,
  },
  {
    key: 'sysObjectID',
    header: 'sysObjectID',
    sortable: true,
    render: (row) => (
      <span
        style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}
        title={val(row.sysObjectID)}
      >
        {row.sysObjectID ? (row.sysObjectID.length > 28 ? row.sysObjectID.slice(0, 28) + '…' : row.sysObjectID) : 'N/A'}
      </span>
    ),
  },
  {
    key: 'classificationStatus',
    header: 'Classification',
    sortable: true,
    width: 130,
    render: (row) => <ClassificationBadge status={row.classificationStatus} />,
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryResultsTableProps {
  /** UUID of the completed discovery run. */
  runId: string;
  /**
   * Called when the operator clicks "Add to Inventory" with the selected results.
   * Receives the array of selected DiscoveryResult entries.
   */
  onAddToInventory?: (selected: DiscoveryResult[]) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * DiscoveryResultsTable is the final step in the Form → Status → Results workflow.
 * It loads all per-host results for a run and lets operators review and onboard devices.
 */
export function DiscoveryResultsTable({ runId, onAddToInventory }: DiscoveryResultsTableProps) {
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Load results on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getDiscoveryRunResults(runId)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logger.error('DiscoveryResultsTable: failed to load results', err);
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          setError('Discovery run not found. It may have expired.');
        } else if (status === 403) {
          setError('You do not have permission to view these discovery results.');
        } else {
          setError('Failed to load discovery results. Please try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [runId]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((ip: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(ip) ? next.delete(ip) : next.add(ip);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === results.length
        ? new Set()
        : new Set(results.map((r) => r.ip)),
    );
  }, [results]);

  // ── Expansion ──────────────────────────────────────────────────────────────

  const toggleExpanded = useCallback((ip: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(ip) ? next.delete(ip) : next.add(ip);
      return next;
    });
  }, []);

  // ── Derived data ──────────────────────────────────────────────────────────

  const selectedResults = results.filter((r) => selected.has(r.ip));

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState label="Loading discovery results…" />;
  }

  if (error) {
    return (
      <div
        role="alert"
        style={{
          padding: '16px 20px',
          border: '1px solid var(--vf-danger)',
          borderRadius: 'var(--vf-radius-md)',
          background: 'var(--vf-danger-subtle)',
          color: 'var(--vf-danger)',
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        {error}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <EmptyState
        icon="🔍"
        title="No devices found"
        description="The discovery scan completed but no hosts responded. Try expanding the scope or adjusting SNMP credentials."
      />
    );
  }

  // Build columns with checkbox prepended
  const columnsWithSelect: ColumnDef<DiscoveryResult>[] = [
    {
      key: '__select',
      header: '', // controlled by the header checkbox below
      width: 40,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.ip}`}
          checked={selected.has(row.ip)}
          onChange={() => toggleSelect(row.ip)}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'pointer', accentColor: 'var(--vf-accent)' }}
        />
      ),
    },
    {
      key: '__expand',
      header: '',
      width: 32,
      render: (row) => (
        <button
          aria-label={`${expanded.has(row.ip) ? 'Collapse' : 'Expand'} details for ${row.ip}`}
          onClick={(e) => { e.stopPropagation(); toggleExpanded(row.ip); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 2,
            color: 'var(--vf-text-muted)',
            fontSize: 12,
          }}
        >
          {expanded.has(row.ip) ? '▲' : '▼'}
        </button>
      ),
    },
    ...COLUMNS,
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            aria-label="Select all devices"
            checked={selected.size === results.length && results.length > 0}
            onChange={toggleSelectAll}
            style={{ cursor: 'pointer', accentColor: 'var(--vf-accent)' }}
          />
          <span style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>
            {results.length} device{results.length !== 1 ? 's' : ''} found
            {selected.size > 0 && `, ${selected.size} selected`}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Input
            placeholder="Filter results…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ minWidth: 200 }}
            aria-label="Filter discovery results"
          />
          {onAddToInventory && (
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => onAddToInventory(selectedResults)}
            >
              Add to Inventory ({selected.size})
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <AdvancedTable<DiscoveryResult>
        columns={columnsWithSelect}
        data={results}
        rowKey={(r) => r.ip}
        globalFilter={filter}
        filterFields={['ip', 'vendor', 'model', 'genericDeviceType', 'sysObjectID', 'sysDescr']}
        emptyMessage="No devices match the current filter"
        stickyHeader
        maxHeight="50vh"
        onRowClick={(row) => toggleExpanded(row.ip)}
      />

      {/* Expanded sysDescr panel (below table) */}
      {expanded.size > 0 && (
        <div
          style={{
            border: '1px solid var(--vf-border-subtle)',
            borderRadius: 'var(--vf-radius-md)',
            overflow: 'hidden',
          }}
        >
          {results
            .filter((r) => expanded.has(r.ip))
            .map((r) => (
              <div
                key={r.ip}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--vf-border-subtle)',
                  fontSize: 12,
                  color: 'var(--vf-text-secondary)',
                }}
              >
                <span style={{ fontFamily: 'var(--vf-font-mono)', fontWeight: 600 }}>{r.ip}</span>
                <span style={{ marginLeft: 12, fontFamily: 'var(--vf-font-mono)' }}>
                  {r.sysDescr ? r.sysDescr : <em>No sysDescr available</em>}
                </span>
                {r.deferReason && (
                  <span
                    style={{
                      marginLeft: 12,
                      padding: '1px 6px',
                      background: 'var(--vf-warning-subtle)',
                      color: 'var(--vf-warning)',
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    {r.deferReason}
                  </span>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

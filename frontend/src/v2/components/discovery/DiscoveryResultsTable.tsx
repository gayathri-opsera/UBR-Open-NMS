/**
 * DiscoveryResultsTable — per-host discovery results with filtering, sorting,
 * comparison, and MIB-II detail (WO-022, WO-026, WO-029, WO-030).
 */
import { useEffect, useState, useCallback, useMemo } from 'react';

import { AdvancedTable } from '../common/AdvancedTable';
import type { ColumnDef } from '../common/AdvancedTable';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { EmptyState, LoadingState } from '../common/States';
import { IcmpStatusBadge, SnmpStatusBadge, ClassificationBadge } from './StatusBadge';
import { DeviceComparisonView } from './DeviceComparisonView';
import {
  EMPTY_FILTERS,
  filterDiscoveryResults,
  uniqueFilterOptions,
  type DiscoveryResultFilters,
} from './discoveryResultFilters';
import { getDiscoveryRunResults } from '../../../api/discovery.api';
import type { DiscoveryResult } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

function val(v: string | undefined | null): string {
  return v && v.trim() ? v : 'N/A';
}

function formatUptime(sec?: number): string {
  if (sec == null || sec <= 0) return 'N/A';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${sec}s`;
}

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
    key: 'sysName',
    header: 'Hostname',
    sortable: true,
    width: 140,
    render: (row) => <span>{val(row.sysName)}</span>,
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
    key: 'sysUpTimeSeconds',
    header: 'Uptime',
    sortable: true,
    width: 100,
    render: (row) => <span>{formatUptime(row.sysUpTimeSeconds)}</span>,
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

export interface DiscoveryResultsTableProps {
  runId: string;
  onAddToInventory?: (selected: DiscoveryResult[]) => void;
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
      <span style={{ fontWeight: 600, color: 'var(--vf-text-muted)' }}>{label}</span>
      <select
        multiple
        value={selected}
        onChange={(e) => {
          const vals = Array.from(e.target.selectedOptions, (o) => o.value);
          onChange(vals);
        }}
        style={{
          minWidth: 120,
          maxWidth: 160,
          fontSize: 12,
          padding: 4,
          borderRadius: 4,
          border: '1px solid var(--vf-border-subtle)',
          background: 'var(--vf-surface)',
        }}
        aria-label={`Filter by ${label}`}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DiscoveryResultsTable({ runId, onAddToInventory }: DiscoveryResultsTableProps) {
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<DiscoveryResultFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);

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

  const filteredResults = useMemo(
    () => filterDiscoveryResults(results, filters),
    [results, filters],
  );

  const vendorOptions = useMemo(() => uniqueFilterOptions(results, (r) => r.vendor), [results]);
  const deviceTypeOptions = useMemo(
    () => uniqueFilterOptions(results, (r) => r.genericDeviceType),
    [results],
  );
  const icmpOptions = useMemo(() => uniqueFilterOptions(results, (r) => r.icmpStatus), [results]);
  const snmpOptions = useMemo(() => uniqueFilterOptions(results, (r) => r.snmpStatus), [results]);

  const toggleSelect = useCallback((ip: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(ip) ? next.delete(ip) : next.add(ip);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === filteredResults.length
        ? new Set()
        : new Set(filteredResults.map((r) => r.ip)),
    );
  }, [filteredResults]);

  const toggleExpanded = useCallback((ip: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(ip) ? next.delete(ip) : next.add(ip);
      return next;
    });
  }, []);

  const selectedResults = results.filter((r) => selected.has(r.ip));
  const canCompare = selectedResults.length >= 2 && selectedResults.length <= 4;

  if (loading) {
    return <LoadingState label="Loading discovery results…" />;
  }

  if (error) {
    return (
      <div role="alert" style={{
        padding: '16px 20px',
        border: '1px solid var(--vf-danger)',
        borderRadius: 'var(--vf-radius-md)',
        background: 'var(--vf-danger-subtle)',
        color: 'var(--vf-danger)',
        fontSize: 13,
        fontWeight: 500,
      }}>
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

  const columnsWithSelect: ColumnDef<DiscoveryResult>[] = [
    {
      key: '__select',
      header: '',
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
      {/* Filter bar (WO-029) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          padding: '12px 14px',
          background: 'var(--vf-surface)',
          borderRadius: 'var(--vf-radius-md)',
          border: '1px solid var(--vf-border-subtle)',
        }}
      >
        <MultiSelectFilter
          label="ICMP"
          options={icmpOptions}
          selected={filters.icmpStatus}
          onChange={(icmpStatus) => setFilters((f) => ({ ...f, icmpStatus }))}
        />
        <MultiSelectFilter
          label="SNMP"
          options={snmpOptions}
          selected={filters.snmpStatus}
          onChange={(snmpStatus) => setFilters((f) => ({ ...f, snmpStatus }))}
        />
        <MultiSelectFilter
          label="Vendor"
          options={vendorOptions}
          selected={filters.vendor}
          onChange={(vendor) => setFilters((f) => ({ ...f, vendor }))}
        />
        <MultiSelectFilter
          label="Device type"
          options={deviceTypeOptions}
          selected={filters.deviceType}
          onChange={(deviceType) => setFilters((f) => ({ ...f, deviceType }))}
        />
        <Input
          placeholder="Search all columns…"
          value={filters.globalSearch}
          onChange={(e) => setFilters((f) => ({ ...f, globalSearch: e.target.value }))}
          style={{ minWidth: 200, flex: 1 }}
          aria-label="Filter discovery results"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters(EMPTY_FILTERS)}
        >
          Clear filters
        </Button>
      </div>

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
            checked={selected.size === filteredResults.length && filteredResults.length > 0}
            onChange={toggleSelectAll}
            style={{ cursor: 'pointer', accentColor: 'var(--vf-accent)' }}
          />
          <span style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>
            {filteredResults.length} of {results.length} device{results.length !== 1 ? 's' : ''}
            {selected.size > 0 && `, ${selected.size} selected`}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canCompare}
            title={canCompare ? 'Compare selected devices' : 'Select 2–4 devices to compare'}
            onClick={() => setCompareOpen(true)}
          >
            Compare ({selected.size})
          </Button>
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

      {filteredResults.length === 0 ? (
        <EmptyState
          icon="🔎"
          title="No results match filters"
          description="Adjust or clear the filter controls above to see devices again."
        />
      ) : (
        <AdvancedTable<DiscoveryResult>
          columns={columnsWithSelect}
          data={filteredResults}
          rowKey={(r) => r.ip}
          emptyMessage="No devices match the current filter"
          stickyHeader
          maxHeight="50vh"
          onRowClick={(row) => toggleExpanded(row.ip)}
        />
      )}

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
                <div style={{ fontFamily: 'var(--vf-font-mono)', fontWeight: 600, marginBottom: 6 }}>
                  {r.ip}
                  {r.sysName && r.sysName !== 'N/A' && (
                    <span style={{ marginLeft: 10, fontWeight: 500 }}>({r.sysName})</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                  <span><strong>sysDescr:</strong> {r.sysDescr ?? '—'}</span>
                  <span><strong>Contact:</strong> {r.sysContact ?? '—'}</span>
                  <span><strong>Location:</strong> {r.sysLocation ?? '—'}</span>
                  <span><strong>Uptime:</strong> {formatUptime(r.sysUpTimeSeconds)}</span>
                </div>
                {r.deferReason && (
                  <span
                    style={{
                      display: 'inline-block',
                      marginTop: 8,
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

      <DeviceComparisonView
        open={compareOpen}
        devices={selectedResults}
        onClose={() => setCompareOpen(false)}
        onAddToInventory={onAddToInventory}
      />
    </div>
  );
}

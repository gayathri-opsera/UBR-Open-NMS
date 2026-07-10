import React, { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc' | null;

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: number | string;
  align?: 'left' | 'center' | 'right';
  hidden?: boolean;
}

export interface AdvancedTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyMessage?: string;
  stickyHeader?: boolean;
  maxHeight?: number | string;
  globalFilter?: string;
  filterFields?: (keyof T)[];
}

export function AdvancedTable<T>({
  columns, data, rowKey, onRowClick, loading = false,
  emptyMessage = 'No data', stickyHeader = true, maxHeight = '60vh',
  globalFilter = '', filterFields,
}: AdvancedTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => new Set(columns.map((c) => c.key)));

  const toggleSort = (key: string) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); }
    else if (sortDir === 'asc') setSortDir('desc');
    else { setSortKey(null); setSortDir(null); }
  };

  const filtered = useMemo(() => {
    if (!globalFilter) return data;
    const q = globalFilter.toLowerCase();
    return data.filter((row) => {
      const fields = filterFields ?? (Object.keys(row as object) as (keyof T)[]);
      return fields.some((f) => String(row[f] ?? '').toLowerCase().includes(q));
    });
  }, [data, globalFilter, filterFields]);

  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return filtered;
    return [...filtered].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey] ?? '';
      const bv = (b as Record<string, unknown>)[sortKey] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const visible = columns.filter((c) => !c.hidden && visibleCols.has(c.key));

  const th: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--vf-text-muted)',
    background: 'var(--vf-surface)',
    borderBottom: '1px solid var(--vf-border-subtle)',
    whiteSpace: 'nowrap',
    position: stickyHeader ? 'sticky' : undefined,
    top: stickyHeader ? 0 : undefined,
    zIndex: stickyHeader ? 1 : undefined,
    cursor: 'default',
    userSelect: 'none',
  };

  return (
    <div style={{ position: 'relative' }}>
      {/* Column visibility toggle */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 4, flexWrap: 'wrap' }}>
        {columns.filter((c) => !c.hidden).map((c) => (
          <button
            key={c.key}
            onClick={() => setVisibleCols((prev) => {
              const next = new Set(prev);
              next.has(c.key) ? next.delete(c.key) : next.add(c.key);
              return next;
            })}
            style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 'var(--vf-radius-sm)',
              background: visibleCols.has(c.key) ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
              color: visibleCols.has(c.key) ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
              border: '1px solid var(--vf-border-subtle)', cursor: 'pointer', fontFamily: 'var(--vf-font-sans)',
            }}
          >
            {c.header}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight, border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)' }}>
        <table
          role="grid"
          aria-rowcount={sorted.length}
          style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)' }}
        >
          <thead>
            <tr>
              {visible.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={{ ...th, width: col.width, textAlign: col.align ?? 'left', cursor: col.sortable ? 'pointer' : 'default' }}
                  onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  {col.header}
                  {col.sortable && (
                    <span aria-hidden="true" style={{ marginLeft: 4, opacity: 0.5 }}>
                      {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {visible.map((col) => (
                    <td key={col.key} style={{ padding: '10px 12px' }}>
                      <div style={{ height: 14, background: 'var(--vf-elevated)', borderRadius: 4, animation: 'vf-skeleton-shimmer 1.4s ease-in-out infinite', backgroundSize: '200% 100%' }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={visible.length} style={{ textAlign: 'center', padding: 40, color: 'var(--vf-text-muted)', fontSize: 13 }}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              sorted.map((row, idx) => (
                <tr
                  key={rowKey(row) || `__row-${idx}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{
                    cursor: onRowClick ? 'pointer' : 'default',
                    borderBottom: '1px solid var(--vf-border-subtle)',
                    transition: 'background var(--vf-transition-fast)',
                  }}
                  onMouseEnter={(e) => { if (onRowClick) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--vf-elevated)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ''; }}
                >
                  {visible.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '10px 12px',
                        fontSize: 13,
                        color: 'var(--vf-text-primary)',
                        textAlign: col.align ?? 'left',
                        verticalAlign: 'middle',
                      }}
                    >
                      {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 0', fontSize: 11, color: 'var(--vf-text-muted)' }}>
        {sorted.length} of {data.length} rows
      </div>
    </div>
  );
}

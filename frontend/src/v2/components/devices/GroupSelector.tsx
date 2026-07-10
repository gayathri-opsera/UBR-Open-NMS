/**
 * GroupSelector — REQ-015 / NMS-INV-05
 *
 * Inline drop-down that lets an operator pick one or more Device Groups.
 * Designed to be embedded in the Devices page filter bar, bulk-action panels,
 * and the KPI / Topology filter strips.
 *
 * Usage:
 *   <GroupSelector value={selectedGroupIds} onChange={setSelectedGroupIds} />
 *
 * When `multi` is false (default) it behaves like a single select.
 * When `multi` is true all chosen groups are highlighted and passed as an array.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchGroups } from '../../../api/groups.api';
import type { DeviceGroup } from '../../../api/groups.api';

interface Props {
  /** Currently selected group id(s) */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Allow selecting more than one group (default: false) */
  multi?: boolean;
  /** Placeholder shown when nothing is selected */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const GROUP_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

export function GroupSelector({
  value, onChange, multi = false, placeholder = 'Filter by group…', disabled = false,
}: Props) {
  const [groups, setGroups]   = useState<DeviceGroup[]>([]);
  const [open, setOpen]       = useState(false);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(true);
  const ref                   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchGroups()
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function toggle(id: string) {
    if (multi) {
      onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    } else {
      onChange(value.includes(id) ? [] : [id]);
      setOpen(false);
    }
  }

  function clearAll() { onChange([]); }

  const filtered = groups.filter((g) =>
    !search || g.name.toLowerCase().includes(search.toLowerCase())
  );

  const selectedGroups = groups.filter((g) => value.includes(g.id));

  return (
    <div ref={ref} style={{ position: 'relative', userSelect: 'none' }}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 6,
          border: '1px solid var(--vf-border-subtle)',
          background: open ? 'rgba(59,130,246,0.08)' : 'var(--vf-surface)',
          color: 'var(--vf-text-primary)', cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 13, minWidth: 180, maxWidth: 280, textAlign: 'left',
          transition: 'border-color 0.15s', whiteSpace: 'nowrap', overflow: 'hidden',
          borderColor: open ? 'rgba(59,130,246,0.5)' : undefined,
        }}
      >
        {selectedGroups.length === 0 ? (
          <span style={{ color: 'var(--vf-text-muted)' }}>{placeholder}</span>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, overflow: 'hidden' }}>
            {selectedGroups.slice(0, 2).map((g) => (
              <span key={g.id} style={{
                background: g.color ?? colorForId(g.id), color: '#fff',
                borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600,
              }}>
                {g.name}
              </span>
            ))}
            {selectedGroups.length > 2 && (
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>+{selectedGroups.length - 2}</span>
            )}
          </div>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--vf-text-muted)', fontSize: 10 }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {/* Clear badge */}
      {value.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); clearAll(); }}
          title="Clear group filter"
          style={{
            position: 'absolute', top: '50%', right: 30, transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--vf-text-muted)', fontSize: 12, padding: 2,
          }}
        >
          ✕
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 9999,
          background: 'var(--vf-surface-elevated, #1e293b)',
          border: '1px solid var(--vf-border-subtle)', borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', minWidth: 220, maxWidth: 320,
          maxHeight: 320, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--vf-border-subtle)' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search groups…"
              style={{
                width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 5, padding: '4px 8px', color: 'var(--vf-text-primary)', fontSize: 12, outline: 'none',
              }}
            />
          </div>

          {/* List */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading ? (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 12 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 12 }}>
                {groups.length === 0 ? 'No groups created yet' : 'No groups match'}
              </div>
            ) : (
              filtered.map((g) => {
                const selected = value.includes(g.id);
                const color    = g.color ?? colorForId(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggle(g.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                      padding: '8px 12px', border: 'none', textAlign: 'left', cursor: 'pointer',
                      background: selected ? 'rgba(59,130,246,0.1)' : 'transparent',
                      color: 'var(--vf-text-primary)', fontSize: 13,
                      transition: 'background 0.1s',
                      borderLeft: selected ? `3px solid ${color}` : '3px solid transparent',
                    }}
                    onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Color dot */}
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', flexShrink: 0 }}>{g.deviceIds.length} devices</span>
                    {selected && <span style={{ color: '#3b82f6', fontSize: 14, flexShrink: 0 }}>✓</span>}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          {multi && value.length > 0 && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--vf-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{value.length} selected</span>
              <button type="button" onClick={clearAll} style={{ fontSize: 11, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer' }}>
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

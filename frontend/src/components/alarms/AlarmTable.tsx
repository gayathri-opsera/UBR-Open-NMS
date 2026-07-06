import React, { useState } from 'react';
import type { Alarm, Severity } from '../../api/alarms.types';
import { SkeletonRow } from '../common/Skeleton';

const SEV_META: Record<Severity, { bg: string; text: string; icon: string; label: string }> = {
  CRITICAL:      { bg: '#7f1d1d', text: '#fca5a5', icon: '⛔', label: 'Critical' },
  MAJOR:         { bg: '#78350f', text: '#fcd34d', icon: '🔴', label: 'Major' },
  MINOR:         { bg: '#713f12', text: '#fde68a', icon: '🟠', label: 'Minor' },
  WARNING:       { bg: '#1e3a5f', text: '#93c5fd', icon: '🟡', label: 'Warning' },
  CLEAR:         { bg: '#14532d', text: '#86efac', icon: '🟢', label: 'Cleared' },
  INDETERMINATE: { bg: '#374151', text: '#d1d5db', icon: '⚪', label: 'Indeterminate' },
};

type SortKey = 'severity' | 'alarmName' | 'deviceId' | 'timestamp' | 'state';
const SEV_ORDER: Record<Severity, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2, WARNING: 3, INDETERMINATE: 4, CLEAR: 5 };

interface Props {
  alarms: Alarm[];
  onAcknowledge(id: string): void;
  loading?: boolean;
}

function duration(raisedAt: string, clearedAt?: string): string {
  const s = Math.floor(((clearedAt ? new Date(clearedAt).getTime() : Date.now()) - new Date(raisedAt).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function AlarmTable({ alarms, onAcknowledge, loading }: Props): React.ReactElement {
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = [...alarms].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'severity') cmp = (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5);
    else if (sortKey === 'timestamp') cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    else cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''));
    return sortAsc ? cmp : -cmp;
  });

  const th: React.CSSProperties = {
    padding: '8px 12px', background: '#0f172a', color: '#94a3b8',
    fontSize: 11, textAlign: 'left', fontWeight: 700, borderBottom: '1px solid #1e293b',
    textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '8px 12px', borderBottom: '1px solid #0f172a',
    fontSize: 13, color: '#cbd5e1', verticalAlign: 'middle',
  };

  const SortIcon = ({ col }: { col: SortKey }) =>
    sortKey === col
      ? <span aria-hidden="true" style={{ marginLeft: 4, fontSize: 10, opacity: 0.9 }}>{sortAsc ? '▲' : '▼'}</span>
      : <span aria-hidden="true" style={{ marginLeft: 4, fontSize: 10, opacity: 0.3 }}>⇅</span>;

  const ThSort = ({ col, label }: { col: SortKey; label: string }) => (
    <th
      style={th}
      className="nms-th-sortable"
      onClick={() => handleSort(col)}
      aria-sort={sortKey === col ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(col); } }}
    >
      {label}<SortIcon col={col} />
    </th>
  );

  return (
    <div style={{ overflowX: 'auto' }} role="region" aria-label="Alarm list">
      <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }} aria-busy={loading}>
        <thead>
          <tr>
            <ThSort col="severity" label="Severity" />
            <ThSort col="alarmName" label="Alarm" />
            <ThSort col="deviceId" label="Device" />
            <th style={th}>Type</th>
            <ThSort col="timestamp" label="Time" />
            <th style={th}>Duration</th>
            <ThSort col="state" label="State" />
            <th style={th}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={8} />)}

          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={8} style={{ ...td, textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔕</div>
                <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: 4 }}>No alarms match your filters</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>Try adjusting the time range or severity filter.</div>
              </td>
            </tr>
          )}

          {!loading && sorted.map((alarm) => {
            const meta = SEV_META[alarm.severity] ?? SEV_META.INDETERMINATE;
            return (
              <tr key={alarm.id} style={{ background: '#0d1b2a' }}>
                <td style={td}>
                  <span
                    style={{ background: meta.bg, color: meta.text, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
                    role="img"
                    aria-label={`Severity: ${meta.label}`}
                  >
                    <span aria-hidden="true">{meta.icon} </span>{alarm.severity}
                  </span>
                </td>
                <td style={td}>{alarm.alarmName}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{alarm.deviceId}</td>
                <td style={{ ...td, color: '#94a3b8' }}>{alarm.deviceType}</td>
                <td style={{ ...td, color: '#94a3b8', fontSize: 12 }}>
                  <time dateTime={alarm.timestamp}>{new Date(alarm.timestamp).toLocaleString()}</time>
                </td>
                <td style={{ ...td, color: '#94a3b8' }}>
                  <span aria-label={`Duration: ${duration(alarm.timestamp, alarm.clearedAt)}`}>
                    {duration(alarm.timestamp, alarm.clearedAt)}
                  </span>
                </td>
                <td style={td}>
                  <span
                    style={{ color: alarm.state === 'ACTIVE' ? '#f87171' : alarm.state === 'ACKNOWLEDGED' ? '#fcd34d' : '#86efac', fontWeight: 600 }}
                    aria-label={`State: ${alarm.state}`}
                  >
                    {alarm.state === 'ACTIVE' ? '● ACTIVE' : alarm.state === 'ACKNOWLEDGED' ? '◐ ACK' : '○ CLEARED'}
                  </span>
                </td>
                <td style={td}>
                  {alarm.state === 'ACTIVE' && (
                    <button
                      onClick={() => onAcknowledge(alarm.id)}
                      aria-label={`Acknowledge alarm: ${alarm.alarmName} on ${alarm.deviceId}`}
                      style={{
                        background: 'none', border: '1px solid #374151', color: '#60a5fa',
                        padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      Ack
                    </button>
                  )}
                  {alarm.state === 'ACKNOWLEDGED' && alarm.acknowledgedBy && (
                    <span style={{ color: '#475569', fontSize: 11 }}>by {alarm.acknowledgedBy}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

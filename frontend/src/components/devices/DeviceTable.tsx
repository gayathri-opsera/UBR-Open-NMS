import type { Device, DeviceType } from '../../api/devices.types';
import React, { useState } from 'react';
import { SkeletonRow } from '../common/Skeleton';

interface Props {
  devices: Device[];
  onSelect(device: Device): void;
  loading?: boolean;
}

const STATUS_META: Record<string, { bg: string; color: string; icon: string }> = {
  ONLINE:       { bg: '#14532d', color: '#86efac', icon: '●' },
  OFFLINE:      { bg: '#7f1d1d', color: '#fca5a5', icon: '●' },
  PROVISIONING: { bg: '#1e3a5f', color: '#93c5fd', icon: '◌' },
  UNKNOWN:      { bg: '#374151', color: '#9ca3af', icon: '○' },
};

const TYPE_ICON: Record<DeviceType, string> = { BTS: '🗼', CPE: '📡', IDU: '🔌' };

type SortKey = 'deviceType' | 'serialNumber' | 'ipAddress' | 'status' | 'firmwareVersion' | 'lastSeenAt';

export function DeviceTable({ devices, onSelect, loading }: Props): React.ReactElement {
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const STATUS_ORDER: Record<string, number> = { OFFLINE: 0, UNKNOWN: 1, PROVISIONING: 2, ONLINE: 3 };

  const sorted = [...devices].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'status') cmp = (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
    else cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''));
    return sortAsc ? cmp : -cmp;
  });

  const th: React.CSSProperties = {
    padding: '8px 12px', background: '#0f172a', color: '#94a3b8',
    fontSize: 11, textAlign: 'left', fontWeight: 700, borderBottom: '1px solid #1e293b',
    textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '8px 12px', borderBottom: '1px solid #0f172a', fontSize: 13, color: '#cbd5e1',
    verticalAlign: 'middle',
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
    <div style={{ overflowX: 'auto' }} role="region" aria-label="Device inventory">
      <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }} aria-busy={loading}>
        <thead>
          <tr>
            <ThSort col="deviceType" label="Type" />
            <ThSort col="serialNumber" label="Serial" />
            <ThSort col="ipAddress" label="IP Address" />
            <th style={th}>MAC</th>
            <ThSort col="status" label="Status" />
            <ThSort col="firmwareVersion" label="Firmware" />
            <th style={th}>GPS</th>
            <ThSort col="lastSeenAt" label="Last Seen" />
            <th style={th}>Pending</th>
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={9} />)}

          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={9} style={{ ...td, textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: 4 }}>No devices found</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  Try a different search term or clear your filters. New devices appear here once they check in.
                </div>
              </td>
            </tr>
          )}

          {!loading && sorted.map((device) => {
            const badge = STATUS_META[device.status] ?? STATUS_META.UNKNOWN;
            const coords = device.location?.coordinates;
            const isOffline = device.status === 'OFFLINE';
            const pendingCount = device.pendingCommandCount ?? 0;

            return (
              <tr
                key={device.id}
                style={{ background: isOffline ? '#110a0a' : '#0d1b2a', cursor: 'pointer' }}
                onClick={() => onSelect(device)}
                tabIndex={0}
                role="button"
                aria-label={`${device.deviceType} device ${device.serialNumber}, status: ${device.status}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(device); } }}
              >
                <td style={td}>
                  <span aria-hidden="true">{TYPE_ICON[device.deviceType] ?? ''} </span>
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>{device.deviceType}</span>
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{device.serialNumber}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{device.ipAddress}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>{device.macAddress}</td>
                <td style={td}>
                  <span
                    style={{ background: badge.bg, color: badge.color, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
                    aria-label={`Status: ${device.status}`}
                  >
                    <span aria-hidden="true">{badge.icon} </span>{device.status}
                  </span>
                </td>
                <td style={{ ...td, color: '#94a3b8', fontSize: 12 }}>{device.firmwareVersion}</td>
                <td style={{ ...td, color: '#64748b', fontSize: 11 }}>
                  {coords ? (
                    <a
                      href={`https://maps.google.com/?q=${coords[1]},${coords[0]}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View GPS location: ${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`}
                      style={{ color: '#60a5fa', textDecoration: 'none', fontSize: 11 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {coords[1].toFixed(4)}, {coords[0].toFixed(4)}
                    </a>
                  ) : '—'}
                </td>
                <td style={{ ...td, color: '#64748b', fontSize: 12 }}>
                  {device.lastSeenAt ? (
                    <time dateTime={device.lastSeenAt} title={new Date(device.lastSeenAt).toLocaleString()}>
                      {relativeTime(device.lastSeenAt)}
                    </time>
                  ) : '—'}
                </td>
                <td style={td}>
                  {pendingCount > 0 && (
                    <span
                      style={{ background: '#78350f', color: '#fcd34d', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}
                      aria-label={`${pendingCount} pending commands`}
                      title={`${pendingCount} commands queued for delivery`}
                    >
                      ⏳ {pendingCount}
                    </span>
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

function relativeTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

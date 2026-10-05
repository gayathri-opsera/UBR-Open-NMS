/**
 * DiscoveryResultsTable — per-host discovery results with filtering, sorting,
 * comparison, and MIB-II detail (WO-022, WO-026, WO-029, WO-030).
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

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
import type { Device } from '../../../api/devices.types';
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
  /** Called when the admin clicks "Provision" on a single device card (card view). */
  onProvision?: (result: DiscoveryResult) => void;
  /** Set of IPs that have already been provisioned in this session (shown with ✅). */
  provisionedIPs?: Set<string>;
  /**
   * Map of ip → Device for devices already in the managed inventory.
   * Built by the parent by calling GET /api/v1/devices and indexing by ipAddress.
   * When a discovered IP matches, the card shows "Already Provisioned" + Deprovision.
   */
  inventoryDeviceMap?: Map<string, Device>;
  /**
   * True while the inventory cross-reference is being fetched.
   * During this window card action areas show a skeleton instead of the
   * "Provision Device" button so already-provisioned devices don't flash the wrong state.
   */
  inventoryMapLoading?: boolean;
  /**
   * Called when the admin confirms deprovisioning a device.
   * Receives the discovery result and the inventory device ID to delete.
   */
  onDeprovision?: (result: DiscoveryResult, device: Device) => void;
  /**
   * Set of IPs whose deprovisioning DELETE is currently in flight.
   * Cards show a spinner and the button is disabled while in this set.
   */
  deprovisioningIPs?: Set<string>;
  /**
   * Set of IPs successfully deprovisioned in this session.
   * Cards show a "Deprovisioned" badge + Re-provision button (not the plain Provision button)
   * per the spec state machine: Deprovisioned → Re-provision → Provisioned.
   */
  deprovisionedIPs?: Set<string>;
  /**
   * Set of IPs the admin has suppressed from the results.
   * Ignored devices are hidden from the main list by default.
   * A "Show Ignored" toggle lets the admin reveal and un-ignore them.
   */
  ignoredIPs?: Set<string>;
  /** Called when the admin clicks "Ignore" on a single host. */
  onIgnore?: (result: DiscoveryResult) => void;
  /** Called when the admin clicks "Un-ignore" on an already-ignored host. */
  onUnignore?: (result: DiscoveryResult) => void;
}

// ── Tree-style Device Card (matches the spec format) ─────────────────────────

function icmpIcon(status: string): string {
  if (status === 'reachable') return '✅';
  if (status === 'unreachable') return '❌';
  if (status === 'bypassed' || status === 'not_attempted') return '—';  // ICMP not applicable
  return '⚠️';
}

function snmpIcon(status: string): string {
  if (status === 'success') return '✅';
  if (status === 'not_attempted') return '⬜';
  return '❌';
}

/**
 * True when ICMP was responsive OR bypass mode was active.
 * Used only for ICMP-level display logic.
 */
function isEffectivelyReachable(r: DiscoveryResult): boolean {
  return r.icmpStatus === 'reachable' || r.icmpStatus === 'bypassed';
}

/**
 * True when the device can be provisioned — i.e. SNMP interrogation actually
 * returned data.  This is the authoritative gate for the Provision button.
 * ICMP status is irrelevant here: a device is provisionable iff we have SNMP data.
 */
function canProvision(r: DiscoveryResult): boolean {
  return r.snmpStatus === 'success';
}

/**
 * Overall discovery icon — driven by SNMP (the data-collection step), not ICMP.
 *   ✅  SNMP succeeded  → device fully discovered
 *   ⚠️  ICMP reached but SNMP failed  → partial
 *   ❌  Neither ICMP nor SNMP succeeded
 */
function overallIcon(r: DiscoveryResult): string {
  if (r.snmpStatus === 'success')    return '✅';
  if (isEffectivelyReachable(r))     return '⚠️';  // ICMP/bypass OK but SNMP failed
  return '❌';
}

/** Shared style for quick-nav link buttons inside cards */
const navBtnStyle: React.CSSProperties = {
  fontSize: 10, padding: '2px 8px', borderRadius: 4,
  background: 'var(--vf-accent-subtle)', color: 'var(--vf-accent)',
  border: '1px solid var(--vf-border-subtle)', cursor: 'pointer',
  fontFamily: 'var(--vf-font-sans)', fontWeight: 600, whiteSpace: 'nowrap',
};

function DeviceCard({
  r,
  onProvision,
  provisioned,
  inventoryDevice,
  inventoryMapLoading,
  onDeprovision,
  onNavigate,
  deprovisioning,
  deprovisioned,
  ignored,
  onIgnore,
  onUnignore,
}: {
  r: DiscoveryResult;
  onProvision?: (result: DiscoveryResult) => void;
  /** True if provisioned in the current session (not yet persisted to a DB snapshot). */
  provisioned?: boolean;
  /** The inventory Device record when this IP is already in managed inventory. */
  inventoryDevice?: Device;
  /**
   * True while the parent is fetching the inventory cross-reference map.
   * Shows a skeleton in the action area to prevent the "Provision Device" button
   * from briefly flashing for already-provisioned devices.
   */
  inventoryMapLoading?: boolean;
  onDeprovision?: (result: DiscoveryResult, device: Device) => void;
  /** navigate function from the parent so cards don't each instantiate their own router hook. */
  onNavigate?: (path: string) => void;
  /** True while DELETE is in flight — shows spinner, disables the button. */
  deprovisioning?: boolean;
  /** True after a successful deprovision — shows Deprovisioned badge + Re-provision. */
  deprovisioned?: boolean;
  /** True when this host has been admin-suppressed from the discovery results. */
  ignored?: boolean;
  /** Called when the admin suppresses this host. */
  onIgnore?: (result: DiscoveryResult) => void;
  /** Called when the admin lifts the suppress. */
  onUnignore?: (result: DiscoveryResult) => void;
}) {
  // Inline deprovision confirmation state — avoids a separate modal for a simple action.
  const [confirmingDeprovision, setConfirmingDeprovision] = useState(false);
  const rows: Array<{ label: string; value: string; icon?: string }> = [
    {
      label: 'ICMP',
      value: r.icmpStatus === 'reachable'      ? 'Reachable'
           : r.icmpStatus === 'bypassed'       ? 'N/A (hostname target)'
           : r.icmpStatus === 'not_attempted'  ? 'N/A (SNMP-only probe)'
           : r.icmpStatus === 'unreachable'    ? 'Unreachable'
           : 'Timeout',
      icon: icmpIcon(r.icmpStatus),
    },
    { label: 'SNMP',          value: r.snmpStatus === 'success' ? 'Successful' : r.snmpStatus === 'not_attempted' ? 'Not Attempted' : r.snmpStatus === 'auth_failed' ? 'Auth Failed' : r.snmpStatus === 'timeout' ? 'Timeout' : 'Partial', icon: snmpIcon(r.snmpStatus) },
    { label: 'Manufacturer',  value: val(r.vendor) },
    { label: 'Model',         value: val(r.model) },
    { label: 'Hostname',      value: val(r.sysName) },
    { label: 'MAC Address',   value: val(r.macAddress) },
    { label: 'Device Type',   value: val(r.genericDeviceType) },
    { label: 'Device Role',   value: r.deviceRole ? r.deviceRole : 'Not reported' },
    { label: 'GPS',           value: r.latitude != null && r.longitude != null ? `${r.latitude}, ${r.longitude}` : 'Not reported' },
    { label: 'sysObjectID',   value: val(r.sysObjectID) },
    { label: 'sysDescr',      value: r.sysDescr ? (r.sysDescr.length > 80 ? r.sysDescr.slice(0, 80) + '…' : r.sysDescr) : 'N/A' },
    { label: 'Location',      value: val(r.sysLocation) },
    { label: 'Contact',       value: val(r.sysContact) },
    { label: 'Uptime',        value: formatUptime(r.sysUpTimeSeconds) },
    { label: 'Discovery',     value: overallIcon(r) === '✅' ? 'Successful' : 'Failed', icon: overallIcon(r) },
  ];

  const borderColor = overallIcon(r) === '✅' ? 'rgba(34,197,94,0.4)' : overallIcon(r) === '❌' ? 'rgba(239,68,68,0.4)' : 'rgba(251,191,36,0.4)';

  return (
    <div
      style={{
        background: 'var(--vf-surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--vf-radius-lg)',
        padding: '14px 18px',
        fontFamily: 'var(--vf-font-mono)',
        fontSize: 13,
      }}
    >
      {/* IP heading */}
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)', marginBottom: 10 }}>
        {r.ip}
      </div>

      {/* Tree rows */}
      {rows.map(({ label, value, icon }, idx) => {
        const isLast = idx === rows.length - 1;
        const connector = isLast ? '└──' : '├──';
        return (
          <div
            key={label}
            style={{
              display: 'flex',
              gap: 8,
              padding: '3px 0',
              borderLeft: '2px solid var(--vf-border-subtle)',
              marginLeft: 6,
              paddingLeft: 10,
              color: 'var(--vf-text-secondary)',
              fontSize: 12,
            }}
          >
            <span style={{ color: 'var(--vf-text-muted)', minWidth: 28, flexShrink: 0 }}>{connector}</span>
            <span style={{ color: 'var(--vf-accent)', minWidth: 120, flexShrink: 0, fontWeight: 600 }}>{label}:</span>
            <span style={{ color: 'var(--vf-text-primary)' }}>
              {icon && <span style={{ marginRight: 4 }}>{icon}</span>}
              {value}
            </span>
          </div>
        );
      })}

      {/* ── Provision / status action bar ─────────────────────────────── */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--vf-border-subtle)' }}>

        {/* LOADING: inventory cross-reference still in flight — show skeleton */}
        {inventoryMapLoading && !provisioned && !deprovisioned && !deprovisioning ? (
          <div style={{
            height: 28, borderRadius: 6,
            background: 'linear-gradient(90deg, var(--vf-surface-raised) 25%, var(--vf-border-subtle) 50%, var(--vf-surface-raised) 75%)',
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.4s infinite',
            opacity: 0.6,
          }} aria-label="Checking inventory status…" />
        ) : (
        /* STATE 1: Already in inventory from a previous session */
        inventoryDevice && !provisioned ? (
          confirmingDeprovision ? (
            /* Inline confirmation — avoids a separate dialog for a simple action */
            <div style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'rgba(239,68,68,0.07)',
              border: '1px solid rgba(239,68,68,0.3)',
            }}>
              <div style={{ fontSize: 12, color: 'var(--vf-danger)', fontWeight: 600, marginBottom: 8 }}>
                ⚠ Remove <strong>{inventoryDevice.serialNumber || r.ip}</strong> from inventory?
              </div>
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 10 }}>
                This will delete the device from managed inventory and remove it from the topology map.
                The device can be re-provisioned from this discovery result later.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDeprovision(false)}
                  style={{ flex: 1 }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmingDeprovision(false);
                    onDeprovision?.(r, inventoryDevice);
                  }}
                  style={{
                    flex: 1, background: 'var(--vf-danger)',
                    color: '#fff', border: 'none', fontWeight: 700,
                  }}
                >
                  🗑 Confirm Deprovision
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Provisioned badge */}
                <div style={{
                  flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, color: '#22c55e', fontWeight: 600,
                }}>
                  <span>✅</span>
                  <div>
                    <div>Provisioned in Inventory</div>
                    <div style={{ fontSize: 10, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)', fontWeight: 400 }}>
                      {inventoryDevice.serialNumber || inventoryDevice.id}
                    </div>
                  </div>
                </div>
                {/* Deprovision trigger */}
                {onDeprovision && (
                  <button
                    onClick={() => !deprovisioning && setConfirmingDeprovision(true)}
                    disabled={deprovisioning}
                    title={deprovisioning ? 'Deprovisioning…' : 'Remove this device from managed inventory'}
                    style={{
                      background: 'rgba(239,68,68,0.08)',
                      border: '1px solid rgba(239,68,68,0.25)',
                      borderRadius: 6, padding: '4px 10px',
                      fontSize: 11, fontWeight: 600, color: 'var(--vf-danger)',
                      cursor: deprovisioning ? 'default' : 'pointer',
                      opacity: deprovisioning ? 0.6 : 1,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!deprovisioning) e.currentTarget.style.background = 'rgba(239,68,68,0.16)'; }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                  >
                    {deprovisioning ? '⏳ Deprovisioning…' : '🗑 Deprovision'}
                  </button>
                )}
              </div>
              {/* Quick nav links */}
              {onNavigate && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {(inventoryDevice.id || inventoryDevice.deviceId) && (
                    <button
                      onClick={() => onNavigate(`/v2/devices/${inventoryDevice.id || inventoryDevice.deviceId}`)}
                      style={navBtnStyle}
                    >
                      📊 Metrics
                    </button>
                  )}
                  <button
                    onClick={() => onNavigate(
                      (inventoryDevice.id || inventoryDevice.deviceId)
                        ? `/v2/devices/${inventoryDevice.id || inventoryDevice.deviceId}`
                        : '/v2/devices'
                    )}
                    style={navBtnStyle}
                  >📋 Inventory</button>
                  <button onClick={() => onNavigate(`/v2/topology?highlight=${encodeURIComponent(r.ip)}`)}  style={navBtnStyle}>🗺 Topology</button>
                </div>
              )}
            </div>
          )

        /* STATE 2: Just provisioned in this session */
        ) : provisioned ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
              <span>✅</span>
              <span>Provisioned — appearing in inventory &amp; topology</span>
            </div>
              {onNavigate && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => onNavigate('/v2/devices')}                                    style={navBtnStyle}>📋 Inventory</button>
                <button onClick={() => onNavigate(`/v2/topology?highlight=${encodeURIComponent(r.ip)}`)} style={navBtnStyle}>🗺 Topology</button>
              </div>
            )}
          </div>

        /* STATE 3: Deprovisioning in flight — spinner */
        ) : deprovisioning ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--vf-text-muted)' }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
            <span>Deprovisioning…</span>
          </div>

        /* STATE 4: Deprovisioned this session — badge + Re-provision */
        ) : deprovisioned ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
              <span style={{
                background: 'rgba(107,114,128,0.12)', color: '#6b7280',
                borderRadius: 5, padding: '2px 8px', fontSize: 11,
              }}>
                ⬛ Deprovisioned
              </span>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontWeight: 400 }}>
                Archived — monitoring stopped
              </span>
            </div>
            {onProvision && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onProvision(r)}
                style={{ width: '100%', fontWeight: 700 }}
                disabled={!canProvision(r)}
                title={!canProvision(r) ? 'SNMP must succeed to re-provision (no device data available)' : 'Add this device back to managed inventory'}
              >
                🔄 Re-provision Device
              </Button>
            )}
          </div>

        /* STATE 5: Not yet provisioned — show Provision + Ignore buttons */
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {onProvision && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onProvision(r)}
                style={{ width: '100%', fontWeight: 700 }}
                disabled={!canProvision(r)}
                title={!canProvision(r) ? 'SNMP must succeed to provision (no device data available)' : 'Provision this device into managed inventory'}
              >
                🔧 Provision Device
              </Button>
            )}
            {/* Ignore — suppress from discovery results without provisioning */}
            {onIgnore && (
              <button
                onClick={() => onIgnore(r)}
                title="Suppress this host from the discovery results without provisioning it"
                style={{
                  width: '100%', padding: '5px 0', borderRadius: 6, fontSize: 11,
                  fontWeight: 600, cursor: 'pointer',
                  background: 'rgba(107,114,128,0.08)',
                  border: '1px solid rgba(107,114,128,0.2)',
                  color: 'var(--vf-text-muted)',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(107,114,128,0.16)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(107,114,128,0.08)')}
              >
                🚫 Ignore Device
              </button>
            )}
          </div>
        )
        /* close outer loading ternary */
        )}

        {/* STATE 6: Ignored — grey card with Un-ignore option */}
        {ignored && (
          <div style={{
            marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--vf-border-subtle)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{
                background: 'rgba(107,114,128,0.12)', color: '#6b7280',
                borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 700,
              }}>🚫 Ignored</span>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                Suppressed — not provisioned
              </span>
            </div>
            {onUnignore && (
              <button
                onClick={() => onUnignore(r)}
                title="Lift the suppress and make this device eligible for provisioning again"
                style={{
                  width: '100%', padding: '5px 0', borderRadius: 6, fontSize: 11,
                  fontWeight: 600, cursor: 'pointer',
                  background: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.25)',
                  color: 'var(--vf-accent)',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.16)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.08)')}
              >
                ↩ Un-ignore Device
              </button>
            )}
          </div>
        )}

      </div>
    </div>
  );
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

export function DiscoveryResultsTable({
  runId,
  onAddToInventory,
  onProvision,
  provisionedIPs,
  inventoryDeviceMap,
  inventoryMapLoading,
  onDeprovision,
  deprovisioningIPs,
  deprovisionedIPs,
  ignoredIPs,
  onIgnore,
  onUnignore,
}: DiscoveryResultsTableProps) {
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<DiscoveryResultFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  // 'cards' gives the tree-style view matching the requirements spec;
  // 'table' gives the full sortable/filterable data grid.
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  // When true, ignored devices are shown (greyed out) at the bottom of the list so admins
  // can review and un-ignore them. When false (default), they are hidden entirely.
  const [showIgnored, setShowIgnored] = useState(false);

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

  // Separate active (non-ignored) and ignored results before applying column filters.
  const activeResults  = useMemo(
    () => results.filter((r) => !ignoredIPs?.has(r.ip)),
    [results, ignoredIPs],
  );
  const ignoredResults = useMemo(
    () => results.filter((r) => ignoredIPs?.has(r.ip)),
    [results, ignoredIPs],
  );

  const filteredResults = useMemo(
    () => filterDiscoveryResults(activeResults, filters),
    [activeResults, filters],
  );

  const vendorOptions = useMemo(() => uniqueFilterOptions(activeResults, (r) => r.vendor), [activeResults]);
  const deviceTypeOptions = useMemo(
    () => uniqueFilterOptions(activeResults, (r) => r.genericDeviceType),
    [activeResults],
  );
  const icmpOptions = useMemo(() => uniqueFilterOptions(activeResults, (r) => r.icmpStatus), [activeResults]);
  const snmpOptions = useMemo(() => uniqueFilterOptions(activeResults, (r) => r.snmpStatus), [activeResults]);

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

  const navigate    = useNavigate();

  /**
   * Per-row action cell — shows contextual Provision / Deprovision button
   * plus quick-nav links to Inventory, Topology, and Device Metrics.
   *
   * Defined before early returns (loading / error / empty) to obey Rules of Hooks.
   *
   * Three states:
   *   1. Device already in inventory → ✅ badge + Deprovision + nav links
   *   2. Provisioned this session     → ✅ badge + nav links
   *   3. Not provisioned              → 🔧 Provision button (disabled if ICMP down)
   */
  const actionsColumn: ColumnDef<DiscoveryResult> = useMemo(() => ({
    key: '__actions',
    header: 'Actions',
    width: 220,
    render: (row) => {
      const invDev         = inventoryDeviceMap?.get(row.ip);
      const sessionProvisioned = provisionedIPs?.has(row.ip);
      const isProvisioned  = Boolean(invDev) || sessionProvisioned;

      // Nav helpers — navigate without a hard-reload.
      const goInventory = (e: React.MouseEvent) => {
        e.stopPropagation();
        // Navigate to the specific device detail page when we have the ID,
        // otherwise fall back to the inventory list.
        const id = invDev?.id || invDev?.deviceId || invDev?.serialNumber;
        navigate(id ? `/v2/devices/${id}` : '/v2/devices');
      };
      const goTopology = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigate(`/v2/topology?highlight=${encodeURIComponent(row.ip)}`);
      };
      const goMetrics = (e: React.MouseEvent) => {
        e.stopPropagation();
        const id = invDev?.id || invDev?.deviceId || invDev?.serialNumber;
        if (id) navigate(`/v2/devices/${id}`);
        else navigate('/v2/discovery?tab=all');
      };

      const NavBtn = ({
        label, onClick, title,
      }: { label: string; onClick: (e: React.MouseEvent) => void; title?: string }) => (
        <button
          onClick={onClick}
          title={title}
          style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 4,
            background: 'var(--vf-accent-subtle)', color: 'var(--vf-accent)',
            border: '1px solid var(--vf-border-subtle)', cursor: 'pointer',
            fontFamily: 'var(--vf-font-sans)', fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </button>
      );

      return (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Provision state button ─────────────────────────────────── */}
          {isProvisioned ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 700 }}>✅ Provisioned</span>
              {invDev && onDeprovision && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeprovision(row, invDev); }}
                  title="Remove from managed inventory"
                  style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 4,
                    background: 'rgba(239,68,68,0.08)', color: 'var(--vf-danger)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    cursor: 'pointer', fontWeight: 700,
                  }}
                >
                  🗑 Deprovision
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onProvision?.(row); }}
              disabled={!canProvision(row)}
              title={!canProvision(row)
                ? 'SNMP must succeed to provision (no device data available)'
                : 'Add this device to managed inventory'}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 5,
                background: canProvision(row)
                  ? 'var(--vf-accent)' : 'var(--vf-surface-raised)',
                color: canProvision(row) ? '#fff' : 'var(--vf-text-muted)',
                border: 'none', cursor: canProvision(row) ? 'pointer' : 'default',
                fontWeight: 700, opacity: !canProvision(row) ? 0.5 : 1,
              }}
            >
              🔧 Provision
            </button>
          )}

          {/* ── Navigation quick-links ─────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {isProvisioned && invDev && (
              <NavBtn label="📊 Metrics"   onClick={goMetrics}   title="View device metrics and KPIs" />
            )}
            <NavBtn label="📋 Inventory" onClick={goInventory} title="Go to All Discovered inventory" />
            <NavBtn label="🗺 Topology"  onClick={goTopology}  title="View device on topology map" />
          </div>
        </div>
      );
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [inventoryDeviceMap, provisionedIPs, onProvision, onDeprovision, navigate]);

  // ── Early returns (after all hooks) ─────────────────────────────────────────

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

  const selectedResults = results.filter((r) => selected.has(r.ip));
  const canCompare = selectedResults.length >= 2 && selectedResults.length <= 4;

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
    actionsColumn,
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Inject shimmer keyframe for the inventory-loading skeleton */}
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* View mode toggle + ignored devices reveal */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant={viewMode === 'cards' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('cards')}
            aria-pressed={viewMode === 'cards'}
          >
            🌲 Device Cards
          </Button>
          <Button
            variant={viewMode === 'table' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('table')}
            aria-pressed={viewMode === 'table'}
          >
            ⊞ Table View
          </Button>
        </div>
        {/* Show ignored count + toggle — only when there are ignored devices */}
        {ignoredResults.length > 0 && (
          <button
            onClick={() => setShowIgnored((v) => !v)}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 6,
              background: showIgnored ? 'rgba(107,114,128,0.15)' : 'rgba(107,114,128,0.06)',
              border: '1px solid rgba(107,114,128,0.25)',
              color: 'var(--vf-text-muted)', cursor: 'pointer', fontWeight: 600,
            }}
          >
            🚫 {ignoredResults.length} ignored — {showIgnored ? 'Hide' : 'Show'}
          </button>
        )}
      </div>

      {/* ── Card view: tree-style device cards ───────────────────────────────── */}
      {viewMode === 'cards' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', padding: '4px 0' }}>
            {filteredResults.length} device{filteredResults.length !== 1 ? 's' : ''} found
            {ignoredResults.length > 0 && (
              <span style={{ marginLeft: 10, color: 'rgba(107,114,128,0.7)' }}>
                · {ignoredResults.length} ignored
              </span>
            )}
          </div>
          {filteredResults.length === 0 ? (
            <EmptyState icon="🔎" title="No results" description="Adjust filters or start a new discovery run." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
              {filteredResults.map((r) => (
                <DeviceCard
                  key={r.ip}
                  r={r}
                  onProvision={onProvision}
                  provisioned={provisionedIPs?.has(r.ip)}
                  inventoryDevice={inventoryDeviceMap?.get(r.ip)}
                  inventoryMapLoading={inventoryMapLoading}
                  onDeprovision={onDeprovision}
                  onNavigate={navigate}
                  deprovisioning={deprovisioningIPs?.has(r.ip)}
                  deprovisioned={deprovisionedIPs?.has(r.ip)}
                  onIgnore={onIgnore}
                  onUnignore={onUnignore}
                />
              ))}
            </div>
          )}

          {/* Ignored devices section — revealed when admin toggles "Show ignored" */}
          {showIgnored && ignoredResults.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Ignored Devices ({ignoredResults.length})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16, opacity: 0.6 }}>
                {ignoredResults.map((r) => (
                  <DeviceCard
                    key={r.ip}
                    r={r}
                    ignored
                    onUnignore={onUnignore}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Table view: full sortable data grid ──────────────────────────────── */}
      {viewMode === 'table' && (<>

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
          {selectedResults.length === 1 && (() => {
            const sel = selectedResults[0];
            const invDev = inventoryDeviceMap?.get(sel.ip);
            // Check BOTH inventoryDeviceMap (persisted) AND provisionedIPs (session)
            // to avoid showing the Provision button immediately after provisioning,
            // before the inventory API has been re-fetched.
            const sessionProvisioned = provisionedIPs?.has(sel.ip);
            const isAlreadyProvisioned = Boolean(invDev) || sessionProvisioned;

            // While the inventory cross-reference is still loading, show a neutral
            // spinner instead of a potentially-wrong Provision button.
            if (inventoryMapLoading && !sessionProvisioned) {
              return (
                <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontStyle: 'italic' }}>
                  ⏳ Checking inventory…
                </span>
              );
            }

            if (isAlreadyProvisioned && invDev && onDeprovision) {
              return (
                <Button
                  size="sm"
                  onClick={() => onDeprovision(sel, invDev)}
                  style={{ background: 'var(--vf-danger)', color: '#fff', border: 'none', fontWeight: 700 }}
                  title="Remove this device from managed inventory"
                >
                  🗑 Deprovision
                </Button>
              );
            }
            if (isAlreadyProvisioned) {
              // Device was provisioned this session — show a badge instead of
              // the Provision button while the inventory map refreshes in the background.
              return (
                <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e' }}>
                  ✅ Provisioned
                </span>
              );
            }
            if (onProvision) {
              return (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onProvision(sel)}
                  disabled={!canProvision(sel)}
                  title={canProvision(sel) ? 'Provision selected device into managed inventory' : 'SNMP must succeed to provision (no device data available)'}
                >
                  🔧 Provision
                </Button>
              );
            }
            return null;
          })()}
          {/* ── View Details: single already-provisioned device ───────────── */}
          {selectedResults.length === 1 && (() => {
            const sel = selectedResults[0];
            // Look up by IP first; fall back to sysName-derived serial that
            // provision.stub.js uses as the document _id (e.g. SN-cisco-sw-core-01).
            const derivedSerial = sel.sysName
              ? `SN-${sel.sysName.trim().replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 28)}`
              : undefined;
            const invDev =
              inventoryDeviceMap?.get(sel.ip) ??
              (derivedSerial ? inventoryDeviceMap?.get(derivedSerial) : undefined);
            const sessionProvisioned = provisionedIPs?.has(sel.ip);
            if (!invDev && !sessionProvisioned) return null;
            // Device is already in inventory — offer direct navigation to its
            // detail page which shows coordinates, metrics, and all managed fields.
            const devId = invDev?.id || invDev?.deviceId;
            // GpsLocation uses GeoJSON coordinates [lng, lat]; flat fields are preferred.
            const lat   = invDev?.latitude  ?? invDev?.location?.coordinates?.[1];
            const lng   = invDev?.longitude ?? invDev?.location?.coordinates?.[0];
            const hasGps = Boolean(lat && lng);
            return (
              <Button
                variant="ghost"
                size="sm"
                title={hasGps
                  ? `View device details — GPS: ${lat?.toFixed(4)}, ${lng?.toFixed(4)}`
                  : 'View device details in inventory'}
                onClick={() => {
                  if (devId) navigate(`/v2/devices/${devId}`);
                  else navigate('/v2/devices');
                }}
                style={{ border: '1px solid var(--vf-border-subtle)' }}
              >
                📋 View Details{hasGps ? ` 📍` : ''}
              </Button>
            );
          })()}

          {/* ── Add to Inventory: only for devices NOT yet provisioned ────── */}
          {onAddToInventory && (() => {
            // Exclude devices already managed in inventory or provisioned this session.
            // This prevents re-provisioning (duplicate records) for managed devices.
            const unprovisionedResults = selectedResults.filter((r) => {
              const inInventory = inventoryDeviceMap?.has(r.ip);
              const sessionDone = provisionedIPs?.has(r.ip);
              return !inInventory && !sessionDone;
            });
            if (unprovisionedResults.length === 0) return null;
            return (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onAddToInventory(unprovisionedResults)}
                title="Add selected devices to inventory queue for batch review"
              >
                📥 Add to Inventory ({unprovisionedResults.length})
              </Button>
            );
          })()}
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

      </>)} {/* end viewMode === 'table' */}
    </div>
  );
}

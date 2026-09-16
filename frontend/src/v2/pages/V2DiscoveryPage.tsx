/**
 * V2 Device Discovery & Onboarding — REQ-001 / REQ-004 / REQ-025 / NMS-DIS-01 to DIS-06
 *
 * Tabs:
 *  1. Provisioning Queue — devices awaiting onboarding (status=PROVISIONING)
 *  2. Auth Failures      — alarms from authentication-failed devices (NMS-DIS-05)
 *  3. All Discovered     — complete inventory including ONLINE/OFFLINE (NMS-DIS-02)
 *  4. SNMP Discovery     — run SNMP-based discovery scans (REQ-004)
 *  5. Run History        — paginated list of past discovery runs (WO-015)
 *  6. SNMP Credentials   — manage stored SNMP credentials (WO-023)
 *  7. Mode Admin         — enable/disable discovery modes (admin only, WO-001)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDevices, updateDevice, deleteDevice } from '../../api/devices.api';
import type { Device, DeviceType } from '../../api/devices.types';
import { fetchAlarms } from '../../api/alarms.api';
import type { Alarm } from '../../api/alarms.types';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Modal } from '../components/common/Modal';
import { MetricCard } from '../components/common/MetricCard';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';
import { apiClient } from '../../api/client';
import { DiscoveryTriggerForm } from '../components/discovery/DiscoveryTriggerForm';
import { DiscoveryRunStatusView } from '../components/discovery/DiscoveryRunStatusView';
import { DiscoveryResultsTable } from '../components/discovery/DiscoveryResultsTable';
import { DiscoveryRunHistory } from '../components/discovery/DiscoveryRunHistory';
import { CredentialManager } from '../components/discovery/CredentialManager';
import { DiscoverySchedules } from '../components/discovery/DiscoverySchedules';
import { ProvisionDeviceModal } from '../components/discovery/ProvisionDeviceModal';
import {
  createDiscoveryRun,
  getDiscoveryRun,
  getDiscoveryRunResults,
  parseScopeInput,
  provisionDiscoveredHosts,
  listIgnoredHosts,
  ignoreDiscoveredHosts,
  unignoreDiscoveredHost,
} from '../../api/discovery.api';
import type {
  DiscoveryRunResponse,
  DiscoveryResult,
  ProvisionHostRequest,
} from '../../api/discovery.api';
import type { DiscoveryRunSummary } from '../../api/discovery.api';

// ── Types ─────────────────────────────────────────────────────────────────────
type DiscoveryTab =
  | 'provisioning'
  | 'auth_failures'
  | 'all'
  | 'snmp_discovery'
  | 'run_history'
  | 'snmp_credentials'
  | 'schedules'
  | 'mode_admin';

const TAB_LABELS: Record<DiscoveryTab, string> = {
  provisioning:     'Provisioning Queue',
  auth_failures:    'Auth Failures',
  all:              'All Discovered',
  snmp_discovery:   'SNMP Discovery',
  run_history:      'Run History',
  snmp_credentials: 'SNMP Credentials',
  schedules:        'Schedules',
  mode_admin:       'Mode Admin',
};

// ── SNMP Discovery workflow view states ───────────────────────────────────────
type SnmpView = 'form' | 'status' | 'results';

/**
 * Session storage key for persisting an in-progress run ID across refreshes.
 * Edge case: user refreshes while a run is in the 'running' state — we restore
 * the status view rather than losing the context.
 */
const SNMP_RUN_SESSION_KEY = 'vf_snmp_active_run_id';

// ── Discovery mode entry shape (WO-001) ──────────────────────────────────────
interface DiscoveryModeEntry {
  enabled: boolean;
  rolloutLevel: 'disabled' | 'beta' | 'production';
  betaSignoffRef: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
}

interface DiscoveryModesResponse {
  genericDiscovery: DiscoveryModeEntry;
  ubrCallHome: DiscoveryModeEntry;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function relTime(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function typeBadgeVariant(t: DeviceType): 'accent' | 'success' | 'warning' {
  if (t === 'BTS') return 'accent';
  if (t === 'CPE') return 'success';
  return 'warning';
}

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'ONLINE')       return 'success';
  if (s === 'PROVISIONING') return 'warning';
  if (s === 'OFFLINE')      return 'danger';
  return 'default';
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
function TabBtn({
  id, active, count, onClick,
}: { id: DiscoveryTab; active: boolean; count?: number; onClick: (t: DiscoveryTab) => void }) {
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        padding: '12px 20px', border: 'none', background: 'none', cursor: 'pointer',
        fontSize: 13, fontWeight: active ? 700 : 500,
        color: active ? '#60a5fa' : 'rgba(255,255,255,0.75)',
        borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent',
        transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 6,
      }}
    >
      {TAB_LABELS[id]}
      {count !== undefined && count > 0 && (
        <span style={{
          background: id === 'auth_failures' ? '#ef4444' : '#3b82f6',
          color: '#fff', fontSize: 10, fontWeight: 700,
          borderRadius: 10, padding: '1px 6px', minWidth: 18, textAlign: 'center',
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── Onboarding modal ──────────────────────────────────────────────────────────
interface OnboardModalProps {
  device: Device | null;
  open: boolean;
  onClose: () => void;
  onApprove: (d: Device, networkId: string) => void;
  onReject: (d: Device) => void;
  saving: boolean;
}

function OnboardModal({ device, open, onClose, onApprove, onReject, saving }: OnboardModalProps) {
  const [networkId, setNetworkId] = useState('');

  if (!device) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Onboard Device — ${device.serialNumber}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onReject(device)} disabled={saving}>
            Reject
          </Button>
          <Button
            variant="primary" size="sm"
            onClick={() => onApprove(device, networkId)}
            disabled={saving || !networkId.trim()}
          >
            {saving ? 'Approving…' : 'Approve & Onboard'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          {[
            ['Serial', device.serialNumber],
            ['MAC', device.macAddress],
            ['IP', device.ipAddress],
            ['Type', device.deviceType],
            ['Model', device.model],
            ['Firmware', device.firmwareVersion],
            ['First Seen', relTime(device.registeredAt)],
            ['Last Seen', relTime(device.lastSeenAt)],
          ].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 2 }}>{label}</div>
              <div style={{ fontFamily: label === 'Serial' || label === 'MAC' || label === 'IP' ? 'var(--vf-font-mono)' : undefined, fontSize: 12 }}>{val}</div>
            </div>
          ))}
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--vf-text-secondary)' }}>
            Assign to Network ID *
          </label>
          <Input
            value={networkId}
            onChange={(e) => setNetworkId(e.target.value)}
            placeholder="e.g. net-del-001"
            style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}
          />
          <p style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 4 }}>
            Every device must be assigned to exactly one Network before onboarding completes.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 1 — Provisioning Queue
// ─────────────────────────────────────────────────────────────────────────────
function ProvisioningTab() {
  const { addToast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Device | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchDevices({ status: 'PROVISIONING' })
      .then(setDevices)
      .catch((e) => { logger.error('Discovery provisioning fetch', e); addToast('Failed to load provisioning queue', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const filtered = devices.filter((d) => {
    const q = search.toLowerCase();
    return (
      !q ||
      d.serialNumber.toLowerCase().includes(q) ||
      d.macAddress.toLowerCase().includes(q) ||
      d.ipAddress.toLowerCase().includes(q) ||
      d.model.toLowerCase().includes(q)
    );
  });

  async function handleApprove(device: Device, networkId: string) {
    setSaving(true);
    try {
      await updateDevice(device.id, { status: 'ONLINE', networkId });
      addToast(`${device.serialNumber} approved and onboarded`, 'success');
      setSelected(null);
      load();
    } catch (e) {
      logger.error('Approve device failed', e);
      addToast('Failed to approve device', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleReject(device: Device) {
    setSaving(true);
    try {
      await deleteDevice(device.id);
      addToast(`${device.serialNumber} rejected`, 'warning');
      setSelected(null);
      load();
    } catch (e) {
      logger.error('Reject device failed', e);
      addToast('Failed to reject device', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading provisioning queue…" />;
  if (devices.length === 0) {
    return (
      <EmptyState
        title="Provisioning queue empty"
        description="No devices are waiting to be onboarded. Devices connect proactively to the NMS discovery endpoint."
        icon={<span aria-hidden style={{ fontSize: 32 }}>📡</span>}
      />
    );
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Input
          placeholder="Search by serial, MAC, IP or model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 400 }}
        />
        <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)', background: 'var(--vf-surface)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
              {['Type', 'Serial', 'MAC', 'IP', 'Model', 'Firmware', 'First Seen', 'Last Seen', 'Action'].map((h) => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)', transition: 'background 0.1s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.04)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}>
                <td style={{ padding: '10px 14px' }}><Badge variant={typeBadgeVariant(d.deviceType)}>{d.deviceType}</Badge></td>
                <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.serialNumber}</td>
                <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{d.macAddress}</td>
                <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.ipAddress}</td>
                <td style={{ padding: '10px 14px' }}>{d.manufacturer} {d.model}</td>
                <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{d.firmwareVersion}</td>
                <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{relTime(d.registeredAt)}</td>
                <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{relTime(d.lastSeenAt)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <Button variant="primary" size="sm" onClick={() => setSelected(d)}>
                    Onboard
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <OnboardModal
        open={!!selected}
        device={selected}
        onClose={() => setSelected(null)}
        onApprove={handleApprove}
        onReject={handleReject}
        saving={saving}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 2 — Auth Failures
// ─────────────────────────────────────────────────────────────────────────────
function AuthFailuresTab() {
  const { addToast } = useToast();
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlarms({ severity: ['CRITICAL'] })
      .then((all) => {
        const authFails = all.filter(
          (a) => a.alarmName?.toLowerCase().includes('auth') ||
                 a.alarmType?.toLowerCase().includes('auth')
        );
        setAlarms(authFails);
      })
      .catch((e) => { logger.error('Auth failures fetch', e); addToast('Failed to load auth failures', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  if (loading) return <LoadingState label="Loading authentication failures…" />;
  if (alarms.length === 0) {
    return (
      <EmptyState
        title="No authentication failures"
        description="All device authentication attempts have been successful. Unauthorized devices attempting to connect will appear here."
        icon={<span aria-hidden style={{ fontSize: 32 }}>🔐</span>}
      />
    );
  }

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)', background: 'var(--vf-surface)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
            {['Time', 'Severity', 'Alarm', 'Device', 'Description', 'State'].map((h) => (
              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {alarms.map((a) => (
            <tr key={a.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)', background: 'rgba(239,68,68,0.03)' }}>
              <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>
                {new Date(a.timestamp).toLocaleString()}
              </td>
              <td style={{ padding: '10px 14px' }}>
                <Badge variant="danger">{a.severity}</Badge>
              </td>
              <td style={{ padding: '10px 14px', fontWeight: 600, color: '#f87171' }}>{a.alarmName}</td>
              <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{a.deviceId ?? '—'}</td>
              <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.alarmType ?? '—'}</td>
              <td style={{ padding: '10px 14px' }}>
                <Badge variant={a.state === 'CLEARED' ? 'success' : 'danger'}>{a.state}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 3 — All Discovered
// ─────────────────────────────────────────────────────────────────────────────
function AllDiscoveredTab() {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<DeviceType | ''>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchDevices({})
      .then(setDevices)
      .catch((e) => { logger.error('All devices fetch', e); addToast('Failed to load device list', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  const filtered = devices.filter((d) => {
    const q = search.toLowerCase();
    const matchesSearch = !q || d.serialNumber.toLowerCase().includes(q) || d.ipAddress.toLowerCase().includes(q) || d.macAddress.toLowerCase().includes(q);
    const matchesType = !typeFilter || d.deviceType === typeFilter;
    return matchesSearch && matchesType;
  });

  if (loading) return <LoadingState label="Loading all devices…" />;

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Input
          placeholder="Search serial, IP, MAC…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, maxWidth: 380 }}
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as DeviceType | '')}
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}
        >
          <option value="">All Types</option>
          <option value="BTS">BTS</option>
          <option value="CPE">CPE</option>
          <option value="IDU">IDU</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)', alignSelf: 'center' }}>
          {filtered.length} / {devices.length} devices
        </span>
      </div>

      {devices.length === 0 ? (
        <EmptyState title="No devices discovered" description="Devices will appear here as they connect to the NMS discovery endpoint." icon={<span aria-hidden style={{ fontSize: 32 }}>📡</span>} />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)', background: 'var(--vf-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
                {['Type', 'Serial', 'IP', 'Model', 'Status', 'Firmware', 'Last Seen', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => navigate(`/v2/devices/${d.id}`)}
                  style={{ borderBottom: '1px solid var(--vf-border-subtle)', cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(59,130,246,0.06)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td style={{ padding: '10px 14px' }}><Badge variant={typeBadgeVariant(d.deviceType)}>{d.deviceType}</Badge></td>
                  <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.serialNumber}</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{d.ipAddress}</td>
                  <td style={{ padding: '10px 14px' }}>{d.manufacturer} {d.model}</td>
                  <td style={{ padding: '10px 14px' }}><Badge variant={statusVariant(d.status)} dot>{d.status}</Badge></td>
                  <td style={{ padding: '10px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{d.firmwareVersion}</td>
                  <td style={{ padding: '10px 14px', color: 'var(--vf-text-muted)', fontSize: 12 }}>{relTime(d.lastSeenAt)}</td>
                  <td style={{ padding: '6px 14px' }} onClick={(e) => e.stopPropagation()}>
                    {confirmDeleteId === d.id ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ padding: '3px 7px', borderRadius: 4, fontSize: 10, cursor: 'pointer', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-subtle)', color: 'var(--vf-text-muted)' }}
                        >Cancel</button>
                        <button
                          disabled={deletingId === d.id}
                          onClick={async () => {
                            setDeletingId(d.id);
                            try {
                              await deleteDevice(d.id);
                              setDevices((prev) => prev.filter((x) => x.id !== d.id));
                              addToast(`🗑 ${d.serialNumber} removed from inventory`, 'success');
                            } catch {
                              addToast('Failed to deprovision device', 'error');
                            } finally {
                              setDeletingId(null);
                              setConfirmDeleteId(null);
                            }
                          }}
                          style={{
                            padding: '3px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                            cursor: deletingId === d.id ? 'default' : 'pointer',
                            background: '#ef4444', border: 'none', color: '#fff',
                          }}
                        >{deletingId === d.id ? '⏳' : 'Confirm'}</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(d.id)}
                        style={{
                          padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                          cursor: 'pointer',
                          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                          color: '#ef4444',
                        }}
                      >🗑 Deprovision</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 4 — SNMP Discovery (REQ-004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SnmpDiscoveryTab manages the three-step SNMP discovery workflow:
 *   form → status → results
 *
 * State is persisted to sessionStorage so the user can refresh without losing
 * an in-progress run (edge case from WO-025).
 */
interface SnmpDiscoveryTabProps {
  /** Optional pre-populated scope value (e.g. from "Re-run" in the history tab). */
  initialScope?: string;
}

function SnmpDiscoveryTab({ initialScope }: SnmpDiscoveryTabProps) {
  const { addToast } = useToast();
  const navigate = useNavigate();

  // Restore run ID from sessionStorage to handle browser refresh mid-run.
  const restoredRunId = sessionStorage.getItem(SNMP_RUN_SESSION_KEY);

  const [view, setView] = useState<SnmpView>(restoredRunId ? 'status' : 'form');
  const [activeRunId, setActiveRunId] = useState<string | null>(restoredRunId);

  // ── Provisioning state ─────────────────────────────────────────────────────
  /** The device currently being reviewed in the provision modal. */
  const [provisionTarget, setProvisionTarget] = useState<DiscoveryResult | null>(null);
  const [provisionSaving, setProvisionSaving] = useState(false);
  /** IPs provisioned during this session — renders ✅ badge on their cards. */
  const [provisionedIPs, setProvisionedIPs] = useState<Set<string>>(new Set());
  /** Set to true after API success — switches modal to success/navigation state. */
  const [modalProvisioned, setModalProvisioned] = useState(false);
  /** Device ID returned by the inventory API after a successful provision. */
  const [modalProvisionedDeviceId, setModalProvisionedDeviceId] = useState('');
  const [modalProvisionedSerial, setModalProvisionedSerial] = useState('');

  // ── Inventory cross-reference ───────────────────────────────────────────────
  /**
   * Map of IP address → managed Device for devices already in the inventory.
   * Built once when the results view loads so each card can show "Already Provisioned"
   * instead of the Provision button, and can offer Deprovision instead.
   */
  const [inventoryDeviceMap, setInventoryDeviceMap] = useState<Map<string, Device>>(new Map());
  /**
   * True while the inventory cross-reference fetch is in flight.
   * Cards show a skeleton action bar during this window to avoid the
   * "Provision Device" button flashing for already-provisioned devices.
   */
  const [inventoryMapLoading, setInventoryMapLoading] = useState(false);

  /**
   * IPs currently being deprovisioned (DELETE in flight) — shows spinner on the card
   * and disables the Deprovision button to prevent a double-click firing twice.
   */
  const [deprovisioningIPs, setDeprovisioningIPs] = useState<Set<string>>(new Set());

  /**
   * IPs that were deprovisioned in this session — card shows "Deprovisioned" badge
   * with a Re-provision option rather than the plain Provision button.
   */
  const [deprovisionedIPs, setDeprovisionedIPs] = useState<Set<string>>(new Set());

  /**
   * IPs the admin has chosen to suppress (ignore).
   * Ignored devices are hidden from the card grid by default.  They are never
   * provisioned into inventory or shown on the topology map.
   * Persisted to the backend ignore list so they survive page refreshes.
   */
  const [ignoredIPs, setIgnoredIPs] = useState<Set<string>>(new Set());

  /**
   * Called by DiscoveryTriggerForm when a run is successfully created.
   * Persists runId to sessionStorage so the status view survives a page refresh.
   */
  function handleRunCreated(run: DiscoveryRunResponse) {
    sessionStorage.setItem(SNMP_RUN_SESSION_KEY, run.runId);
    setActiveRunId(run.runId);
    setView('status');
  }

  /**
   * Called by DiscoveryRunStatusView when the run reaches COMPLETED status.
   */
  function handleRunComplete() {
    // Keep activeRunId so results table can fetch the results.
    // Clear session storage — the run is done, no need to restore.
    sessionStorage.removeItem(SNMP_RUN_SESSION_KEY);
    setView('results');
  }

  /**
   * Resets the workflow back to the trigger form.
   * Used by the "Start New Discovery" button in the results view.
   */
  function handleStartNew() {
    sessionStorage.removeItem(SNMP_RUN_SESSION_KEY);
    setActiveRunId(null);
    setView('form');
    setProvisionedIPs(new Set());
    setInventoryDeviceMap(new Map());
    setDeprovisioningIPs(new Set());
    setDeprovisionedIPs(new Set());
    setIgnoredIPs(new Set());
  }

  /**
   * Fetches all managed devices from inventory and builds an IP → Device map.
   * Called when the results view first appears so cards can detect already-provisioned devices.
   * Runs in the background — failures are non-fatal (cards simply show Provision button).
   */
  useEffect(() => {
    if (view !== 'results') return;

    // Fetch managed inventory for already-provisioned device cross-reference.
    //
    // Why activeRunId is included in the dependency array:
    //   - `view` alone is insufficient: if the component stays mounted across
    //     navigations (React Router layout caching), `view` never changes from
    //     'results' after the first run, so the effect never re-fires for new
    //     runs. Adding `activeRunId` guarantees a fresh fetch whenever a NEW
    //     discovery run's results appear — which is exactly when the admin needs
    //     accurate "already provisioned" state.
    //
    // The loading flag prevents the "Provision Device" button from briefly
    // flashing for devices that ARE in inventory while the fetch is in flight.
    setInventoryMapLoading(true);
    fetchDevices()
      .then((devices) => {
        const map = new Map<string, Device>();
        for (const d of devices) {
          // Key by both ipAddress and serialNumber so cards can match on either.
          if (d.ipAddress)    map.set(d.ipAddress, d);
          if (d.serialNumber) map.set(d.serialNumber, d);
        }
        setInventoryDeviceMap(map);
      })
      .catch((err: unknown) => {
        // Non-fatal: cards fall back to Provision button if the fetch fails
        // (gateway restarting, auth temporarily unavailable, etc.).
        logger.warn('SnmpDiscoveryTab: failed to fetch inventory for cross-reference', { error: String(err) });
      })
      .finally(() => {
        setInventoryMapLoading(false);
      });

    // Fetch previously ignored IPs so they are hidden on page load/refresh.
    listIgnoredHosts()
      .then((hosts) => {
        setIgnoredIPs(new Set(hosts.map((h) => h.ip)));
      })
      .catch(() => {
        // Non-fatal — ignore list defaults to empty.
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeRunId]);

  /**
   * Opens the provision confirmation modal for a single discovered device.
   * Available via the "🔧 Provision" button on each device card.
   */
  function handleProvision(result: DiscoveryResult) {
    // Reset modal's success state when opening for a new device.
    setModalProvisioned(false);
    setModalProvisionedDeviceId('');
    setModalProvisionedSerial('');
    setProvisionTarget(result);
  }

  /**
   * Executes provisioning after the admin confirms in the modal.
   * On success the modal stays open in "success state" so the admin can navigate
   * directly to Inventory or Topology without going back to the results table first.
   */
  async function handleProvisionConfirm(req: ProvisionHostRequest) {
    if (!activeRunId) return;
    setProvisionSaving(true);
    try {
      const resp = await provisionDiscoveredHosts(activeRunId, [req]);
      const result = resp.results[0];
      if (!result || result.status === 'failed') {
        const errMsg = result?.error ?? 'Provisioning failed — check the inventory service.';
        addToast(errMsg, 'error');
        return;
      }

      // Mark as provisioned so card shows ✅ on the results table behind the modal.
      setProvisionedIPs((prev) => new Set([...prev, req.ip]));

      // Add to inventory map immediately so a re-opened card shows "Already Provisioned".
      // Constructs a minimal Device shape from the provision request + result.
      setInventoryDeviceMap((prev) => {
        const next = new Map(prev);
        next.set(req.ip, {
          id:              result.deviceId,
          deviceId:        result.deviceId,
          serialNumber:    result.serialNumber,
          ipAddress:       req.ip,
          deviceType:      req.deviceType as DeviceType,
          status:          'ONLINE',
          // Required Device fields — populated with discovered values where available.
          macAddress:      req.macAddress ?? '',
          manufacturer:    req.sysName   ?? '',
          model:           req.sysDescr  ?? '',
          firmwareVersion: '',
        } as unknown as Device);
        return next;
      });

      // Switch modal to success/navigation state instead of closing it immediately.
      setModalProvisioned(true);
      setModalProvisionedDeviceId(result.deviceId);
      setModalProvisionedSerial(result.serialNumber);
    } catch (err: unknown) {
      logger.error('SnmpDiscoveryTab: provision failed', err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        addToast('Device with this serial/IP already exists in inventory.', 'error');
      } else {
        addToast('Failed to provision device. Is the discovery service running?', 'error');
      }
    } finally {
      setProvisionSaving(false);
    }
  }

  /** Closes the provision modal and clears all provisioning modal state. */
  function handleProvisionModalClose() {
    setProvisionTarget(null);
    setModalProvisioned(false);
    setModalProvisionedDeviceId('');
    setModalProvisionedSerial('');
  }

  /**
   * Deprovisions a device: removes it from the managed inventory via DELETE /devices/:id.
   * Shows a spinner while in flight; on success shows a "Deprovisioned" badge with
   * Re-provision option per the spec state machine instead of jumping straight back
   * to the plain Provision button.
   */
  async function handleDeprovision(result: DiscoveryResult, device: Device) {
    // Guard against concurrent deprovision of the same IP (double-click protection).
    if (deprovisioningIPs.has(result.ip)) return;

    setDeprovisioningIPs((prev) => new Set([...prev, result.ip]));
    try {
      await deleteDevice(device.id || device.serialNumber || result.ip);

      // Remove from inventory map so the card knows it's no longer in inventory.
      setInventoryDeviceMap((prev) => {
        const next = new Map(prev);
        next.delete(result.ip);
        return next;
      });

      // Clear from session-provisioned set.
      setProvisionedIPs((prev) => {
        const next = new Set(prev);
        next.delete(result.ip);
        return next;
      });

      // Mark as "deprovisioned" — card shows badge + Re-provision, not plain Provision.
      setDeprovisionedIPs((prev) => new Set([...prev, result.ip]));

      addToast(
        `🗑 ${device.serialNumber || result.ip} removed from inventory. Use Re-provision to add it back.`,
        'success',
      );
    } catch (err: unknown) {
      logger.error('SnmpDiscoveryTab: deprovision failed', err);
      addToast('Failed to remove device from inventory. Please try again.', 'error');
    } finally {
      setDeprovisioningIPs((prev) => {
        const next = new Set(prev);
        next.delete(result.ip);
        return next;
      });
    }
  }

  /**
   * Marks a discovered host as "ignored" so it disappears from the card grid.
   * Persists the suppression to the backend so it survives page refreshes.
   * The admin can always reveal and un-ignore devices via the "Show Ignored" toggle.
   */
  async function handleIgnore(result: DiscoveryResult) {
    // Optimistic update — add to local set immediately.
    setIgnoredIPs((prev) => new Set([...prev, result.ip]));
    try {
      await ignoreDiscoveredHosts([result.ip]);
      addToast(`🚫 ${result.sysName || result.ip} suppressed from discovery results.`, 'info');
    } catch {
      // Rollback on failure.
      setIgnoredIPs((prev) => {
        const next = new Set(prev);
        next.delete(result.ip);
        return next;
      });
      addToast('Failed to ignore device. Please try again.', 'error');
    }
  }

  /**
   * Lifts the suppression on an ignored device, making it eligible for provisioning again.
   */
  async function handleUnignore(result: DiscoveryResult) {
    // Optimistic update.
    setIgnoredIPs((prev) => {
      const next = new Set(prev);
      next.delete(result.ip);
      return next;
    });
    try {
      await unignoreDiscoveredHost(result.ip);
      addToast(`↩ ${result.sysName || result.ip} is now available for provisioning.`, 'success');
    } catch {
      // Rollback on failure.
      setIgnoredIPs((prev) => new Set([...prev, result.ip]));
      addToast('Failed to un-ignore device. Please try again.', 'error');
    }
  }

  /** Bulk provision: called when the admin uses "Add to Inventory" from table view. */
  async function handleAddToInventory(selected: DiscoveryResult[]) {
    if (selected.length === 0) return;
    // For bulk, open the provision modal on the first selected device.
    // Multi-device provisioning would require a batch UI — use single-device modal for now.
    if (selected.length === 1) {
      setProvisionTarget(selected[0]);
      return;
    }
    // For multiple selected: navigate to the provisioning queue after showing a toast.
    addToast(
      `Select one device at a time to provision. Use "Provision" button on each card.`,
      'warning',
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Section header */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--vf-text-primary)' }}>
          SNMP Network Discovery
        </h2>
        <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
          Scan IP ranges using ICMP sweeps and SNMP fingerprinting to discover and classify network devices.
          After discovery completes, click <strong style={{ color: '#60a5fa' }}>🔧 Provision Device</strong> on any
          card to add it to managed inventory and the topology map.
        </p>
      </div>

      {/* Workflow: Form → Status → Results */}
      {view === 'form' && (
        <div style={{ maxWidth: 640 }}>
          <DiscoveryTriggerForm onRunCreated={handleRunCreated} initialScope={initialScope} />
        </div>
      )}

      {view === 'status' && activeRunId && (
        <DiscoveryRunStatusView
          runId={activeRunId}
          onComplete={handleRunComplete}
          onBack={handleStartNew}
        />
      )}

      {view === 'results' && activeRunId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Action bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {provisionedIPs.size > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/v2/discovery?tab=all')}
                  >
                    📋 View in Inventory ({provisionedIPs.size})
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/v2/topology')}
                  >
                    🗺 View on Topology Map
                  </Button>
                </>
              )}
            </div>
            <Button variant="primary" size="sm" onClick={handleStartNew}>
              ↩ Start New Discovery
            </Button>
          </div>

          {/* Provisioned banner */}
          {provisionedIPs.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 16px', borderRadius: 8,
              background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)',
              fontSize: 13,
            }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div>
                <strong style={{ color: '#22c55e' }}>
                  {provisionedIPs.size} device{provisionedIPs.size !== 1 ? 's' : ''} provisioned
                </strong>
                <span style={{ color: 'var(--vf-text-muted)', marginLeft: 8 }}>
                  — now managed in inventory and queued for topology inclusion.
                </span>
              </div>
            </div>
          )}

          <DiscoveryResultsTable
            runId={activeRunId}
            onProvision={handleProvision}
            onAddToInventory={handleAddToInventory}
            provisionedIPs={provisionedIPs}
            inventoryDeviceMap={inventoryDeviceMap}
            inventoryMapLoading={inventoryMapLoading}
            onDeprovision={handleDeprovision}
            deprovisioningIPs={deprovisioningIPs}
            deprovisionedIPs={deprovisionedIPs}
            ignoredIPs={ignoredIPs}
            onIgnore={handleIgnore}
            onUnignore={handleUnignore}
          />
        </div>
      )}

      {/* Provision confirmation modal */}
      <ProvisionDeviceModal
        result={provisionTarget}
        open={provisionTarget !== null}
        onClose={handleProvisionModalClose}
        onConfirm={handleProvisionConfirm}
        saving={provisionSaving}
        provisioned={modalProvisioned}
        provisionedDeviceId={modalProvisionedDeviceId}
        provisionedSerialNumber={modalProvisionedSerial}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 5 — Mode Administration (admin only, WO-001)
// ─────────────────────────────────────────────────────────────────────────────
function ModeAdminTab() {
  const { addToast } = useToast();
  const [modes, setModes] = useState<DiscoveryModesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiClient.get<DiscoveryModesResponse>('/discovery/modes')
      .then((r) => setModes(r.data))
      .catch((e) => { logger.error('Mode fetch failed', e); addToast('Failed to load discovery modes', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(load, [load]);

  async function toggleMode(modeKey: 'UBR_CALL_HOME' | 'GENERIC_DISCOVERY', currentEnabled: boolean) {
    setSaving(modeKey);
    try {
      await apiClient.put(`/discovery/modes/${modeKey}`, {
        enabled: !currentEnabled,
        rolloutLevel: !currentEnabled ? 'production' : 'disabled',
        reason: `Mode ${!currentEnabled ? 'enabled' : 'disabled'} via UI`,
      });
      addToast(`${modeKey} ${!currentEnabled ? 'enabled' : 'disabled'}`, 'success');
      load();
    } catch (e: unknown) {
      const err = e as { response?: { status?: number } };
      if (err?.response?.status === 403) {
        addToast('Admin role required to change discovery modes', 'error');
      } else {
        addToast('Failed to update discovery mode', 'error');
      }
      logger.error('Mode toggle failed', e);
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <LoadingState label="Loading discovery mode policies…" />;

  const modeEntries: Array<{ key: 'UBR_CALL_HOME' | 'GENERIC_DISCOVERY'; label: string; entry: DiscoveryModeEntry }> = modes ? [
    { key: 'UBR_CALL_HOME', label: 'UBR Call-Home', entry: modes.ubrCallHome },
    { key: 'GENERIC_DISCOVERY', label: 'Generic Discovery', entry: modes.genericDiscovery },
  ] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--vf-text-muted)', padding: '8px 0' }}>
        Discovery modes control whether UBR call-home and generic SNMP/CLI discovery are active.
        <strong style={{ color: '#f87171' }}> Admin role required to change.</strong>
      </div>
      {modeEntries.map(({ key, label, entry }) => (
        <div key={key} style={{
          background: 'var(--vf-surface)',
          border: `1px solid ${entry.enabled ? 'rgba(34,197,94,0.3)' : 'var(--vf-border-subtle)'}`,
          borderRadius: 10, padding: '20px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 20,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{label}</div>
            <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 4 }}>
              Rollout: <span style={{ fontWeight: 600 }}>{entry.rolloutLevel}</span>
              {entry.betaSignoffRef && <> · Signoff: <span style={{ fontFamily: 'monospace' }}>{entry.betaSignoffRef}</span></>}
            </div>
            {entry.reason && (
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 3 }}>Reason: {entry.reason}</div>
            )}
            {entry.updatedBy && (
              <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                Last updated by <strong>{entry.updatedBy}</strong>
                {entry.updatedAt ? ` at ${new Date(entry.updatedAt).toLocaleString()}` : ''}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Badge variant={entry.enabled ? 'success' : 'default'} dot>
              {entry.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Button
              variant={entry.enabled ? 'ghost' : 'primary'}
              size="sm"
              onClick={() => toggleMode(key, entry.enabled)}
              disabled={saving === key}
            >
              {saving === key ? 'Saving…' : entry.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick Discovery Bar — always-visible inline widget above the tab bar.
// Users can enter an IP/CIDR and click "Discover" without switching tabs.
// ─────────────────────────────────────────────────────────────────────────────

type QuickState = 'idle' | 'running' | 'done' | 'error';

function QuickDiscoveryBar() {
  const { addToast } = useToast();
  // Default to the Python snmpsim container at its static Docker IP (10.10.10.25).
  // Switch to host.docker.internal when using iReasoning Agent Simulator on Mac host.
  const [ip, setIp] = useState('10.10.10.25');
  const [state, setState] = useState<QuickState>('idle');
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  // Track the active run ID so the Provision button can reference it
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Track which IPs have been provisioned in this session
  const [provisionedIPs, setProvisionedIPs] = useState<Set<string>>(new Set());
  const [provisioningIP, setProvisioningIP] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function handleDiscover() {
    if (!ip.trim()) { addToast('Enter an IP address or CIDR to discover', 'error'); return; }
    setState('running');
    setResults([]);
    setErrorMsg('');
    setActiveRunId(null);
    setProvisionedIPs(new Set());
    stopPoll();
    try {
      const run = await createDiscoveryRun({
        scope: parseScopeInput(ip.trim()),
        protocol: 'SNMP_V2C',
        community: 'public',
        timeoutSeconds: 5,
        retries: 2,
      });
      setActiveRunId(run.runId);

      // Poll until COMPLETED / FAILED
      pollRef.current = setInterval(async () => {
        try {
          const detail = await getDiscoveryRun(run.runId);
          if (detail.status === 'COMPLETED') {
            stopPoll();
            const hostResults = await getDiscoveryRunResults(run.runId);
            setResults(hostResults);
            setState('done');
          } else if (detail.status === 'FAILED' || detail.status === 'CANCELLED') {
            stopPoll();
            setErrorMsg(detail.failureReason ?? 'Discovery failed');
            setState('error');
          }
        } catch (e) {
          logger.error('QuickDiscoveryBar: poll error', e);
        }
      }, 2000);
    } catch (e) {
      logger.error('QuickDiscoveryBar: createDiscoveryRun failed', e);
      setErrorMsg('Failed to start discovery. Is the discovery service running?');
      setState('error');
    }
  }

  function handleReset() {
    stopPoll();
    setState('idle');
    setResults([]);
    setErrorMsg('');
    setActiveRunId(null);
    setProvisionedIPs(new Set());
  }

  /**
   * Provisions a discovered host into managed inventory.
   * Called when admin clicks "⚡ Provision Device" on a QuickDiscoveryBar result card.
   * Derives a serial number from the hostname + IP and sends status=ONLINE so the
   * device immediately appears on the topology map.
   */
  async function handleQuickProvision(r: DiscoveryResult) {
    if (!activeRunId) return;
    setProvisioningIP(r.ip);
    try {
      const serial = `SNMP-${(r.sysName || r.ip).replace(/[^A-Za-z0-9]/g, '-').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const req: ProvisionHostRequest = {
        ip:           r.ip,
        serialNumber: serial,
        macAddress:   '',
        // Map SNMP generic device type to the NMS device type enum.
        // SWITCHes and ROUTERs are modelled as BTS (managed network equipment);
        // servers and unknown devices default to CPE.
        deviceType:   (r.genericDeviceType === 'SERVER' ? 'CPE' : 'BTS') as 'BTS' | 'CPE' | 'IDU',
        vendor:       r.vendor     || undefined,
        model:        r.model      || undefined,
        sysObjectID:  r.sysObjectID || undefined,
        sysDescr:     r.sysDescr   || undefined,
        sysName:      r.sysName    || undefined,
        sysLocation:  r.sysLocation || undefined,
        // Place in Bengaluru data-centre as default GPS anchor when no location is known.
        // The admin can update the GPS coordinates later from the inventory page.
        latitude:  12.9716,
        longitude: 77.5946,
      };
      const resp = await provisionDiscoveredHosts(activeRunId, [req]);
      const result = resp.results[0];
      if (!result || result.status === 'failed') {
        addToast(result?.error ?? 'Provisioning failed — check the inventory service.', 'error');
        return;
      }
      setProvisionedIPs((prev) => new Set([...prev, r.ip]));
      addToast(
        `✅ ${r.sysName || r.ip} provisioned (${result.deviceId?.slice(0, 8) ?? '?'}…) — visible in inventory & topology.`,
        'success',
      );
    } catch (err: unknown) {
      logger.error('QuickDiscoveryBar: provision failed', err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        addToast('Device already exists in inventory.', 'error');
      } else {
        addToast('Failed to provision device. Is the inventory service running?', 'error');
      }
    } finally {
      setProvisioningIP(null);
    }
  }

  // Derived result icon helpers
  function icmpLabel(s: string) {
    if (s === 'reachable') return '✅ Reachable';
    if (s === 'unreachable') return '❌ Unreachable';
    return '⚠️ Timeout';
  }
  function snmpLabel(s: string) {
    if (s === 'success') return '✅ Successful';
    if (s === 'auth_failed') return '❌ Auth Failed';
    if (s === 'timeout') return '⚠️ Timeout';
    if (s === 'not_attempted') return '⬜ Not Attempted';
    return s;
  }

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(99,102,241,0.06) 100%)',
      border: '1px solid rgba(59,130,246,0.3)',
      borderRadius: 12,
      padding: '20px 24px',
      marginBottom: 24,
    }}>
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 22 }}>📡</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)' }}>
            Quick SNMP Discovery
          </div>
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 2 }}>
            Enter an IP address or CIDR — the system will ICMP-ping then SNMP-fingerprint each host.
          </div>
        </div>
      </div>

      {/* Input + button row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, maxWidth: 380 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Target IP / CIDR
          </label>
          <Input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="10.10.10.25 or 192.168.1.0/24"
            disabled={state === 'running'}
            style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 14 }}
            fullWidth
          />
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={handleDiscover}
          loading={state === 'running'}
          disabled={state === 'running' || !ip.trim()}
          style={{ minWidth: 140, height: 40, fontSize: 14, fontWeight: 700 }}
        >
          {state === 'running' ? 'Discovering…' : '🔍  Discover'}
        </Button>
        {(state === 'done' || state === 'error') && (
          <Button variant="ghost" size="md" onClick={handleReset} style={{ height: 40 }}>
            Reset
          </Button>
        )}
      </div>

      {/* Running indicator */}
      {state === 'running' && (
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--vf-text-muted)' }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
          <span>Running ICMP sweep → SNMP fingerprint → classification…</span>
        </div>
      )}

      {/* Error */}
      {state === 'error' && (
        <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: 13 }}>
          ❌ {errorMsg}
        </div>
      )}

      {/* Results — tree-style cards */}
      {state === 'done' && results.length === 0 && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--vf-text-muted)' }}>
          No hosts responded. Check the IP range and SNMP credentials.
        </div>
      )}
      {state === 'done' && results.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', fontWeight: 600 }}>
            Discovery complete — {results.length} host{results.length !== 1 ? 's' : ''} found
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {results.map((r) => {
              const ok = r.icmpStatus === 'reachable' && r.snmpStatus === 'success';
              return (
                <div key={r.ip} style={{
                  background: 'var(--vf-surface)',
                  border: `1px solid ${ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius: 10,
                  padding: '14px 16px',
                  fontFamily: 'var(--vf-font-mono)',
                  fontSize: 13,
                }}>
                  {/* IP heading */}
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
                    {r.ip}
                  </div>
                  {/* Tree rows */}
                  {[
                    ['ICMP',         icmpLabel(r.icmpStatus)],
                    ['SNMP',         snmpLabel(r.snmpStatus)],
                    ['Manufacturer', r.vendor     || 'N/A'],
                    ['Model',        r.model      || 'N/A'],
                    ['Hostname',     r.sysName    || 'N/A'],
                    ['Discovery',    ok ? '✅ Successful' : '❌ Failed'],
                  ].map(([label, value], idx, arr) => (
                    <div key={label} style={{
                      display: 'flex', gap: 8, padding: '3px 0',
                      borderLeft: '2px solid var(--vf-border-subtle)',
                      marginLeft: 6, paddingLeft: 10, fontSize: 12,
                    }}>
                      <span style={{ color: 'var(--vf-text-muted)', minWidth: 28, flexShrink: 0 }}>
                        {idx === arr.length - 1 ? '└──' : '├──'}
                      </span>
                      <span style={{ color: '#60a5fa', minWidth: 110, flexShrink: 0, fontWeight: 600 }}>{label}:</span>
                      <span style={{ color: 'var(--vf-text-primary)' }}>{value}</span>
                    </div>
                  ))}

                  {/* Provision action — shown after a successful discovery */}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--vf-border-subtle)' }}>
                    {provisionedIPs.has(r.ip) ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
                        <span>✅</span>
                        <span>Provisioned — visible in Inventory &amp; Topology</span>
                      </div>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleQuickProvision(r)}
                        loading={provisioningIP === r.ip}
                        disabled={!ok || !!provisioningIP}
                        style={{ width: '100%', fontWeight: 700 }}
                        title={!ok ? 'Device must be reachable via ICMP and SNMP to provision' : 'Provision this device into managed inventory and topology'}
                      >
                        ⚡ Provision Device
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function V2DiscoveryPage() {
  const { addToast } = useToast();
  // Default to SNMP Discovery so the user lands on the actionable workflow tab.
  const [tab, setTab] = useState<DiscoveryTab>('snmp_discovery');

  // Pre-populate scope for the SNMP Discovery trigger form.
  // Default: 10.10.10.25 (Python snmpsim container static Docker IP).
  // Updated to a run's scope when the user clicks "Re-run" in the Run History tab (WO-015).
  const [rerunScope, setRerunScope] = useState<string | undefined>('10.10.10.25');

  // KPI counts
  const [stats, setStats] = useState({ provisioning: 0, online: 0, offline: 0, authFails: 0 });
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    setStatsLoading(true);
    Promise.allSettled([
      fetchDevices({ status: 'PROVISIONING' }),
      fetchDevices({ status: 'ONLINE' }),
      fetchDevices({ status: 'OFFLINE' }),
      fetchAlarms({ severity: ['CRITICAL'] }),
    ]).then(([prov, online, offline, authAlarms]) => {
      setStats({
        provisioning: prov.status === 'fulfilled' ? prov.value.length : 0,
        online:       online.status === 'fulfilled' ? online.value.length : 0,
        offline:      offline.status === 'fulfilled' ? offline.value.length : 0,
        authFails:    authAlarms.status === 'fulfilled'
          ? authAlarms.value.filter((a) => a.alarmName?.toLowerCase().includes('auth') || a.alarmType?.toLowerCase().includes('auth')).length
          : 0,
      });
    }).catch((e) => {
      logger.error('Discovery stats failed', e);
      addToast('Failed to load discovery stats', 'error');
    }).finally(() => setStatsLoading(false));
  }, [addToast]);

  return (
    <div className="vf-page">
      {/* Header */}
      <div className="vf-page-header">
        <div>
          <h1 className="vf-page-title">Device Discovery</h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '4px 0 0' }}>
            Enter an IP address below and click <strong style={{ color: '#60a5fa' }}>Discover</strong> to run ICMP + SNMP discovery. (NMS-DIS-01 to DIS-06)
          </p>
        </div>
      </div>

      {/* KPI Row */}
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <MetricCard label="Awaiting Onboard" value={stats.provisioning} variant="warning" loading={statsLoading} />
        <MetricCard label="Online" value={stats.online} variant="success" loading={statsLoading} />
        <MetricCard label="Offline" value={stats.offline} variant="danger" loading={statsLoading} />
        <MetricCard label="Auth Failures" value={stats.authFails} variant="danger" loading={statsLoading} />
      </div>

      {/* Auth failure alert banner */}
      {!statsLoading && stats.authFails > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          marginBottom: 24, fontSize: 13,
        }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div>
            <strong style={{ color: '#f87171' }}>{stats.authFails} authentication failure{stats.authFails > 1 ? 's' : ''} detected.</strong>
            <span style={{ color: 'var(--vf-text-muted)', marginLeft: 6 }}>Unauthorized devices attempting to connect. Review Auth Failures tab.</span>
          </div>
          <button
            onClick={() => setTab('auth_failures')}
            style={{ marginLeft: 'auto', fontSize: 12, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            View details
          </button>
        </div>
      )}

      {/* ── Quick Discovery Widget — always visible, no tab switching needed ── */}
      <QuickDiscoveryBar />

      {/* Tab bar */}
      <div style={{
        display: 'flex', background: 'var(--vf-surface)',
        borderBottom: '1px solid rgba(77,158,255,0.1)',
        marginBottom: 24, marginLeft: -28, marginRight: -28, paddingLeft: 28,
      }}>
        <TabBtn id="provisioning"     active={tab === 'provisioning'}     count={stats.provisioning} onClick={setTab} />
        <TabBtn id="auth_failures"    active={tab === 'auth_failures'}    count={stats.authFails}    onClick={setTab} />
        <TabBtn id="all"              active={tab === 'all'}                                          onClick={setTab} />
        <TabBtn id="snmp_discovery"   active={tab === 'snmp_discovery'}                               onClick={setTab} />
        <TabBtn id="run_history"      active={tab === 'run_history'}                                  onClick={setTab} />
        <TabBtn id="snmp_credentials" active={tab === 'snmp_credentials'}                             onClick={setTab} />
        <TabBtn id="schedules"        active={tab === 'schedules'}                                    onClick={setTab} />
        <TabBtn id="mode_admin"       active={tab === 'mode_admin'}                                   onClick={setTab} />
      </div>

      {/* Tab content */}
      {tab === 'provisioning'   && <ProvisioningTab />}
      {tab === 'auth_failures'  && <AuthFailuresTab />}
      {tab === 'all'            && <AllDiscoveredTab />}
      {tab === 'snmp_discovery' && <SnmpDiscoveryTab initialScope={rerunScope} />}
      {tab === 'run_history'    && (
        <DiscoveryRunHistory
          onRerun={(run: DiscoveryRunSummary) => {
            // Build a comma-separated scope string from the run's normalised scope.
            const scope = run.normalizedScope
              ? run.normalizedScope.map((s) => s.value).join(', ')
              : run.scopeSummary ?? '';
            setRerunScope(scope || undefined);
            setTab('snmp_discovery');
          }}
        />
      )}
      {tab === 'snmp_credentials' && <CredentialManager />}
      {tab === 'schedules'        && <DiscoverySchedules />}
      {tab === 'mode_admin'       && <ModeAdminTab />}
    </div>
  );
}

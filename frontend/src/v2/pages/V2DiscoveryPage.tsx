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
  mapGenericTypeToDeviceType,
} from '../../api/discovery.api';
import type {
  DiscoveryRunResponse,
  DiscoveryResult,
  ProvisionHostRequest,
} from '../../api/discovery.api';
import type { DiscoveryRunSummary } from '../../api/discovery.api';
import {
  listAllUploadHistory,
  getVersionSchema,
} from '../../api/productDefinitions.api';
import type { ProductDefinitionVersion } from '../../api/productDefinitions.types';

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
// ICMP Diagnostic Banner — shown in results when ALL hosts timed out on ICMP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the results of a discovery run and, when ALL hosts have
 * icmpStatus='timeout', shows a prominent diagnostic banner explaining
 * why discovery showed no SNMP data and how to use ICMP bypass instead.
 */
function IcmpDiagnosticBanner({ runId, onStartNew }: { runId: string; onStartNew: () => void }) {
  const [allTimeout, setAllTimeout] = useState(false);
  const [resultCount, setResultCount] = useState(0);

  useEffect(() => {
    if (!runId) return;
    // Wait a tick so the results table also loads
    const t = setTimeout(async () => {
      try {
        const res = await apiClient.get<DiscoveryResult[]>(`/discovery/runs/${runId}/results`);
        const results = res.data ?? [];
        if (results.length > 0 && results.every((r) => r.icmpStatus === 'timeout')) {
          setResultCount(results.length);
          setAllTimeout(true);
        }
      } catch { /* non-fatal */ }
    }, 1500);
    return () => clearTimeout(t);
  }, [runId]);

  if (!allTimeout) return null;

  return (
    <div style={{
      padding: '14px 18px', borderRadius: 10,
      background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)',
      display: 'flex', gap: 14, alignItems: 'flex-start',
    }}>
      <span style={{ fontSize: 22, flexShrink: 0 }}>⚠️</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>
          All {resultCount} host{resultCount !== 1 ? 's' : ''} timed out on ICMP ping — SNMP was not attempted
        </div>
        <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
          The Java discovery service pings each host first. Docker containers, simulators
          (<code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>host.docker.internal</code>,
          explicit <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>host:port</code> targets)
          and hosts behind ICMP-blocking firewalls will always time out here.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={onStartNew}
            style={{
              padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
              background: 'rgba(245,158,11,0.2)', border: '1px solid rgba(245,158,11,0.5)', color: '#f59e0b',
            }}
          >
            ⚡ Start New Discovery →
          </button>
          <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', alignSelf: 'center' }}>
            Use the Quick Probe bar above for instant SNMP-only discovery without full sweep.
          </span>
        </div>
      </div>
    </div>
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
          {/* ICMP-all-timeout diagnostic banner — shown when no hosts were ICMP-reachable */}
          <IcmpDiagnosticBanner runId={activeRunId} onStartNew={handleStartNew} />
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
/** Discovery mode: ICMP + SNMP full scan (Java service) or direct SNMP probe (gateway stub) */
type QuickMode = 'full_scan' | 'direct_probe';

// ── Simulator presets — auto-fill targets for known local simulators ─────────
interface SimPreset {
  label:     string;
  icon:      string;
  target:    string;
  community: string;
  protocol:  'SNMP_V2C' | 'SNMP_V1';
  mode:      'direct_probe' | 'full_scan';
  badge:     string;
  badgeColor: string;
}

const SIM_PRESETS: SimPreset[] = [
  {
    label:     'EOC Configurations_GUI — BTS (A60) + CPE (A61)',
    icon:      '📡',
    target:    'host.docker.internal:1162,host.docker.internal:1163',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'direct_probe',
    badge:     'EOC',
    badgeColor: '#ec4899',
  },
  {
    label:     'EOC BTS only (A60 — port 1162)',
    icon:      '🗼',
    target:    'host.docker.internal:1162',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'direct_probe',
    badge:     'BTS',
    badgeColor: '#8b5cf6',
  },
  {
    label:     'EOC CPE only (A61 — port 1163)',
    icon:      '📶',
    target:    'host.docker.internal:1163',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'direct_probe',
    badge:     'CPE',
    badgeColor: '#22c55e',
  },
  {
    label:     'Cisco Catalyst 2960 (nms-snmpsim — port 1161)',
    icon:      '🔀',
    target:    'host.docker.internal:1161',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'direct_probe',
    badge:     'SWITCH',
    badgeColor: '#06b6d4',
  },
  {
    label:     'iReasoning Agent (Mac host — port 161)',
    icon:      '🖥',
    target:    'host.docker.internal:161',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'direct_probe',
    badge:     'EXT',
    badgeColor: '#f59e0b',
  },
  {
    label:     'Full Subnet Scan (10.10.10.0/24)',
    icon:      '🌐',
    target:    '10.10.10.0/24',
    community: 'public',
    protocol:  'SNMP_V2C',
    mode:      'full_scan',
    badge:     'SCAN',
    badgeColor: '#3b82f6',
  },
];

function QuickDiscoveryBar() {
  const { addToast } = useToast();

  // Target: IP, CIDR, or host:port for direct-probe (e.g. host.docker.internal:1162)
  const [ip, setIp] = useState('host.docker.internal:1162,host.docker.internal:1163');
  // Discovery mode — full scan uses Java ICMP+SNMP; direct probe skips ICMP
  const [mode, setMode] = useState<QuickMode>('direct_probe');
  // SNMP configuration — preserved across multi-vendor, multi-device discovery
  const [snmpProtocol, setSnmpProtocol] = useState<'SNMP_V2C' | 'SNMP_V1'>('SNMP_V2C');
  const [community, setCommunity] = useState('public');

  // ── Product Definition (vendor-independent flow) ─────────────────────────
  // Selecting a definition tags ALL discovered devices with that productDefinitionId,
  // enabling discovery for ANY vendor/device without hardcoded presets.
  const [uploadedVersions, setUploadedVersions] = useState<ProductDefinitionVersion[]>([]);
  const [selectedVersionKey, setSelectedVersionKey] = useState<string>('');
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(null);
  const [pdSchemaLoading, setPdSchemaLoading] = useState(false);

  // Load all uploaded product definitions on mount
  useEffect(() => {
    listAllUploadHistory()
      .then(setUploadedVersions)
      .catch(() => {/* non-fatal */});
  }, []);

  // When the user picks a definition version, load its schema to auto-configure protocol
  useEffect(() => {
    if (!selectedVersionKey) {
      setSelectedDefinitionId(null);
      return;
    }
    const [definitionId, versionId] = selectedVersionKey.split('::');
    if (!definitionId || !versionId) { setSelectedDefinitionId(null); return; }
    setSelectedDefinitionId(definitionId);
    setPdSchemaLoading(true);
    getVersionSchema(definitionId, versionId)
      .then((schema) => {
        if (!schema) return;
        // Auto-set SNMP protocol from definition protocols list
        if (schema.protocols.some((p) => /SNMP_V1/i.test(p)) && !schema.protocols.some((p) => /SNMP_V2C?/i.test(p))) {
          setSnmpProtocol('SNMP_V1');
        } else {
          setSnmpProtocol('SNMP_V2C');
        }
      })
      .catch(() => {/* non-fatal */})
      .finally(() => setPdSchemaLoading(false));
  }, [selectedVersionKey]);

  const [state, setState] = useState<QuickState>('idle');
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  // Direct-probe results (from snmp-probe endpoint — richer than full-scan when ICMP is blocked)
  const [probeResults, setProbeResults] = useState<Array<{
    ip: string; port: number; sysName: string | null; sysDescr: string;
    sysObjectID: string | null; sysLocation: string | null;
    vendor: string; model: string; genericDeviceType: string;
    productDefinitionId: string | null; provisioned: boolean;
  }>>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [provisionedIPs, setProvisionedIPs] = useState<Set<string>>(new Set());
  const [provisioningIP, setProvisioningIP] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  /** Direct SNMP Probe — calls the gateway snmp-probe endpoint (no ICMP required). */
  async function handleDirectProbe() {
    const target = ip.trim();
    if (!target) { addToast('Enter a host:port target (e.g. 192.168.65.254:161)', 'error'); return; }
    setState('running');
    setProbeResults([]);
    setErrorMsg('');
    setProvisionedIPs(new Set());
    try {
      // Support both plain IP (defaults port 161) and host:port notation
      const targets = target.includes(',')
        ? target.split(',').map((t) => t.trim()).filter(Boolean)
        : [target];
      const res = await apiClient.post<{
        probed: number; discovered: number; errors: number;
        devices: typeof probeResults; errorDetails: Array<{ target: string; error: string }>;
      }>('/discovery/snmp-probe', {
        targets,
        community: community.trim() || 'public',
        provision: true,
        snmpVersion: snmpProtocol,
        // Vendor-independent: pass the selected definition so ALL responding devices
        // are tagged with productDefinitionId — works for any uploaded config file.
        ...(selectedDefinitionId ? { productDefinitionId: selectedDefinitionId } : {}),
      });
      if (res.data.devices.length === 0) {
        setErrorMsg(
          res.data.errorDetails.length > 0
            ? res.data.errorDetails.map((e) => `${e.target}: ${e.error}`).join('; ')
            : 'No devices responded. Check host:port and community string.',
        );
        setState('error');
      } else {
        setProbeResults(res.data.devices);
        // Mark all provisioned
        setProvisionedIPs(new Set(res.data.devices.map((d) => d.ip)));
        setState('done');
      }
    } catch (e: unknown) {
      logger.error('QuickDiscoveryBar: snmp-probe failed', e);
      setErrorMsg('SNMP probe failed. Check the target is reachable and community is correct.');
      setState('error');
    }
  }

  /** Full ICMP + SNMP Scan — calls the Java discovery service (requires ICMP reachability). */
  async function handleFullScan() {
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
        protocol: snmpProtocol,
        community: community.trim() || 'public',
        timeoutSeconds: 5,
        retries: 2,
        // Vendor-independent tagging for full ICMP+SNMP scans too
        ...(selectedDefinitionId ? { productDefinitionId: selectedDefinitionId } : {}),
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

  async function handleDiscover() {
    if (mode === 'direct_probe') return handleDirectProbe();
    return handleFullScan();
  }

  function handleReset() {
    stopPoll();
    setState('idle');
    setResults([]);
    setProbeResults([]);
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
        // Device-reported role first; generic-type mapping only when the device doesn't report one.
        deviceType:   r.deviceRole ?? mapGenericTypeToDeviceType(r.genericDeviceType),
        deviceRoleSource: r.deviceRoleSource,
        vendor:       r.vendor     || undefined,
        model:        r.model      || undefined,
        sysObjectID:  r.sysObjectID || undefined,
        sysDescr:     r.sysDescr   || undefined,
        sysName:      r.sysName    || undefined,
        sysLocation:  r.sysLocation || undefined,
        // Device-reported GPS only; without it topology shows an approximate position.
        latitude:  r.latitude,
        longitude: r.longitude,
        locationSource: r.locationSource,
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

  // Label helpers (for full-scan results)
  const SEL_STYLE: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)',
    background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 12,
    cursor: 'pointer', outline: 'none',
  };

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
            Discover any multivendor device — Cisco, Juniper, EOC640, iReasoning sim — via real SNMP v2c/v1.
          </div>
        </div>
        {/* Mode toggle */}
        <div style={{ marginLeft: 'auto', display: 'flex', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 3, gap: 2 }}>
          {(['direct_probe', 'full_scan'] as QuickMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: mode === m ? 'rgba(96,165,250,0.25)' : 'transparent',
              color: mode === m ? '#60a5fa' : 'var(--vf-text-muted)',
              transition: 'all 0.15s',
            }}>
              {m === 'direct_probe' ? '🔌 Direct Probe' : '📡 Full Scan'}
            </button>
          ))}
        </div>
      </div>

      {/* Mode description */}
      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 14, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
        {mode === 'direct_probe'
          ? '🔌 Direct Probe — sends SNMP GET directly (no ICMP ping). Use for iReasoning simulator, nms-snmpsim, or when ICMP is blocked. Accepts host:port (e.g. 192.168.65.254:161 or 172.30.0.15:1161).'
          : '📡 Full Scan — ICMP ping sweep followed by SNMP fingerprint via the Java discovery service. Use for production subnets where ICMP is allowed (e.g. 10.10.10.0/24).'}
      </div>

      {/* ── Row 0: Vendor-independent Product Definition picker ─────────────────
           Any uploaded config file (any vendor, any device) appears here.
           Selecting a definition:
            • tags ALL discovered devices with its productDefinitionId
            • auto-sets the SNMP protocol from the definition's protocol list
            • works without any hardcoded vendor logic                         */}
      <div style={{
        marginBottom: 14,
        padding: '12px 14px',
        background: 'rgba(96,165,250,0.07)',
        border: '1px solid rgba(96,165,250,0.22)',
        borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 16 }}>📂</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Product Definition — vendor &amp; device independent
          </span>
          {pdSchemaLoading && (
            <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginLeft: 4 }}>Loading schema…</span>
          )}
          {selectedDefinitionId && !pdSchemaLoading && (
            <span style={{
              marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8,
              background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)',
            }}>✓ Active — devices will be tagged with "{selectedDefinitionId}"</span>
          )}
        </div>

        {uploadedVersions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', fontStyle: 'italic' }}>
            No product definitions uploaded yet. Upload a config file (XML/JSON) in the Product Definitions section to enable vendor-independent discovery.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 4 }}>
                Select Definition (any vendor)
              </label>
              <select
                value={selectedVersionKey}
                onChange={(e) => setSelectedVersionKey(e.target.value)}
                disabled={state === 'running'}
                style={{
                  width: '100%', appearance: 'none',
                  background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
                  borderRadius: 'var(--vf-radius-md)', color: 'var(--vf-text-primary)',
                  fontSize: 13, padding: '7px 10px',
                  fontFamily: 'var(--vf-font-sans)', cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="">— None (OID + banner auto-classify) —</option>
                {uploadedVersions.map((v) => (
                  <option key={`${v.definitionId}::${v.versionId}`} value={`${v.definitionId}::${v.versionId}`}>
                    {v.vendor ?? ''} {v.model ?? v.name ?? ''} · v{v.registryVersion ?? v.versionId?.slice(-6)} [{v.lifecycleStatus}]
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 2, display: 'block' }}>
                Any device responding to SNMP will be tagged with this definition — works for Cisco, Juniper, EOC, or any vendor
              </span>
            </div>
            {selectedDefinitionId && (
              <button
                onClick={() => { setSelectedVersionKey(''); setSelectedDefinitionId(null); }}
                disabled={state === 'running'}
                style={{
                  padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.4)',
                  background: 'rgba(239,68,68,0.08)', color: '#f87171',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                }}
              >✕ Clear</button>
            )}
          </div>
        )}
      </div>

      {/* Row 0b: Simulator Quick-Fill Presets (secondary — for test environments) */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          🎛 Quick Fill — load a simulator target (optional)
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {SIM_PRESETS.map((p) => (
            <button
              key={p.label}
              disabled={state === 'running'}
              onClick={() => {
                setIp(p.target);
                setCommunity(p.community);
                setSnmpProtocol(p.protocol);
                setMode(p.mode);
              }}
              title={`Target: ${p.target}\nProtocol: ${p.protocol}\nCommunity: ${p.community}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 11px', borderRadius: 7, border: `1px solid ${p.badgeColor}55`,
                background: ip === p.target ? `${p.badgeColor}22` : 'rgba(255,255,255,0.03)',
                color: ip === p.target ? p.badgeColor : 'var(--vf-text-secondary)',
                cursor: state === 'running' ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: ip === p.target ? 700 : 400,
                transition: 'all 0.15s',
                outline: ip === p.target ? `2px solid ${p.badgeColor}66` : 'none',
              }}
            >
              <span>{p.icon}</span>
              <span style={{
                fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3,
                background: p.badgeColor, color: '#fff', letterSpacing: '0.05em',
              }}>{p.badge}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 1: Target + SNMP config */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
        {/* Target */}
        <div style={{ flex: 2, minWidth: 220 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {mode === 'direct_probe' ? 'Target(s) — host:port or comma-separated' : 'Target IP / CIDR'}
          </label>
          <Input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder={mode === 'direct_probe' ? '192.168.65.254:161  or  172.30.0.15:1161' : '10.10.10.25  or  10.10.10.0/24'}
            disabled={state === 'running'}
            style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 13 }}
            fullWidth
          />
        </div>

        {/* SNMP Protocol — preserved for multivendor */}
        <div style={{ minWidth: 160 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            SNMP Protocol
          </label>
          <select value={snmpProtocol} onChange={(e) => setSnmpProtocol(e.target.value as 'SNMP_V2C' | 'SNMP_V1')}
            disabled={state === 'running'} style={SEL_STYLE}>
            <option value="SNMP_V2C">SNMPv2c (recommended)</option>
            <option value="SNMP_V1">SNMPv1</option>
          </select>
        </div>

        {/* Community String — preserved for multivendor */}
        <div style={{ minWidth: 140 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Community String
          </label>
          <input
            type="password"
            autoComplete="off"
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
            placeholder="public"
            disabled={state === 'running'}
            style={{ ...SEL_STYLE, fontFamily: 'var(--vf-font-mono)', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        {/* Discover button */}
        <Button
          variant="primary"
          size="md"
          onClick={handleDiscover}
          loading={state === 'running'}
          disabled={state === 'running' || !ip.trim()}
          style={{ minWidth: 140, height: 38, fontSize: 13, fontWeight: 700 }}
        >
          {state === 'running' ? 'Discovering…' : '🔍  Discover'}
        </Button>
        {(state === 'done' || state === 'error') && (
          <Button variant="ghost" size="md" onClick={handleReset} style={{ height: 38 }}>
            Reset
          </Button>
        )}
      </div>

      {/* Running indicator */}
      {state === 'running' && (
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--vf-text-muted)' }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
          <span>{mode === 'direct_probe'
            ? `Sending SNMP GET → parsing MIB-II system group → classifying device${selectedDefinitionId ? ` as "${selectedDefinitionId}"` : ''}…`
            : `Running ICMP sweep → SNMP fingerprint → classification${selectedDefinitionId ? ` → tagging as "${selectedDefinitionId}"` : ''}…`}</span>
        </div>
      )}

      {/* Error */}
      {state === 'error' && (
        <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: 13 }}>
          ❌ {errorMsg}
        </div>
      )}

      {/* ── Direct-probe results ─────────────────────────────────────────────── */}
      {state === 'done' && mode === 'direct_probe' && probeResults.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 700 }}>
            ✅ SNMP probe complete — {probeResults.length} device{probeResults.length !== 1 ? 's' : ''} discovered &amp; provisioned to inventory
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {probeResults.map((r) => (
              <div key={`${r.ip}:${r.port}`} style={{
                background: 'var(--vf-surface)',
                border: '1px solid rgba(34,197,94,0.4)',
                borderRadius: 10, padding: '14px 16px', fontFamily: 'var(--vf-font-mono)', fontSize: 13,
              }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
                  {r.ip}:{r.port}
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: r.genericDeviceType === 'SWITCH' ? 'rgba(139,92,246,0.2)' : r.genericDeviceType === 'RADIO' ? 'rgba(236,72,153,0.2)' : 'rgba(96,165,250,0.2)',
                    color: r.genericDeviceType === 'SWITCH' ? '#a78bfa' : r.genericDeviceType === 'RADIO' ? '#f472b6' : '#60a5fa',
                  }}>{r.genericDeviceType}</span>
                </div>
                {[
                  ['Vendor',    r.vendor || 'N/A'],
                  ['Model',     r.model  || 'N/A'],
                  ['Hostname',  r.sysName || 'N/A'],
                  ['OID',       r.sysObjectID || 'N/A'],
                  ['sysDescr',  (r.sysDescr || '').substring(0, 80) || 'N/A'],
                ].map(([label, value], idx) => (
                  <div key={label} style={{
                    display: 'flex', gap: 8, padding: '2px 0',
                    borderLeft: '2px solid var(--vf-border-subtle)',
                    marginLeft: 6, paddingLeft: 10, fontSize: 11,
                  }}>
                    <span style={{ color: 'var(--vf-text-muted)', minWidth: 24, flexShrink: 0 }}>{idx === 4 ? '├──' : '├──'}</span>
                    <span style={{ color: '#60a5fa', minWidth: 90, flexShrink: 0, fontWeight: 600 }}>{label}:</span>
                    <span style={{ color: 'var(--vf-text-primary)', wordBreak: 'break-all' }}>{value}</span>
                  </div>
                ))}
                {/* Product Definition — highlighted row */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 8, padding: '6px 10px', borderRadius: 6,
                  background: r.productDefinitionId ? 'rgba(236,72,153,0.1)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${r.productDefinitionId ? 'rgba(236,72,153,0.35)' : 'var(--vf-border-subtle)'}`,
                }}>
                  <span style={{ fontSize: 11 }}>📋</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#f472b6' }}>Product Def:</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--vf-font-mono)', color: r.productDefinitionId ? '#f9a8d4' : 'var(--vf-text-muted)', fontWeight: r.productDefinitionId ? 700 : 400 }}>
                    {r.productDefinitionId || '— generic / no definition —'}
                  </span>
                </div>
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--vf-border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>✅</span>
                    <span>Provisioned — visible in Inventory &amp; Topology</span>
                  </div>
                  {r.productDefinitionId && (
                    <a
                      href="/config"
                      style={{
                        fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6,
                        background: 'rgba(236,72,153,0.15)', border: '1px solid rgba(236,72,153,0.4)',
                        color: '#f472b6', textDecoration: 'none', whiteSpace: 'nowrap',
                      }}
                    >
                      Push Config →
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Full-scan results (ICMP+SNMP) ───────────────────────────────────── */}
      {state === 'done' && mode === 'full_scan' && results.length === 0 && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--vf-text-muted)' }}>
          No hosts responded. Check the IP range and SNMP credentials.
        </div>
      )}
      {state === 'done' && mode === 'full_scan' && results.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', fontWeight: 600 }}>
            Discovery complete — {results.length} host{results.length !== 1 ? 's' : ''} found
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {results.map((r) => {
              const ok = r.snmpStatus === 'success';
              return (
                <div key={r.ip} style={{
                  background: 'var(--vf-surface)',
                  border: `1px solid ${ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.3)'}`,
                  borderRadius: 10, padding: '14px 16px', fontFamily: 'var(--vf-font-mono)', fontSize: 13,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)', marginBottom: 8 }}>{r.ip}</div>
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
                      <span style={{ color: 'var(--vf-text-muted)', minWidth: 28, flexShrink: 0 }}>{idx === arr.length - 1 ? '└──' : '├──'}</span>
                      <span style={{ color: '#60a5fa', minWidth: 110, flexShrink: 0, fontWeight: 600 }}>{label}:</span>
                      <span style={{ color: 'var(--vf-text-primary)' }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--vf-border-subtle)' }}>
                    {provisionedIPs.has(r.ip) ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
                        <span>✅</span><span>Provisioned — visible in Inventory &amp; Topology</span>
                      </div>
                    ) : (
                      <Button
                        variant="primary" size="sm"
                        onClick={() => handleQuickProvision(r)}
                        loading={provisioningIP === r.ip}
                        disabled={!ok || !!provisioningIP}
                        style={{ width: '100%', fontWeight: 700 }}
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

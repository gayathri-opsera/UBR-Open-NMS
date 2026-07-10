/**
 * V2 Device Discovery & Onboarding — REQ-001 / REQ-025 / NMS-DIS-01 to DIS-06
 *
 * Tabs:
 *  1. Provisioning Queue — devices awaiting onboarding (status=PROVISIONING)
 *  2. Auth Failures      — alarms from authentication-failed devices (NMS-DIS-05)
 *  3. All Discovered     — complete inventory including ONLINE/OFFLINE (NMS-DIS-02)
 */
import { useCallback, useEffect, useState } from 'react';
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

// ── Types ─────────────────────────────────────────────────────────────────────
type DiscoveryTab = 'provisioning' | 'auth_failures' | 'all';

const TAB_LABELS: Record<DiscoveryTab, string> = {
  provisioning:  'Provisioning Queue',
  auth_failures: 'Auth Failures',
  all:           'All Discovered',
};

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
                {['Type', 'Serial', 'IP', 'Model', 'Status', 'Firmware', 'Last Seen'].map((h) => (
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
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function V2DiscoveryPage() {
  const { addToast } = useToast();
  const [tab, setTab] = useState<DiscoveryTab>('provisioning');

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
            Devices connect proactively to NMS via mTLS. Only Airtel-authenticated devices are onboarded. (NMS-DIS-01 to DIS-06)
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

      {/* Protocol info bar */}
      <div style={{
        display: 'flex', gap: 24, padding: '12px 16px',
        background: 'var(--vf-surface)', borderRadius: 8,
        border: '1px solid var(--vf-border-subtle)', marginBottom: 24, fontSize: 12,
      }}>
        {[
          { icon: '🔒', label: 'mTLS Auth', desc: 'Airtel-issued client certs' },
          { icon: '✍️', label: 'HMAC-SHA256', desc: 'Message integrity & replay protection' },
          { icon: '⏱️', label: '5 min check-in', desc: 'Periodic device reports' },
          { icon: '🌐', label: 'WebSocket', desc: 'Real-time bidirectional commands' },
        ].map(({ icon, label, desc }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{icon}</span>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--vf-text-primary)' }}>{label}</div>
              <div style={{ color: 'var(--vf-text-muted)' }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', background: 'var(--vf-surface)',
        borderBottom: '1px solid rgba(77,158,255,0.1)',
        marginBottom: 24, marginLeft: -28, marginRight: -28, paddingLeft: 28,
      }}>
        <TabBtn id="provisioning"  active={tab === 'provisioning'}  count={stats.provisioning} onClick={setTab} />
        <TabBtn id="auth_failures" active={tab === 'auth_failures'} count={stats.authFails}    onClick={setTab} />
        <TabBtn id="all"           active={tab === 'all'}                                      onClick={setTab} />
      </div>

      {/* Tab content */}
      {tab === 'provisioning'  && <ProvisioningTab />}
      {tab === 'auth_failures' && <AuthFailuresTab />}
      {tab === 'all'           && <AllDiscoveredTab />}
    </div>
  );
}

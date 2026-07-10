import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { fetchDevices, updateDevice } from '../../api/devices.api';
import { fetchDeviceKpi } from '../../api/kpi.api';
import { timeRangeToGranularity, timeRangeToMs, KPI_PARAMS } from '../../api/kpi.types';
import { pushDeviceParam, getVersionHistory } from '../../api/config.api';
import { extractDeviceLogs } from '../../api/diagnostics.api';
import type { LogEntry } from '../../api/diagnostics.api';
import type { Device } from '../../api/devices.types';
import type { KpiSeries } from '../../api/kpi.types';
import { Tabs, TabPanel } from '../components/common/Tabs';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Card } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { MetricCard } from '../components/common/MetricCard';
import { Spinner } from '../components/common/Spinner';
import { EmptyState, LoadingState } from '../components/common/States';
import { KpiMiniChart } from '../components/kpi/KpiMiniChart';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';
import { WirelessConfigTab } from '../components/device/WirelessConfigTab';

const TABS = [
  { id: 'summary',   label: 'Summary' },
  { id: 'wireless',  label: 'Wireless' },
  { id: 'network',   label: 'Network' },
  { id: 'ethernet',  label: 'Ethernet' },
  { id: 'qos',       label: 'QoS' },
  { id: 'vlan',      label: 'VLAN' },
  { id: 'gps',       label: 'GPS' },
  { id: 'birth',     label: 'Birth Cert' },
  { id: 'tags',      label: 'Tags' },
  { id: 'logs',      label: 'Logs' },
  { id: 'history',   label: 'Config History' },
];

export default function V2DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const fromTopology = (location.state as { from?: string } | null)?.from === 'topology';
  const { addToast } = useToast();
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [kpiData, setKpiData] = useState<KpiSeries[]>([]);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [tab, setTab] = useState('summary');
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Device>>({});
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchDevices()
      .then((devices) => {
        const d = devices.find((x) => x.id === id || x.deviceId === id);
        setDevice(d ?? null);
      })
      .catch((e) => logger.error('Device fetch failed', e))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!device || tab !== 'summary') return;
    setKpiLoading(true);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - timeRangeToMs('24h')).toISOString();
    fetchDeviceKpi(device.deviceId, [...KPI_PARAMS], timeRangeToGranularity('24h'), from, to)
      .then(setKpiData)
      .catch((e) => logger.warn('KPI fetch failed', { error: e }))
      .finally(() => setKpiLoading(false));
  }, [device, tab]);

  const openEdit = () => {
    setEditForm({
      ipAddress: device?.ipAddress ?? '',
      macAddress: device?.macAddress ?? '',
      model: device?.model ?? '',
      manufacturer: device?.manufacturer ?? '',
      networkId: device?.networkId ?? '',
      status: device?.status ?? 'ONLINE',
      firmwareVersion: device?.firmwareVersion ?? '',
      serialNumber: device?.serialNumber ?? '',
    });
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    if (!device) return;
    setEditSaving(true);
    try {
      const updated = await updateDevice(device.deviceId || device.id, editForm);
      setDevice((prev) => prev ? { ...prev, ...updated } : prev);
      addToast('Device updated', 'success');
      setEditOpen(false);
    } catch (e) {
      logger.error('Device update failed', e);
      addToast('Failed to update device', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  if (loading) return <LoadingState label="Loading device…" />;
  if (!device) return <div className="vf-page"><EmptyState title="Device not found" description={`No device with ID "${id}" exists.`} action={<Button onClick={() => navigate('/v2/devices')}>Back to Devices</Button>} /></div>;

  const statusVariant = device.status === 'ONLINE' ? 'success' : device.status === 'OFFLINE' ? 'danger' : 'warning';

  return (
    <div className="vf-page">
      {/* Header */}
      <div className="vf-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate(fromTopology ? '/v2/topology' : '/v2/devices')} style={{ background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
            ← {fromTopology ? 'Topology' : 'Devices'}
          </button>
          <h1 className="vf-page-title" style={{ margin: 0 }}>{device.serialNumber}</h1>
          <Badge variant={statusVariant} dot>{device.status}</Badge>
          <Badge variant="default">{device.deviceType}</Badge>
        </div>
        <div className="vf-page-actions">
          <Badge variant="default">{device.firmwareVersion}</Badge>
          <Button variant="ghost" size="sm" onClick={openEdit}>✏ Edit Device</Button>
        </div>
      </div>

      {/* Device info bar */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13, color: 'var(--vf-text-secondary)', padding: '8px 0' }}>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>IP:</strong> <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{device.ipAddress}</span></span>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>MAC:</strong> <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{device.macAddress}</span></span>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>Model:</strong> {device.manufacturer} {device.model}</span>
        {device.networkId && <span><strong style={{ color: 'var(--vf-text-muted)' }}>Network:</strong> {device.networkId}</span>}
        {device.tags?.length ? (
          <span style={{ display: 'flex', gap: 4 }}>
            {device.tags.map((t) => <Badge key={`${t.key}:${t.value}`} variant="default">{t.key}:{t.value}</Badge>)}
          </span>
        ) : null}
      </div>

      {/* Edit Device Modal */}
      {editOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 14, padding: 28, width: 520, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>Edit Device — {device.serialNumber}</h3>
              <button onClick={() => setEditOpen(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--vf-text-muted)' }}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {([
                { key: 'serialNumber',   label: 'Serial Number' },
                { key: 'ipAddress',      label: 'IP Address' },
                { key: 'macAddress',     label: 'MAC Address' },
                { key: 'manufacturer',   label: 'Manufacturer' },
                { key: 'model',          label: 'Model' },
                { key: 'networkId',      label: 'Network ID' },
                { key: 'firmwareVersion',label: 'Firmware Version' },
              ] as { key: keyof Device; label: string }[]).map(({ key, label }) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)' }}>{label}</label>
                  <input
                    value={String(editForm[key] ?? '')}
                    onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                    style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', fontSize: 13, outline: 'none' }}
                  />
                </div>
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)' }}>Status</label>
                <select
                  value={editForm.status ?? device.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value as Device['status'] }))}
                  style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
                  <option value="ONLINE">ONLINE</option>
                  <option value="OFFLINE">OFFLINE</option>
                  <option value="PROVISIONING">PROVISIONING</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleEditSave} loading={editSaving}>Save Changes</Button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs tabs={TABS} activeTab={tab} onChange={setTab}>
        <TabPanel id="summary">
          {kpiLoading ? (
            <div style={{ padding: 24 }}><Spinner /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 }}>
              <div className="vf-kpi-grid">
                {kpiData.map((series) => {
                  const last = series.data[series.data.length - 1];
                  return (
                    <MetricCard key={series.param} label={series.param} value={last ? last.avg.toFixed(1) : '—'} />
                  );
                })}
              </div>
              {kpiData.length > 0 && (
                <Card title="24h KPI Trends">
                  <div className="vf-grid vf-grid--2">
                    {kpiData.slice(0, 6).map((series) => (
                      <KpiMiniChart key={series.param} series={series} />
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
        </TabPanel>
        <TabPanel id="wireless">  <WirelessConfigTab deviceId={device.deviceId} /></TabPanel>
        <TabPanel id="network">   <NetworkConfigTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="ethernet">  <EthernetConfigTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="qos">       <QoSConfigTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="vlan">      <VlanConfigTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="gps">       <GpsTab device={device} /></TabPanel>
        <TabPanel id="birth">     <BirthCertTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="tags">      <TagsTab device={device} addToast={addToast} onDeviceUpdate={setDevice} /></TabPanel>
        <TabPanel id="logs">      <LogsTab device={device} addToast={addToast} /></TabPanel>
        <TabPanel id="history">   <ConfigHistoryTab device={device} /></TabPanel>
      </Tabs>
    </div>
  );
}

// ── Shared field helpers ──────────────────────────────────────────────────────
type AddToast = (msg: string, type: 'success' | 'error' | 'warning') => void;

function CfgRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}
function CfgInput({ value, onChange, placeholder, type = 'text', disabled }: { value: string | number; onChange: (v: string) => void; placeholder?: string; type?: string; disabled?: boolean }) {
  return (
    <input type={type} value={value} placeholder={placeholder} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' as const }} />
  );
}
function PushButton({ onClick, loading, label = 'Apply' }: { onClick: () => void; loading: boolean; label?: string }) {
  return <Button variant="primary" size="sm" onClick={onClick} loading={loading}>{label}</Button>;
}

// ── Network Config Tab ────────────────────────────────────────────────────────
function NetworkConfigTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [ipMode, setIpMode] = useState<string>('DHCP');
  const [ip, setIp]         = useState('');
  const [mask, setMask]     = useState('');
  const [gw, setGw]         = useState('');
  const [dns, setDns]       = useState('');
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(device.deviceId, { ipMode, staticIp: ip, staticSubnet: mask, staticGateway: gw, dnsServer: dns });
      addToast('Network config pushed', 'success');
    } catch (e) { logger.error('Network push failed', e); addToast('Failed to push network config', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          <CfgRow label="IP Mode">
            <select value={ipMode} onChange={(e) => setIpMode(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="DHCP">DHCP</option>
              <option value="Static">Static</option>
              <option value="SLAAC">SLAAC (IPv6)</option>
            </select>
          </CfgRow>
          {ipMode === 'Static' && (
            <>
              <CfgRow label="IP Address"><CfgInput value={ip} onChange={setIp} placeholder="192.168.1.100" /></CfgRow>
              <CfgRow label="Subnet Mask"><CfgInput value={mask} onChange={setMask} placeholder="255.255.255.0" /></CfgRow>
              <CfgRow label="Gateway"><CfgInput value={gw} onChange={setGw} placeholder="192.168.1.1" /></CfgRow>
            </>
          )}
          <CfgRow label="DNS Server"><CfgInput value={dns} onChange={setDns} placeholder="8.8.8.8" /></CfgRow>
        </div>
        <PushButton onClick={apply} loading={saving} />
      </div>
      <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 8, fontSize: 12, color: 'var(--vf-text-muted)' }}>
        <strong style={{ color: '#60a5fa' }}>Current:</strong> {device.ipAddress ?? '—'}
      </div>
    </div>
  );
}

// ── Ethernet Config Tab ───────────────────────────────────────────────────────
function EthernetConfigTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [speed, setSpeed]     = useState('auto');
  const [portUp, setPortUp]   = useState(true);
  const [port, setPort]       = useState('eth0');
  const [saving, setSaving]   = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(device.deviceId, { speedDuplex: speed, portUpDown: portUp ? 'up' : 'down', portId: port });
      addToast('Ethernet config pushed', 'success');
    } catch (e) { logger.error('Ethernet push failed', e); addToast('Failed to push ethernet config', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          <CfgRow label="Port">
            <select value={port} onChange={(e) => setPort(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="eth0">eth0 (WAN)</option>
              <option value="eth1">eth1 (LAN 1)</option>
              <option value="eth2">eth2 (LAN 2)</option>
              <option value="eth3">eth3 (LAN 3)</option>
            </select>
          </CfgRow>
          <CfgRow label="Speed / Duplex">
            <select value={speed} onChange={(e) => setSpeed(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="auto">Auto</option>
              <option value="100Mbps Full">100 Mbps Full Duplex</option>
              <option value="1000Mbps Full">1000 Mbps Full Duplex</option>
              <option value="100Mbps Half">100 Mbps Half Duplex</option>
            </select>
          </CfgRow>
          <CfgRow label="Port Admin State">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '7px 0' }}>
              <input type="checkbox" checked={portUp} onChange={(e) => setPortUp(e.target.checked)} />
              {portUp ? 'Up (enabled)' : 'Down (disabled)'}
            </label>
          </CfgRow>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <PushButton onClick={apply} loading={saving} />
          <Button variant="ghost" size="sm" onClick={async () => {
            try { await pushDeviceParam(device.deviceId, { wifiRestart: true }); addToast('WiFi restart triggered', 'success'); }
            catch { addToast('Failed to trigger WiFi restart', 'error'); }
          }}>WiFi Restart</Button>
          <Button variant="ghost" size="sm" onClick={async () => {
            if (!window.confirm('Reboot this device?')) return;
            try { await pushDeviceParam(device.deviceId, { deviceReboot: true }); addToast('Device reboot triggered', 'success'); }
            catch { addToast('Failed to trigger reboot', 'error'); }
          }}>Reboot Device</Button>
        </div>
      </div>
    </div>
  );
}

// ── QoS Config Tab ────────────────────────────────────────────────────────────
function QoSConfigTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [profile, setProfile]   = useState('default');
  const [ulLimit, setUlLimit]   = useState('');
  const [dlLimit, setDlLimit]   = useState('');
  const [saving, setSaving]     = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(device.deviceId, { qosProfile: profile, ulBandwidthLimit: ulLimit ? Number(ulLimit) : 0, dlBandwidthLimit: dlLimit ? Number(dlLimit) : 0 });
      addToast('QoS config pushed', 'success');
    } catch (e) { logger.error('QoS push failed', e); addToast('Failed to push QoS config', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ paddingTop: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          <CfgRow label="QoS Profile">
            <select value={profile} onChange={(e) => setProfile(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="default">Default (Best Effort)</option>
              <option value="voip">VoIP Priority</option>
              <option value="video">Video Streaming</option>
              <option value="bulk">Bulk Data</option>
            </select>
          </CfgRow>
          <CfgRow label="UL Bandwidth Limit (Mbps)"><CfgInput value={ulLimit} onChange={setUlLimit} type="number" placeholder="0 = unlimited" /></CfgRow>
          <CfgRow label="DL Bandwidth Limit (Mbps)"><CfgInput value={dlLimit} onChange={setDlLimit} type="number" placeholder="0 = unlimited" /></CfgRow>
        </div>
        <PushButton onClick={apply} loading={saving} />
      </div>
    </div>
  );
}

// ── VLAN Config Tab ───────────────────────────────────────────────────────────
function VlanConfigTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [vlanId, setVlanId]       = useState('');
  const [vlanMode, setVlanMode]   = useState<'single' | 'double'>('single');
  const [outerVlan, setOuterVlan] = useState('');
  const [priority, setPriority]   = useState('0');
  const [saving, setSaving]       = useState(false);

  const apply = async () => {
    if (vlanId && (Number(vlanId) < 1 || Number(vlanId) > 4094)) { addToast('VLAN ID must be 1–4094', 'error'); return; }
    setSaving(true);
    try {
      await pushDeviceParam(device.deviceId, { vlanId: Number(vlanId), vlanPriority: Number(priority), vlanMode, outerVlanId: vlanMode === 'double' ? Number(outerVlan) : 0 });
      addToast('VLAN config pushed', 'success');
    } catch (e) { logger.error('VLAN push failed', e); addToast('Failed to push VLAN config', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ paddingTop: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 16 }}>
          <CfgRow label="VLAN Mode">
            <select value={vlanMode} onChange={(e) => setVlanMode(e.target.value as 'single' | 'double')}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
              <option value="single">Single (802.1Q)</option>
              <option value="double">Double (QinQ)</option>
            </select>
          </CfgRow>
          <CfgRow label="VLAN ID (1–4094)"><CfgInput value={vlanId} onChange={setVlanId} type="number" placeholder="100" /></CfgRow>
          {vlanMode === 'double' && (
            <CfgRow label="Outer VLAN ID"><CfgInput value={outerVlan} onChange={setOuterVlan} type="number" placeholder="200" /></CfgRow>
          )}
          <CfgRow label="Priority (0–7)"><CfgInput value={priority} onChange={setPriority} type="number" placeholder="0" /></CfgRow>
        </div>
        <PushButton onClick={apply} loading={saving} />
      </div>
    </div>
  );
}

// ── GPS Tab ───────────────────────────────────────────────────────────────────
function GpsTab({ device }: { device: Device }) {
  if (!device.location) {
    return <div style={{ paddingTop: 24 }}><EmptyState title="No GPS data" description="This device has no GPS coordinates on record." /></div>;
  }
  const [lng, lat] = device.location.coordinates;
  const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <MetricCard label="Latitude"  value={lat.toFixed(6)} />
        <MetricCard label="Longitude" value={lng.toFixed(6)} />
        {(device as Record<string, unknown>).azimuth != null && <MetricCard label="Azimuth" value={`${(device as Record<string, unknown>).azimuth}°`} />}
        {(device as Record<string, unknown>).tilt != null    && <MetricCard label="Tilt"    value={`${(device as Record<string, unknown>).tilt}°`} />}
      </div>
      <a href={mapUrl} target="_blank" rel="noopener noreferrer"
        style={{ color: 'var(--vf-accent)', fontSize: 13, textDecoration: 'none' }}>
        View on OpenStreetMap ↗
      </a>
    </div>
  );
}

// ── Birth Certificate Tab (NMS-IV-05) ─────────────────────────────────────────
function BirthCertTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [cert, setCert]       = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const apiClient = { post: async (url: string, body: unknown) => { const r = await fetch(`/api/v1${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('nms_token') ?? ''}` }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(r.statusText); return r.json(); } };

  const capture = async () => {
    setLoading(true);
    try {
      const res = await apiClient.post('/nms/bts-capture-birth-certificate', { sno: device.serialNumber });
      setCert(res.birthCertificate ?? res);
      addToast('Birth certificate captured', 'success');
    } catch (e) { logger.error('Birth cert failed', e); addToast('Failed to capture birth certificate', 'error'); }
    finally { setLoading(false); }
  };

  const CERT_LABELS: Record<string, string> = {
    latitude: 'Latitude', longitude: 'Longitude', rssi: 'RSSI (dBm)', snr: 'SNR (dB)',
    noiseFloor: 'Noise Floor (dBm)', frequencyMHz: 'Frequency (MHz)', channel: 'Channel',
    channelBandwidthMHz: 'Channel BW (MHz)', azimuthDegrees: 'Azimuth (°)', tilt: 'Tilt (°)',
  };

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '12px 16px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--vf-text-muted)' }}>
        <strong style={{ color: '#60a5fa' }}>NMS-IV-05 / NMS-GIS:</strong> Captures a birth certificate snapshot (GPS, RSSI, SNR, frequency, azimuth) for this device.
        {device.deviceType === 'CPE' && <span> Birth certificate for CPEs is captured automatically on connect. Use the trigger below to re-capture.</span>}
      </div>

      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Device: {device.serialNumber} ({device.deviceType})</span>
          <Badge variant="default">{device.ipAddress}</Badge>
        </div>
        <Button variant="primary" onClick={capture} loading={loading}>Capture Birth Certificate</Button>
      </div>

      {cert && (
        <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 14 }}>Birth Certificate</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {Object.entries(cert).map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{CERT_LABELS[k] ?? k}</div>
                <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--vf-accent)' }}>{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tags Tab (NMS-IV-06) ──────────────────────────────────────────────────────
function TagsTab({ device, addToast, onDeviceUpdate }: { device: Device; addToast: AddToast; onDeviceUpdate: (d: Device) => void }) {
  const [tags, setTags]       = useState<Array<{ key: string; value: string }>>([...(device.tags ?? [])]);
  const [newKey, setNewKey]   = useState('');
  const [newVal, setNewVal]   = useState('');
  const [saving, setSaving]   = useState(false);

  const addTag = () => {
    if (!newKey.trim()) return;
    setTags((t) => [...t, { key: newKey.trim(), value: newVal.trim() }]);
    setNewKey(''); setNewVal('');
  };

  const removeTag = (i: number) => setTags((t) => t.filter((_, idx) => idx !== i));

  const saveTags = async () => {
    setSaving(true);
    try {
      const updated = await updateDevice(device.id, { tags });
      onDeviceUpdate(updated);
      addToast('Tags saved', 'success');
    } catch (e) { logger.error('Tag save failed', e); addToast('Failed to save tags', 'error'); }
    finally { setSaving(false); }
  };

  const PRESET_TAGS = [
    { key: 'circle', label: 'Circle (e.g. Haryana)' },
    { key: 'city', label: 'City' },
    { key: 'site', label: 'Site ID' },
    { key: 'cluster', label: 'Cluster' },
    { key: 'facility', label: 'Facility (e.g. Rooftop)' },
  ];

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '18px 20px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 12 }}>Current Tags</div>
        {tags.length === 0 && <p style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>No tags yet. Add metadata like circle, city, site ID below.</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {tags.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--vf-text-muted)' }}>{t.key}:</span>
              <span style={{ fontWeight: 600, color: 'var(--vf-text-primary)' }}>{t.value}</span>
              <button onClick={() => removeTag(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 14, padding: '0 0 0 4px' }}>×</button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {PRESET_TAGS.map(({ key, label }) => (
            <button key={key} onClick={() => setNewKey(key)}
              style={{ padding: '3px 10px', background: newKey === key ? 'rgba(59,130,246,0.12)' : 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)', borderRadius: 6, fontSize: 11, cursor: 'pointer', color: 'var(--vf-text-secondary)' }}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Tag Key</div>
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key" style={{ width: 160 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Value</div>
            <Input value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="value" style={{ width: 200 }} />
          </div>
          <Button variant="ghost" size="sm" onClick={addTag} disabled={!newKey.trim()}>Add</Button>
        </div>

        <div style={{ marginTop: 16 }}>
          <Button variant="primary" size="sm" onClick={saveTags} loading={saving}>Save Tags</Button>
        </div>
      </div>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────
function LogsTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const [logs, setLogs]     = useState<LogEntry[]>([]);
  const [level, setLevel]   = useState('');
  const [lines, setLines]   = useState(200);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const result = await extractDeviceLogs({ deviceId: device.deviceId, lines, level: level as LogEntry['level'] | undefined });
      setLogs(result);
      if (result.length) addToast(`${result.length} log entries retrieved`, 'success');
    } catch (e) { logger.error('Log extraction failed', e); addToast('Failed to extract logs', 'error'); }
    finally { setLoading(false); }
  }, [device.deviceId, level, lines, addToast]);

  const levelColor: Record<string, string> = { ERROR: '#f87171', WARN: '#fbbf24', INFO: '#60a5fa', DEBUG: 'var(--vf-text-muted)' };

  const download = () => {
    const text = logs.map((l) => `[${l.timestamp}] ${l.level} ${l.source ? `[${l.source}]` : ''} ${l.message}`).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${device.serialNumber}-logs.txt`; a.click();
  };

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Level</div>
          <select value={level} onChange={(e) => setLevel(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
            <option value="">All</option>
            {['DEBUG','INFO','WARN','ERROR'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Lines</div>
          <select value={lines} onChange={(e) => setLines(Number(e.target.value))}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: 'var(--vf-text-primary)', fontSize: 13 }}>
            {[100,200,500,1000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <Button variant="primary" size="sm" onClick={run} loading={loading}>Extract Logs</Button>
        {logs.length > 0 && <Button variant="ghost" size="sm" onClick={download}>⬇ Download</Button>}
      </div>

      {loading ? <LoadingState label="Extracting logs…" /> : logs.length === 0 ? (
        <EmptyState title="No logs" description="Click Extract Logs to retrieve device logs." icon={<span>📋</span>} />
      ) : (
        <div style={{ background: '#050d17', border: '1px solid rgba(77,158,255,0.1)', borderRadius: 10, padding: '12px 16px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, maxHeight: 460, overflowY: 'auto' }}>
          {logs.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
              <span style={{ color: 'var(--vf-text-dim)', fontSize: 11, flexShrink: 0 }}>{new Date(l.timestamp).toISOString().slice(0,19).replace('T',' ')}</span>
              <span style={{ color: levelColor[l.level] ?? 'var(--vf-text-muted)', fontWeight: 700, width: 46, flexShrink: 0 }}>{l.level}</span>
              {l.source && <span style={{ color: '#a78bfa', flexShrink: 0 }}>[{l.source}]</span>}
              <span style={{ color: '#e2e8f0' }}>{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Config History Tab ────────────────────────────────────────────────────────
function ConfigHistoryTab({ device }: { device: Device }) {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getVersionHistory>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!device.deviceId) { setLoading(false); return; }
    getVersionHistory(device.deviceId)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [device.deviceId]);

  if (loading) return <div style={{ paddingTop: 24 }}><LoadingState label="Loading config history…" /></div>;
  if (!history.length) return <div style={{ paddingTop: 24 }}><EmptyState title="No config history" description="No configuration changes have been recorded for this device." /></div>;

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {history.map((v, i) => (
        <div key={v.id ?? i} style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Badge variant="default">v{v.versionNumber}</Badge>
            <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>by {v.actor} · {new Date(v.appliedAt).toLocaleString()}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(v.newValues).map(([k, val]) => (
              <div key={k} style={{ fontSize: 11, background: 'var(--vf-elevated)', padding: '3px 8px', borderRadius: 4 }}>
                <span style={{ color: 'var(--vf-text-muted)' }}>{k}:</span> <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

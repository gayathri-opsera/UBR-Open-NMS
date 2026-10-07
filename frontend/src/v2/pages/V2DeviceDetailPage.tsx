import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { fetchDevices, updateDevice, deleteDevice } from '../../api/devices.api';
import { pushDeviceParam, getVersionHistory } from '../../api/config.api';
import { apiClient } from '../../api/client';
import { extractDeviceLogs } from '../../api/diagnostics.api';
import type { LogEntry } from '../../api/diagnostics.api';
import type { Device } from '../../api/devices.types';
import { Tabs, TabPanel } from '../components/common/Tabs';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Card } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { MetricCard } from '../components/common/MetricCard';
import { Spinner } from '../components/common/Spinner';
import { EmptyState, LoadingState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { logger } from '../utils/logger';
import { WirelessConfigTab } from '../components/device/WirelessConfigTab';
import { DeviceInterfacesTable } from '../components/DeviceInterfacesTable';
import { ParameterGroupTabs } from '../components/framework/parameters/ParameterGroupTabs';
import { getDeviceUiTemplate } from '../../api/framework-panels.api';
import { getDeviceCurrentParameterValues, flattenParameterValues, updateDeviceParameter } from '../../api/framework-parameters.api';
import type { AdaptiveUiTemplateData } from '../../api/framework-panels.types';
import { NodeViewParameters } from '../components/NodeViewParameters';
import type { ParameterCurrentValue, ParameterCurrentValueData } from '../../api/framework-parameters.types';
// ── New wireframe architecture ─────────────────────────────────────────────────
import { fetchNodeView } from '../../api/nodeView.api';
import type { NodeViewData } from '../../api/nodeView.types';

/** 358093 → "4d 3h 28m"; 0/undefined → "—" (uptime is only known once discovery has read it). */
function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h}h ${m}m`;
}

const TABS = [
  { id: 'summary',   label: 'Node View' },
  { id: 'framework', label: 'Parameters' },
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

/** Normalise tag objects from any backend format to { key, value } pairs. */
function normaliseTags(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    if (typeof t === 'string') {
      const [k, ...rest] = t.split(':');
      return { key: k ?? t, value: rest.join(':') };
    }
    if (t && typeof t === 'object') {
      const obj = t as Record<string, string>;
      if ('key' in obj) return { key: String(obj.key), value: String(obj.value ?? '') };
      const [k, v] = Object.entries(obj)[0] ?? ['tag', ''];
      return { key: k, value: String(v) };
    }
    return { key: String(t), value: '' };
  });
}

export default function V2DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const fromTopology = (location.state as { from?: string } | null)?.from === 'topology';
  const { addToast } = useToast();
  const { user } = useAuth();
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('summary');
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Device>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [confirmDeprovision, setConfirmDeprovision] = useState(false);
  const [deprovisioning, setDeprovisioning] = useState(false);

  // ── Node View tab state (new wireframe architecture) ─────────────────────
  const [nvData, setNvData]                 = useState<NodeViewData | null>(null);
  const [nvLoading, setNvLoading]           = useState(false);
  const [nvRefreshing, setNvRefreshing]     = useState(false);
  const [nvError, setNvError]               = useState<string | null>(null);

  // ── Framework (Parameters) tab state — legacy, kept for the Parameters tab ─
  const [fwTemplate, setFwTemplate]         = useState<AdaptiveUiTemplateData | null>(null);
  const [fwValues, setFwValues]             = useState<Map<string, ParameterCurrentValue>>(new Map());
  const [fwCurrent, setFwCurrent]           = useState<ParameterCurrentValueData | null>(null);
  const [fwRefreshing, setFwRefreshing]     = useState(false);
  const [fwLoading, setFwLoading]           = useState(false);
  const [fwError, setFwError]               = useState<string | null>(null);

  // Canonical device identifier for API calls.
  // Prefer serialNumber for KPI/availability calls (the KPI stub resolves serial in all
  // device stores).  Fall through to deviceId then the raw URL param when absent.
  // device.id (MongoDB _id) is intentionally last because ObjectId string matching
  // requires extra conversion in each downstream stub.
  const devId: string = device?.serialNumber || device?.deviceId || device?.id || id || '';

  useEffect(() => {
    if (!id) return;
    fetchDevices()
      .then((devices) => {
        // Match by any identifier so topology (which navigates with serial) links correctly
        const d = devices.find((x) => x.id === id || x.deviceId === id || x.serialNumber === id);
        setDevice(d ?? null);
      })
      .catch((e) => logger.error('Device fetch failed', e))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Node View loader — uses persisted wireframe architecture ─────────────
  const loadNodeView = useCallback(async (refresh = false, silent = false) => {
    if (!devId) return;
    if (refresh) setNvRefreshing(true);
    else if (!silent) setNvLoading(true);
    if (!silent) setNvError(null);
    try {
      const resp = await fetchNodeView(devId, { refresh });
      if (resp.status === 'ok' && resp.data) {
        setNvData(resp.data);
        setNvError(null);
      } else if (resp.status === 'NO_ACTIVE_FRAMEWORK') {
        setNvData(null);
        setNvError(null); // expected — no definition linked
      } else {
        setNvError(resp.error?.message ?? 'Failed to load Node View.');
        setNvData(null);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
      if (!silent) setNvError(`Failed to load Node View: ${msg}`);
    } finally {
      setNvLoading(false);
      setNvRefreshing(false);
    }
  }, [devId]);

  // ── Framework tab loader — still uses legacy ui-template approach ─────────
  const loadFramework = useCallback(async (refresh = false, silent = false) => {
    if (!devId) return;
    if (refresh) setFwRefreshing(true);
    else if (!silent) setFwLoading(true);
    if (!silent) setFwError(null);
    try {
      const [templateResp, valuesResp] = await Promise.all([
        getDeviceUiTemplate(devId),
        getDeviceCurrentParameterValues(devId, undefined, undefined, { refresh }),
      ]);
      if (templateResp.status === 'ok' && templateResp.data) {
        setFwTemplate(templateResp.data);
        setFwError(null);
      } else {
        setFwError(templateResp.error?.message ?? 'No active Product Definition framework for this device.');
        setFwTemplate(null);
      }
      const valueMap = new Map<string, ParameterCurrentValue>();
      if (valuesResp.status === 'ok' && valuesResp.data?.groups) {
        for (const group of valuesResp.data.groups) {
          for (const param of group.parameters) valueMap.set(param.parameterId, param);
        }
        setFwCurrent(valuesResp.data);
      } else {
        setFwCurrent(null);
      }
      setFwValues(valueMap);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
      if (!silent) setFwError(`Failed to load framework data: ${msg}`);
    } finally {
      setFwLoading(false);
      setFwRefreshing(false);
    }
  }, [devId]);

  // Load Node View when summary tab is shown
  useEffect(() => {
    if (tab !== 'summary') return;
    void loadNodeView();
  }, [loadNodeView, tab]);

  // Load framework data when Parameters tab is shown
  useEffect(() => {
    if (tab !== 'framework') return;
    void loadFramework();
  }, [loadFramework, tab]);

  // Auto-refresh every 30 s while the Node View tab is visible.
  useEffect(() => {
    if (tab !== 'summary' || !devId) return;
    const timer = setInterval(() => { void loadNodeView(false, true); }, 30000);
    return () => clearInterval(timer);
  }, [tab, devId, loadNodeView]);

  const handleFrameworkWrite = useCallback(async (parameterId: string, value: string) => {
    try {
      await updateDeviceParameter(devId, parameterId, value);
      addToast(`Parameter "${parameterId}" updated.`, 'success');
      // Re-fetch values after 2 s to reflect the write
      setTimeout(async () => {
        const resp = await getDeviceCurrentParameterValues(devId).catch(() => null);
        if (resp?.status === 'ok' && resp.data?.groups) {
          const map = new Map<string, ParameterCurrentValue>();
          for (const g of resp.data.groups) for (const p of g.parameters) map.set(p.parameterId, p);
          setFwValues(map);
        }
      }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`Write failed: ${msg}`, 'error');
      throw err;
    }
  }, [devId, addToast]);

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
      const updated = await updateDevice(devId, editForm);
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
          {/* Framework Parameters — always visible; page shows empty state when no PD is associated */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/v2/devices/${id}/framework-parameters`)}
            aria-label="View adaptive framework parameter panels"
          >
            🔌 Framework Parameters
          </Button>
          <Button variant="ghost" size="sm" onClick={openEdit}>✏ Edit Device</Button>
          {/* Deprovision — removes device from managed inventory */}
          {!confirmDeprovision ? (
            <button
              onClick={() => setConfirmDeprovision(true)}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                cursor: 'pointer', background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444',
              }}
            >
              🗑 Deprovision
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>Confirm?</span>
              <button
                onClick={() => setConfirmDeprovision(false)}
                style={{ padding: '4px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer', background: 'var(--vf-surface-raised)', border: '1px solid var(--vf-border-subtle)', color: 'var(--vf-text-muted)' }}
              >Cancel</button>
              <button
                disabled={deprovisioning}
                onClick={async () => {
                  setDeprovisioning(true);
                  try {
                    await deleteDevice(devId);
                    addToast(`🗑 ${device.serialNumber} removed from inventory`, 'success');
                    navigate(fromTopology ? '/v2/topology' : '/v2/devices');
                  } catch (e) {
                    logger.error('DeviceDetail: deprovision failed', e);
                    addToast('Failed to deprovision device. Please try again.', 'error');
                    setConfirmDeprovision(false);
                  } finally {
                    setDeprovisioning(false);
                  }
                }}
                style={{
                  padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700,
                  cursor: deprovisioning ? 'default' : 'pointer',
                  background: deprovisioning ? '#999' : '#ef4444',
                  border: 'none', color: '#fff',
                }}
              >
                {deprovisioning ? '⏳ Removing…' : 'Yes, Remove'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Device info bar */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13, color: 'var(--vf-text-secondary)', padding: '8px 0' }}>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>IP:</strong> <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{device.ipAddress}</span></span>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>MAC:</strong> <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{device.macAddress}</span></span>
        <span><strong style={{ color: 'var(--vf-text-muted)' }}>Model:</strong> {device.manufacturer} {device.model}</span>
        {device.networkId && <span><strong style={{ color: 'var(--vf-text-muted)' }}>Network:</strong> {device.networkId}</span>}
        {normaliseTags(device.tags).length > 0 ? (
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {normaliseTags(device.tags).map((t, i) => (
              <Badge key={`tag-${i}-${t.key}`} variant="default">{t.key}{t.value ? `:${t.value}` : ''}</Badge>
            ))}
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
          {/* ── NODE VIEW: built only from the product definition + live values ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 16 }}>
            {/* Device identity (real inventory fields only) */}
            <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)' }}>
                Device Identity
              </div>
              <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px 24px' }}>
                {[
                  { label: 'Device ID',     value: device.deviceId || device.id || '—' },
                  { label: 'Vendor',        value: device.manufacturer || '—' },
                  { label: 'Model',         value: device.model || '—' },
                  { label: 'Device Type',   value: device.deviceType || '—' },
                  { label: 'IP Address',    value: device.ipAddress || '—', mono: true },
                  { label: 'MAC Address',   value: device.macAddress || '—', mono: true },
                  { label: 'Mgmt Interface', value: device.managementInterface || '—' },
                  { label: 'Firmware',      value: device.firmwareVersion || '—', mono: true },
                  { label: 'Hardware',      value: device.hardwareVersion || '—', mono: true },
                  { label: 'Bootloader',    value: device.bootloaderVersion || '—', mono: true },
                  { label: 'Serial No.',    value: device.reportedSerialNumber || device.serialNumber || '—', mono: true },
                  { label: 'Network',       value: device.networkId || '—' },
                  { label: 'Uptime',        value: formatUptime(device.uptimeSeconds) },
                  { label: 'Contact',       value: device.sysContact || '—' },
                  { label: 'Last Seen',     value: device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—' },
                  { label: 'Registered',    value: device.registeredAt ? new Date(device.registeredAt).toLocaleString() : '—' },
                ].map(({ label, value, mono }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', wordBreak: 'break-all', fontFamily: mono ? 'var(--vf-font-mono)' : undefined }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <DeviceInterfacesTable interfaces={device.interfaces ?? []} collectedAt={device.factsCollectedAt} />

            {nvLoading && !nvData && !nvError && (
              <div style={{ padding: 24, textAlign: 'center' }}><Spinner /></div>
            )}

            {nvError && (
              <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '16px', fontSize: 13, color: 'var(--vf-warning)' }}>
                ⚠ {nvError}
              </div>
            )}

            {nvData && (
              <>
                {/* Banner when showing basic SNMP fallback (no product definition linked) */}
                {nvData.noFramework && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'rgba(79,142,247,0.07)', border: '1px solid rgba(79,142,247,0.2)',
                    borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 12,
                    color: 'var(--vf-text-secondary)',
                  }}>
                    <span style={{ fontSize: 16 }}>ℹ️</span>
                    <span>
                      No Product Definition linked — showing basic SNMP system info.{' '}
                      <button onClick={() => navigate('/v2/product-definitions')} style={{ background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}>
                        Upload &amp; activate a definition
                      </button>{' '}to see full device parameters.
                    </span>
                  </div>
                )}
                <NodeViewParameters
                  deviceId={devId}
                  canEdit={!!user && !['user', 'viewer'].includes(String(user.role).toLowerCase())}
                  deviceWritable={nvData.writable?.enabled === true}
                  wireframe={nvData.wireframe.groups}
                  values={nvData.values}
                  loading={nvLoading}
                  refreshing={nvRefreshing}
                  onRefresh={() => void loadNodeView(true)}
                  deviceStatus={device.status}
                  productDefinitionId={nvData.wireframe.productDefinitionId ?? ''}
                  registryVersion={nvData.wireframe.registryVersion}
                  collectedAt={nvData.collectedAt}
                  pollStatus={nvData.pollStatus}
                />
              </>
            )}

            {/* No product definition placeholder — only shown when SNMP fallback also failed */}
            {!nvLoading && !nvData && !nvError && (
              <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '20px 16px', fontSize: 13, color: 'var(--vf-text-muted)' }}>
                📋 No Product Definition linked to this device. Upload and activate a definition in
                <button onClick={() => navigate('/v2/product-definitions')} style={{ background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', fontSize: 13, marginLeft: 4 }}>
                  Admin → Framework Definitions
                </button>{' '}to see dynamic parameters here.
              </div>
            )}
          </div>
        </TabPanel>
        <TabPanel id="framework">
          {fwLoading ? (
            <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
          ) : fwError ? (
            <div style={{ padding: 24, background: 'var(--vf-surface)', borderRadius: 8, border: '1px solid var(--vf-border-subtle)', color: 'var(--vf-text-secondary)', fontSize: 13 }}>
              📋 {fwError}
            </div>
          ) : fwTemplate ? (
            <div style={{ paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                  {fwTemplate.deviceType}
                </span>
                <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontFamily: 'monospace' }}>
                  {fwTemplate.productDefinitionId}
                </span>
                <span style={{ fontSize: 11, color: 'var(--vf-text-tertiary)' }}>
                  reg v{fwTemplate.registryVersion}
                </span>
              </div>
              <ParameterGroupTabs
                groups={fwTemplate.groups}
                currentValues={fwValues}
                onWrite={handleFrameworkWrite}
              />
            </div>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>
              📋 No Product Definition framework associated with this device.
              Upload and activate a definition in Admin → Framework Definitions.
            </div>
          )}
        </TabPanel>
        <TabPanel id="wireless">  <WirelessConfigTab deviceId={devId} /></TabPanel>
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
  const devId = device.deviceId || device.serialNumber || device.id || '';
  const [ipMode, setIpMode] = useState<string>('DHCP');
  const [ip, setIp]         = useState('');
  const [mask, setMask]     = useState('');
  const [gw, setGw]         = useState('');
  const [dns, setDns]       = useState('');
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(devId, { ipMode, staticIp: ip, staticSubnet: mask, staticGateway: gw, dnsServer: dns });
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
  const devId = device.deviceId || device.serialNumber || device.id || '';
  const [speed, setSpeed]     = useState('auto');
  const [portUp, setPortUp]   = useState(true);
  const [port, setPort]       = useState('eth0');
  const [saving, setSaving]   = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(devId, { speedDuplex: speed, portUpDown: portUp ? 'up' : 'down', portId: port });
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
            try { await pushDeviceParam(devId, { wifiRestart: true }); addToast('WiFi restart triggered', 'success'); }
            catch { addToast('Failed to trigger WiFi restart', 'error'); }
          }}>WiFi Restart</Button>
          <Button variant="ghost" size="sm" onClick={async () => {
            if (!window.confirm('Reboot this device?')) return;
            try { await pushDeviceParam(devId, { deviceReboot: true }); addToast('Device reboot triggered', 'success'); }
            catch { addToast('Failed to trigger reboot', 'error'); }
          }}>Reboot Device</Button>
        </div>
      </div>
    </div>
  );
}

// ── QoS Config Tab ────────────────────────────────────────────────────────────
function QoSConfigTab({ device, addToast }: { device: Device; addToast: AddToast }) {
  const devId = device.deviceId || device.serialNumber || device.id || '';
  const [profile, setProfile]   = useState('default');
  const [ulLimit, setUlLimit]   = useState('');
  const [dlLimit, setDlLimit]   = useState('');
  const [saving, setSaving]     = useState(false);

  const apply = async () => {
    setSaving(true);
    try {
      await pushDeviceParam(devId, { qosProfile: profile, ulBandwidthLimit: ulLimit ? Number(ulLimit) : 0, dlBandwidthLimit: dlLimit ? Number(dlLimit) : 0 });
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
  const devId = device.deviceId || device.serialNumber || device.id || '';
  const [vlanId, setVlanId]       = useState('');
  const [vlanMode, setVlanMode]   = useState<'single' | 'double'>('single');
  const [outerVlan, setOuterVlan] = useState('');
  const [priority, setPriority]   = useState('0');
  const [saving, setSaving]       = useState(false);

  const apply = async () => {
    if (vlanId && (Number(vlanId) < 1 || Number(vlanId) > 4094)) { addToast('VLAN ID must be 1–4094', 'error'); return; }
    setSaving(true);
    try {
      await pushDeviceParam(devId, { vlanId: Number(vlanId), vlanPriority: Number(priority), vlanMode, outerVlanId: vlanMode === 'double' ? Number(outerVlan) : 0 });
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
  // Resolve coordinates from multiple possible sources
  const lat = device.latitude ?? device.location?.coordinates?.[1];
  const lng = device.longitude ?? device.location?.coordinates?.[0];

  if (lat == null || lng == null) {
    return <div style={{ paddingTop: 24 }}><EmptyState title="No GPS data" description="This device has no GPS coordinates on record." /></div>;
  }
  const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <MetricCard label="Latitude"  value={Number(lat).toFixed(6)} />
        <MetricCard label="Longitude" value={Number(lng).toFixed(6)} />
        {(device.birthCertificate?.azimuth) != null && <MetricCard label="Azimuth" value={`${device.birthCertificate?.azimuth}°`} />}
        {(device.birthCertificate?.tilt) != null    && <MetricCard label="Tilt"    value={`${device.birthCertificate?.tilt}°`} />}
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

  const capture = async () => {
    setLoading(true);
    try {
      // Use the shared apiClient so the Bearer token is attached automatically
      const res = await apiClient.post<{ birthCertificate?: Record<string, unknown> }>(
        '/nms/bts-capture-birth-certificate',
        { sno: device.serialNumber }
      );
      setCert(res.data.birthCertificate ?? (res.data as unknown as Record<string, unknown>));
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
            {Object.entries(cert).map(([k, v], ci) => (
              <div key={`cert-${ci}-${k}`}>
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
  const [tags, setTags]       = useState<Array<{ key: string; value: string }>>(() => normaliseTags(device.tags));
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
  const devId = device.deviceId || device.serialNumber || device.id || '';
  const [logs, setLogs]     = useState<LogEntry[]>([]);
  const [level, setLevel]   = useState('');
  const [lines, setLines]   = useState(200);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const result = await extractDeviceLogs({ deviceId: devId, lines, level: (level || undefined) as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | undefined });
      setLogs(result);
      if (result.length) addToast(`${result.length} log entries retrieved`, 'success');
    } catch (e) { logger.error('Log extraction failed', e); addToast('Failed to extract logs', 'error'); }
    finally { setLoading(false); }
  }, [devId, level, lines, addToast]);

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

/** Human-readable labels for common pushed parameter keys */
const PARAM_LABELS: Record<string, string> = {
  ipMode: 'IP Mode', staticIp: 'Static IP', staticSubnet: 'Subnet', staticGateway: 'Gateway',
  dnsServer: 'DNS Server', speedDuplex: 'Speed/Duplex', portUpDown: 'Port State', portId: 'Port',
  wifiRestart: 'WiFi Restart', deviceReboot: 'Device Reboot',
  qosProfile: 'QoS Profile', ulBandwidthLimit: 'UL Limit (Mbps)', dlBandwidthLimit: 'DL Limit (Mbps)',
  vlanId: 'VLAN ID', vlanPriority: 'Priority', vlanMode: 'VLAN Mode', outerVlanId: 'Outer VLAN',
  firmwareVersion: 'Firmware Version', firmwareUrl: 'Firmware URL',
  ssid: 'SSID', channel: 'Channel', txPower: 'TX Power (dBm)', encryption: 'Encryption',
  ddrsStatus: 'DDRS', spatialStream: 'Spatial Stream',
  templateId: 'Template',
  // Cisco / switch-specific params
  snmpCommunity: 'SNMP Community', snmpVersion: 'SNMP Version',
  ntpServer: 'NTP Server', timezone: 'Timezone', logLevel: 'Log Level',
  spanningTreeMode: 'Spanning Tree', spanningTreePriority: 'STP Priority',
  ethernetSpeed: 'Ethernet Speed', ethernetPort0: 'Port 0',
  diffSummary: 'Summary',
};

function ConfigHistoryTab({ device }: { device: Device }) {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getVersionHistory>>>([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const deviceId = device.deviceId || device.serialNumber || device.id;

  const load = useCallback(() => {
    if (!deviceId) { setLoading(false); return; }
    setLoading(true);
    getVersionHistory(deviceId)
      .then((h) => setHistory(Array.isArray(h) ? h : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [deviceId]);

  useEffect(() => { load(); }, [load]);

  const statusColor = (s?: string) =>
    s === 'PUSHED' || s === 'ACTIVE' ? 'var(--vf-success)' :
    s === 'FAILED' ? 'var(--vf-danger)' :
    'var(--vf-text-muted)';

  if (loading) return <div style={{ paddingTop: 24 }}><LoadingState label="Loading config history…" /></div>;

  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
          {history.length} push record{history.length !== 1 ? 's' : ''} for {deviceId}
        </span>
        <button onClick={load}
          style={{ background: 'none', border: '1px solid var(--vf-border-subtle)', borderRadius: 5, padding: '4px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--vf-text-secondary)' }}>
          ↻ Refresh
        </button>
      </div>

      {history.length === 0 ? (
        <div style={{ paddingTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32 }}>📋</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--vf-text-primary)' }}>No config history yet</div>
          <div style={{ fontSize: 13, color: 'var(--vf-text-muted)', textAlign: 'center', maxWidth: 460 }}>
            Every time you push a config from any of the tabs below, it will appear here in real time.
          </div>
          <div style={{ background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10, padding: '16px 24px', marginTop: 8, width: '100%', maxWidth: 480 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>To see history</div>
            {['1. Go to any config tab (Network, Wireless, QoS, VLAN, Ethernet)',
              '2. Change a value (e.g. set IP Mode → DHCP, add a DNS server)',
              '3. Click Apply — a toast will confirm success',
              '4. Return here and click ↻ Refresh'].map((step, si) => (
              <div key={si} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 13, color: 'var(--vf-text-secondary)' }}>
                <span style={{ color: 'var(--vf-accent)', fontWeight: 700, flexShrink: 0 }}>{si + 1}.</span>
                <span>{step.replace(/^\d+\. /, '')}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        history.map((v, i) => {
          const key = v.id ?? String(i);
          const isOpen = expanded === key;
          const params = Object.entries(v.newValues ?? {}).filter(([, val]) => val !== '' && val !== 'undefined');
          return (
            <div key={key} style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
              {/* Summary row */}
              <div
                onClick={() => setExpanded(isOpen ? null : key)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}>
                <span style={{ background: 'var(--vf-elevated)', borderRadius: 4, padding: '2px 8px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, fontWeight: 700 }}>
                  #{v.versionNumber ?? (history.length - i)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', flex: 1 }}>
                  {(v as { templateId?: string }).templateId === 'inline' || !(v as { templateId?: string }).templateId
                    ? `Manual push — ${params.length} param${params.length !== 1 ? 's' : ''}`
                    : `Template: ${(v as { templateId?: string }).templateId}`}
                </span>
                <span style={{ fontSize: 11, color: statusColor((v as { status?: string }).status), fontWeight: 700 }}>
                  {(v as { status?: string }).status ?? 'PUSHED'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', minWidth: 140, textAlign: 'right' }}>
                  {v.actor} · {new Date(v.appliedAt).toLocaleString()}
                </span>
                <span style={{ color: 'var(--vf-text-dim)', fontSize: 14 }}>{isOpen ? '▾' : '▸'}</span>
              </div>

              {/* Expanded parameters */}
              {isOpen && (
                <div style={{ borderTop: '1px solid var(--vf-border-subtle)', padding: '14px 16px', background: 'var(--vf-elevated)' }}>
                  {params.length === 0 ? (
                    <span style={{ color: 'var(--vf-text-dim)', fontSize: 12 }}>No parameter data recorded for this push.</span>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                      {params.map(([k, val], pi) => (
                        <div key={`param-${pi}-${k}`} style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 6, padding: '8px 12px' }}>
                          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 4 }}>
                            {PARAM_LABELS[k] ?? k}
                          </div>
                          <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--vf-accent)', wordBreak: 'break-all' }}>
                            {val === 'true' ? '✓ enabled' : val === 'false' ? '✗ disabled' : val}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

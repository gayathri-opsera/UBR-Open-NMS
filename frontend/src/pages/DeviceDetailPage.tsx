import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Device } from '../api/devices.types';
import type { Alarm } from '../api/alarms.types';
import type { KpiSeries, KpiThreshold, TimeRange } from '../api/kpi.types';
import type { LogEntry, SpeedTestResult, SpectrumResult } from '../api/diagnostics.api';
import { fetchDevice, updateDeviceTags } from '../api/devices.api';
import { fetchAlarms } from '../api/alarms.api';
import { fetchDeviceKpi, fetchThresholds } from '../api/kpi.api';
import { extractDeviceLogs, triggerSpeedTest, triggerSpectrumAnalysis } from '../api/diagnostics.api';
import { pushFirmware, pushDeviceParam } from '../api/config.api';
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../api/kpi.types';
import { apiClient } from '../api/client';
import { KpiLineChart } from '../components/kpi/KpiLineChart';

const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444', MAJOR: '#fb923c', MINOR: '#f59e0b', WARNING: '#60a5fa', CLEAR: '#22c55e',
};
const SEV_ICON: Record<string, string> = {
  CRITICAL: '⛔', MAJOR: '🔴', MINOR: '🟠', WARNING: '🟡', CLEAR: '🟢',
};
const STATUS_META: Record<string, { bg: string; color: string; icon: string }> = {
  ONLINE:       { bg: '#14532d', color: '#86efac', icon: '●' },
  OFFLINE:      { bg: '#7f1d1d', color: '#fca5a5', icon: '●' },
  PROVISIONING: { bg: '#1e3a5f', color: '#93c5fd', icon: '◌' },
  UNKNOWN:      { bg: '#374151', color: '#9ca3af', icon: '○' },
};
const DEVICE_ICON: Record<string, string> = { BTS: '🗼', CPE: '📡', IDU: '🔌' };

type DetailTab = 'overview' | 'kpi' | 'alarms' | 'diagnostics' | 'config';

export default function DeviceDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');

  // KPI
  const [kpiTime, setKpiTime] = useState<TimeRange>('24h');
  const [kpiSeries, setKpiSeries] = useState<KpiSeries[]>([]);
  const [thresholds, setThresholds] = useState<KpiThreshold[]>([]);
  const [kpiLoading, setKpiLoading] = useState(false);

  // Alarms
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [alarmRange, setAlarmRange] = useState<'24h' | '3d' | '7d'>('24h');
  const [alarmsLoading, setAlarmsLoading] = useState(false);

  // Diagnostics
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [speedResult, setSpeedResult] = useState<SpeedTestResult | null>(null);
  const [speedLoading, setSpeedLoading] = useState(false);
  const [spectrumResult, setSpectrumResult] = useState<SpectrumResult | null>(null);
  const [spectrumLoading, setSpectrumLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  // Tags
  const [tags, setTags] = useState<Array<{ key: string; value: string }>>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagSaving, setTagSaving] = useState(false);

  // Config state
  const [cfgMsg, setCfgMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [fwVersion, setFwVersion] = useState('');
  const [fwUrl, setFwUrl] = useState('');
  const [fwLoading, setFwLoading] = useState(false);
  const [ssid24, setSsid24] = useState(''); const [pwd24, setPwd24] = useState('');
  const [ssid5, setSsid5] = useState('');  const [pwd5, setPwd5] = useState('');
  const [channel, setChannel] = useState('');
  const [txPower, setTxPower] = useState('');
  const [mgmtIpType, setMgmtIpType] = useState<'DHCP' | 'STATIC' | 'SLAAC'>('DHCP');
  const [staticIp, setStaticIp] = useState('');
  const [staticGw, setStaticGw] = useState('');
  const [vlanId, setVlanId] = useState('');
  const [ethPort, setEthPort] = useState<'up' | 'down'>('up');
  const [cfgLoading, setCfgLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchDevice(id)
      .then((d) => { setDevice(d); setTags(d.tags ?? []); })
      .catch(() => setError('Device not found.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!device || tab !== 'kpi') return;
    const to = new Date().toISOString();
    const from = new Date(Date.now() - timeRangeToMs(kpiTime)).toISOString();
    setKpiLoading(true);
    Promise.all([
      fetchDeviceKpi(device.deviceId, [...KPI_PARAMS], timeRangeToGranularity(kpiTime), from, to),
      fetchThresholds(device.deviceId),
    ]).then(([s, t]) => { setKpiSeries(s); setThresholds(t); })
      .catch(() => {})
      .finally(() => setKpiLoading(false));
  }, [device, tab, kpiTime]);

  useEffect(() => {
    if (!device || tab !== 'alarms') return;
    const msMap = { '24h': 86_400_000, '3d': 259_200_000, '7d': 604_800_000 };
    const from = new Date(Date.now() - msMap[alarmRange]).toISOString();
    setAlarmsLoading(true);
    fetchAlarms({ from })
      .then((a) => setAlarms(a.filter((x) => x.deviceId === device.deviceId)))
      .catch(() => setAlarms([]))
      .finally(() => setAlarmsLoading(false));
  }, [device, tab, alarmRange]);

  const handleAddTag = async () => {
    if (!tagInput.trim() || !device) return;
    const [k, ...rest] = tagInput.trim().split(':');
    const newTag = rest.length ? { key: k, value: rest.join(':') } : { key: 'tag', value: k };
    const next = [...tags.filter((x) => !(x.key === newTag.key && x.value === newTag.value)), newTag];
    setTagSaving(true);
    await updateDeviceTags(device.id, next).catch(() => {});
    setTags(next); setTagInput(''); setTagSaving(false);
  };

  const handleRemoveTag = async (t: { key: string; value: string }) => {
    if (!device) return;
    const next = tags.filter((x) => !(x.key === t.key && x.value === t.value));
    await updateDeviceTags(device.id, next).catch(() => {});
    setTags(next);
  };

  const handleExtractLogs = async () => {
    if (!device) return;
    setLogsLoading(true); setDiagError(null);
    extractDeviceLogs({ deviceId: device.deviceId, lines: 200 })
      .then(setLogs)
      .catch(() => setDiagError('Log extraction failed. Device may be unreachable.'))
      .finally(() => setLogsLoading(false));
  };

  const handleSpeedTest = async () => {
    if (!device) return;
    setSpeedLoading(true); setDiagError(null);
    triggerSpeedTest(device.deviceId)
      .then(setSpeedResult)
      .catch(() => setDiagError('Speed test failed.'))
      .finally(() => setSpeedLoading(false));
  };

  const handleSpectrum = async () => {
    if (!device) return;
    setSpectrumLoading(true); setDiagError(null);
    triggerSpectrumAnalysis(device.deviceId)
      .then(setSpectrumResult)
      .catch(() => setDiagError('Spectrum analysis failed.'))
      .finally(() => setSpectrumLoading(false));
  };

  const handleReboot = () => {
    if (!device || !confirm(`Reboot ${device.serialNumber}?`)) return;
    apiClient.post(`/config/devices/${device.id}/reboot`)
      .then(() => setCfgMsg({ type: 'ok', text: 'Reboot command sent.' }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Reboot command failed.' }));
  };

  const handleWifiRestart = () => {
    if (!device || !confirm(`Restart WiFi on ${device.serialNumber}?`)) return;
    apiClient.post(`/config/devices/${device.id}/wifi-restart`)
      .then(() => setCfgMsg({ type: 'ok', text: 'WiFi restart command sent.' }))
      .catch(() => setCfgMsg({ type: 'err', text: 'WiFi restart command failed.' }));
  };

  const handleFirmwareUpgrade = async () => {
    if (!device || !fwVersion.trim()) { setCfgMsg({ type: 'err', text: 'Enter a firmware version.' }); return; }
    setFwLoading(true); setCfgMsg(null);
    pushFirmware(device.id, fwVersion, fwUrl || undefined)
      .then(() => setCfgMsg({ type: 'ok', text: `Firmware upgrade to ${fwVersion} queued.` }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Firmware upgrade failed. Check device status.' }))
      .finally(() => setFwLoading(false));
  };

  const handlePushWifi = async () => {
    if (!device) return;
    setCfgLoading(true); setCfgMsg(null);
    const params: Record<string, string> = {};
    if (ssid24) params.ssid24 = ssid24;
    if (pwd24)  params.wpaKey24 = pwd24;
    if (ssid5)  params.ssid5 = ssid5;
    if (pwd5)   params.wpaKey5 = pwd5;
    pushDeviceParam(device.id, params)
      .then(() => setCfgMsg({ type: 'ok', text: 'WiFi settings pushed.' }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Failed to push WiFi settings.' }))
      .finally(() => setCfgLoading(false));
  };

  const handlePushRadio = async () => {
    if (!device) return;
    setCfgLoading(true); setCfgMsg(null);
    const params: Record<string, string | number> = {};
    if (channel) params.channel5 = Number(channel);
    if (txPower) params.txPower5 = Number(txPower);
    pushDeviceParam(device.id, params)
      .then(() => setCfgMsg({ type: 'ok', text: 'Radio settings pushed.' }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Failed to push radio settings.' }))
      .finally(() => setCfgLoading(false));
  };

  const handlePushMgmtIp = async () => {
    if (!device) return;
    setCfgLoading(true); setCfgMsg(null);
    const params: Record<string, string> = { managementIpType: mgmtIpType };
    if (mgmtIpType === 'STATIC') { params.staticIp = staticIp; params.staticGateway = staticGw; }
    pushDeviceParam(device.id, params)
      .then(() => setCfgMsg({ type: 'ok', text: 'Management IP settings pushed.' }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Failed to push IP settings.' }))
      .finally(() => setCfgLoading(false));
  };

  const handlePushVlan = async () => {
    if (!device || !vlanId) { setCfgMsg({ type: 'err', text: 'Enter a VLAN ID.' }); return; }
    setCfgLoading(true); setCfgMsg(null);
    pushDeviceParam(device.id, { vlanId: Number(vlanId) })
      .then(() => setCfgMsg({ type: 'ok', text: `VLAN ${vlanId} configured.` }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Failed to push VLAN config.' }))
      .finally(() => setCfgLoading(false));
  };

  const handlePushEthernet = async () => {
    if (!device) return;
    setCfgLoading(true); setCfgMsg(null);
    pushDeviceParam(device.id, { portUpDown: ethPort === 'up' })
      .then(() => setCfgMsg({ type: 'ok', text: `Ethernet port set to ${ethPort}.` }))
      .catch(() => setCfgMsg({ type: 'err', text: 'Failed to push ethernet settings.' }))
      .finally(() => setCfgLoading(false));
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const tabBtn = (t: DetailTab): React.CSSProperties => ({
    background: tab === t ? 'var(--accent-bg)' : 'none',
    border: `1px solid ${tab === t ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
    padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
  });
  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 12,
  };
  const actionBtn = (color = 'var(--accent)'): React.CSSProperties => ({
    background: 'var(--accent-bg)', border: 'none', color, padding: '7px 14px', borderRadius: 4,
    cursor: 'pointer', fontSize: 12, fontWeight: 600,
  });

  if (loading) return <div style={{ color: 'var(--accent)', padding: 32 }}>Loading device…</div>;
  if (error || !device) return (
    <div style={{ color: '#ef4444', padding: 32 }}>
      {error ?? 'Device not found'}
      <button onClick={() => navigate('/devices')} style={{ marginLeft: 12, background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
        Back to Devices
      </button>
    </div>
  );

  const sm = STATUS_META[device.status] ?? STATUS_META.UNKNOWN;
  const bc = device.birthCertificate as Record<string, string | number | boolean> | undefined;
  const [lng, lat] = device.location?.coordinates ?? [null, null];

  return (
    <div style={{ maxWidth: 1100, color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <button onClick={() => navigate('/devices')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
              ← Devices
            </button>
            <span style={{ color: 'var(--text-dim)' }}>/</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{device.serialNumber}</span>
          </div>
          <h2 style={{ color: 'var(--text-primary)', margin: 0, fontSize: 20 }}>
            <span aria-hidden="true">{DEVICE_ICON[device.deviceType] ?? '📡'} </span>
            {device.deviceType} — {device.deviceId}
          </h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ background: sm.bg, color: sm.color, padding: '2px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
              {sm.icon} {device.status}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'monospace' }}>{device.ipAddress}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{device.manufacturer} {device.model}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>FW: {device.firmwareVersion}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleWifiRestart} style={{ ...actionBtn('#f59e0b') }}>↺ WiFi Restart</button>
          <button onClick={handleReboot} style={{ ...actionBtn('#ef4444') }}>⟳ Reboot</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['overview', 'kpi', 'alarms', 'diagnostics', 'config'] as DetailTab[]).map((t) => (
          <button key={t} style={tabBtn(t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FieldCard title="Identity">
            <Field label="Device ID" value={device.deviceId} mono />
            <Field label="Serial Number" value={device.serialNumber} mono />
            <Field label="MAC Address" value={device.macAddress} mono />
            <Field label="IP Address" value={device.ipAddress} mono />
            <Field label="Type" value={device.deviceType} />
            <Field label="Manufacturer" value={device.manufacturer} />
            <Field label="Model" value={device.model} />
            <Field label="Firmware" value={device.firmwareVersion} mono />
            <Field label="Status" value={device.status} />
          </FieldCard>

          <FieldCard title="Location & GPS">
            {lat !== null && lng !== null ? (
              <>
                <Field label="Latitude" value={String(lat)} mono />
                <Field label="Longitude" value={String(lng)} mono />
                <div style={{ marginTop: 6 }}>
                  <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--accent)', fontSize: 12 }}>
                    📍 View on Google Maps
                  </a>
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No GPS coordinates recorded</div>
            )}
            {bc?.azimuthDegrees !== undefined && <Field label="Azimuth" value={`${bc.azimuthDegrees}°`} />}
            {bc?.tilt !== undefined && <Field label="Tilt" value={`${bc.tilt}°`} />}
          </FieldCard>

          <FieldCard title="Birth Certificate (NMS-IV-05)" full>
            {bc && Object.keys(bc).length > 0 ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    Captured: {bc.capturedAt ? new Date(String(bc.capturedAt)).toLocaleString() : 'N/A'}
                  </span>
                  <button onClick={async () => {
                    try {
                      await apiClient.post(`/devices/${device.id}/capture-birth-certificate`);
                      window.location.reload();
                    } catch { alert('Re-capture triggered — data will refresh shortly.'); }
                  }} style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '3px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                    🔄 Re-capture
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 4 }}>
                  {Object.entries(bc).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--bg-card)' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{k}</span>
                      <span style={{ color: 'var(--text-primary)', fontSize: 12, fontFamily: 'monospace' }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                No birth certificate on file.
                <button onClick={() => apiClient.post(`/devices/${device.id}/capture-birth-certificate`)}
                  style={{ marginLeft: 12, background: 'none', border: '1px solid var(--border-strong)', color: 'var(--accent)', padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                  Capture Now
                </button>
              </div>
            )}
          </FieldCard>

          <FieldCard title="Tags (circle, city, name…)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {tags.length === 0 && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>No tags</span>}
              {tags.map((t) => (
                <span key={`${t.key}:${t.value}`} style={{ background: 'var(--accent-bg)', color: 'var(--accent)', padding: '2px 8px', borderRadius: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {t.key}:{t.value}
                  <button onClick={() => handleRemoveTag(t)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...inp, flex: 1 }} placeholder="circle:North, city:Delhi…"
                value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTag()} />
              <button onClick={handleAddTag} disabled={tagSaving}
                style={{ ...actionBtn(), opacity: tagSaving ? 0.6 : 1 }}>Add</button>
            </div>
          </FieldCard>

          {device.deviceType === 'BTS' && (
            <FieldCard title="BTS Specific Fields">
              {bc?.operatingChannel !== undefined && <Field label="Channel" value={String(bc.operatingChannel)} />}
              {bc?.channelBandwidthMHz !== undefined && <Field label="Channel BW" value={`${bc.channelBandwidthMHz} MHz`} />}
              {bc?.frequencyMHz !== undefined && <Field label="Frequency" value={`${bc.frequencyMHz} MHz`} />}
              {bc?.txPower !== undefined && <Field label="TX Power" value={`${bc.txPower} dBm`} />}
              <Field label="Network ID" value={device.networkId ?? '—'} />
            </FieldCard>
          )}

          {device.deviceType === 'CPE' && (
            <FieldCard title="CPE Specific Fields">
              {bc?.rssi !== undefined && <Field label="RSSI" value={`${bc.rssi} dBm`} />}
              {bc?.snr !== undefined && <Field label="SNR" value={`${bc.snr} dB`} />}
              {bc?.connectedBtsSerial !== undefined && <Field label="BTS Serial" value={String(bc.connectedBtsSerial)} mono />}
              <Field label="Network ID" value={device.networkId ?? '—'} />
            </FieldCard>
          )}

          <FieldCard title="System">
            <Field label="Registered" value={device.registeredAt ? new Date(device.registeredAt).toLocaleString() : '—'} />
            <Field label="Last Seen" value={device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—'} />
            {(device.pendingCommandCount ?? 0) > 0 && <Field label="Pending Commands" value={String(device.pendingCommandCount)} />}
          </FieldCard>
        </div>
      )}

      {/* ── KPI ── */}
      {tab === 'kpi' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['1h', '6h', '24h', '7d'] as TimeRange[]).map((t) => (
              <button key={t} onClick={() => setKpiTime(t)}
                style={{ background: kpiTime === t ? 'var(--accent-bg)' : 'none', border: `1px solid ${kpiTime === t ? 'var(--accent)' : 'var(--border-strong)'}`, color: kpiTime === t ? 'var(--accent)' : 'var(--text-muted)', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {t}
              </button>
            ))}
          </div>
          {kpiLoading && <div style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>Loading KPI data…</div>}
          {kpiSeries.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {kpiSeries.filter((s) => s.data.length > 0).map((s) => {
                const latest = s.data[s.data.length - 1];
                const thr = thresholds.find((t) => t.metric === s.param);
                const breached = thr && latest && latest.avg >= thr.raiseThreshold;
                return (
                  <div key={s.param} style={{ background: 'var(--bg-surface)', border: `1px solid ${breached ? '#ef4444' : 'var(--border-subtle)'}`, borderRadius: 8, padding: '10px 16px', minWidth: 110 }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.param}</div>
                    <div style={{ color: breached ? '#ef4444' : 'var(--text-primary)', fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{latest?.avg?.toFixed(1) ?? '—'}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
            {kpiSeries.filter((s) => s.data.length > 0).map((s) => (
              <KpiLineChart key={s.param} series={s} threshold={thresholds.find((t) => t.metric === s.param)} />
            ))}
            {kpiSeries.length === 0 && !kpiLoading && (
              <div style={{ color: 'var(--text-dim)', fontSize: 13, gridColumn: '1/-1', padding: 32, textAlign: 'center' }}>
                No KPI data available for this device in the selected time range.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ALARMS ── */}
      {tab === 'alarms' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['24h', '3d', '7d'] as const).map((r) => (
              <button key={r} onClick={() => setAlarmRange(r)}
                style={{ background: alarmRange === r ? 'var(--accent-bg)' : 'none', border: `1px solid ${alarmRange === r ? 'var(--accent)' : 'var(--border-strong)'}`, color: alarmRange === r ? 'var(--accent)' : 'var(--text-muted)', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {r}
              </button>
            ))}
            <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12, alignSelf: 'center' }}>{alarms.length} events</span>
          </div>
          {alarmsLoading && <div style={{ color: 'var(--accent)', fontSize: 13 }}>Loading alarms…</div>}
          <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Severity', 'Alarm', 'State', 'Time', 'Cleared At'].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {alarms.length === 0 && !alarmsLoading && (
                <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>✅ No alarms in last {alarmRange}</td></tr>
              )}
              {alarms.map((a) => (
                <tr key={a.id} style={{ background: 'var(--bg-surface)' }}>
                  <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                    <span style={{ color: SEV_COLOR[a.severity] ?? 'var(--text-muted)', fontSize: 12 }}>{SEV_ICON[a.severity]} {a.severity}</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-primary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{a.alarmName}</td>
                  <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                    <span style={{ color: a.state === 'ACTIVE' ? '#ef4444' : a.state === 'ACKNOWLEDGED' ? '#f59e0b' : '#22c55e', fontSize: 11 }}>{a.state}</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11, borderBottom: '1px solid var(--bg-base)' }}>{new Date(a.timestamp).toLocaleString()}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11, borderBottom: '1px solid var(--bg-base)' }}>{a.clearedAt ? new Date(a.clearedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── DIAGNOSTICS ── */}
      {tab === 'diagnostics' && (
        <div>
          {diagError && <div role="alert" style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 6, padding: '8px 14px', marginBottom: 14, color: '#fca5a5', fontSize: 13 }}>{diagError}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>
            <ActionCard title="Log Extraction" desc="Extract recent device logs (last 200 lines) for troubleshooting.">
              <button onClick={handleExtractLogs} disabled={logsLoading} style={actionBtn()}>
                {logsLoading ? 'Extracting…' : '📋 Extract Logs'}
              </button>
            </ActionCard>
            <ActionCard title="Link Speed Test" desc={device.deviceType !== 'CPE' ? 'Available for CPE devices only.' : 'Run an upload/download speed test on this CPE.'}>
              <button onClick={handleSpeedTest} disabled={speedLoading || device.deviceType !== 'CPE'}
                style={{ ...actionBtn('#22c55e'), opacity: device.deviceType !== 'CPE' ? 0.4 : 1 }}>
                {speedLoading ? 'Testing…' : '⚡ Run Speed Test'}
              </button>
              {speedResult && (
                <div style={{ marginTop: 10, background: 'var(--bg-card)', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ color: '#22c55e', fontWeight: 700, marginBottom: 4 }}>{speedResult.status}</div>
                  <div style={{ color: 'var(--text-muted)' }}>⬇ DL: <strong style={{ color: 'var(--text-primary)' }}>{speedResult.downloadMbps} Mbps</strong></div>
                  <div style={{ color: 'var(--text-muted)' }}>⬆ UL: <strong style={{ color: 'var(--text-primary)' }}>{speedResult.uploadMbps} Mbps</strong></div>
                  <div style={{ color: 'var(--text-muted)' }}>Latency: <strong style={{ color: 'var(--text-primary)' }}>{speedResult.latencyMs} ms</strong></div>
                </div>
              )}
            </ActionCard>
            <ActionCard title="Spectrum Analysis" desc="Capture a radio spectrum snapshot to identify interference.">
              <button onClick={handleSpectrum} disabled={spectrumLoading} style={actionBtn('#f59e0b')}>
                {spectrumLoading ? 'Scanning…' : '📡 Spectrum Scan'}
              </button>
              {spectrumResult && (
                <div style={{ marginTop: 10, background: 'var(--bg-card)', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ color: spectrumResult.status === 'SUCCESS' ? '#22c55e' : '#ef4444', fontWeight: 700, marginBottom: 4 }}>{spectrumResult.status}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{spectrumResult.buckets.length} frequency buckets</div>
                  {spectrumResult.buckets.slice(0, 5).map((b, i) => (
                    <div key={i} style={{ color: 'var(--text-dim)', fontSize: 10 }}>{b.frequencyMHz} MHz: {b.powerDbm} dBm</div>
                  ))}
                </div>
              )}
            </ActionCard>
          </div>
          {logs.length > 0 && (
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Device Logs</div>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 12, maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
                {logs.map((l, i) => (
                  <div key={i} style={{ color: l.level === 'ERROR' ? '#ef4444' : l.level === 'WARN' ? '#f59e0b' : 'var(--text-muted)', marginBottom: 2 }}>
                    <span style={{ color: 'var(--text-dim)' }}>{new Date(l.timestamp).toLocaleTimeString()}</span>
                    {' '}<span style={{ color: l.level === 'ERROR' ? '#ef4444' : 'var(--accent)' }}>[{l.level}]</span>
                    {' '}{l.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CONFIG (CF-01) ── */}
      {tab === 'config' && (
        <div>
          {cfgMsg && (
            <div role="alert" style={{ background: cfgMsg.type === 'ok' ? '#14532d' : '#7f1d1d', border: `1px solid ${cfgMsg.type === 'ok' ? '#22c55e' : '#ef4444'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 14, color: cfgMsg.type === 'ok' ? '#86efac' : '#fca5a5', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
              <span>{cfgMsg.type === 'ok' ? '✓' : '⚠'} {cfgMsg.text}</span>
              <button onClick={() => setCfgMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>

            {/* Firmware Upgrade */}
            <CfgCard title="Firmware Upgrade" icon="⬆" color="#f59e0b">
              <label style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3, display: 'block' }}>Target Version</label>
              <input style={{ ...inp, width: '100%', marginBottom: 8 }} placeholder="e.g. 3.5.2.1"
                value={fwVersion} onChange={(e) => setFwVersion(e.target.value)} />
              <label style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3, display: 'block' }}>Firmware URL (optional)</label>
              <input style={{ ...inp, width: '100%', marginBottom: 10 }} placeholder="https://..."
                value={fwUrl} onChange={(e) => setFwUrl(e.target.value)} />
              <button onClick={handleFirmwareUpgrade} disabled={fwLoading || !fwVersion}
                style={{ ...actionBtn('#f59e0b'), opacity: !fwVersion ? 0.5 : 1 }}>
                {fwLoading ? 'Queuing…' : '⬆ Upgrade Firmware'}
              </button>
              <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 6 }}>Current: {device.firmwareVersion}</div>
            </CfgCard>

            {/* WiFi Settings */}
            <CfgCard title="WiFi Settings (SSID & Password)" icon="📶" color="var(--accent)">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>2.4 GHz SSID</label>
                  <input style={inp} value={ssid24} onChange={(e) => setSsid24(e.target.value)} placeholder="SSID 2.4G" />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>2.4 GHz Password</label>
                  <input style={inp} type="password" value={pwd24} onChange={(e) => setPwd24(e.target.value)} placeholder="Password" />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>5 GHz SSID</label>
                  <input style={inp} value={ssid5} onChange={(e) => setSsid5(e.target.value)} placeholder="SSID 5G" />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>5 GHz Password</label>
                  <input style={inp} type="password" value={pwd5} onChange={(e) => setPwd5(e.target.value)} placeholder="Password" />
                </div>
              </div>
              <button onClick={handlePushWifi} disabled={cfgLoading} style={actionBtn()}>
                {cfgLoading ? 'Pushing…' : '📶 Push WiFi Config'}
              </button>
            </CfgCard>

            {/* Radio Settings */}
            <CfgCard title="Radio — Channel & TX Power" icon="📡" color="#22c55e">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>Operating Channel</label>
                  <select style={{ ...inp, width: '100%' }} value={channel} onChange={(e) => setChannel(e.target.value)}>
                    <option value="">Select channel</option>
                    {['36','40','44','48','52','56','60','64','100','104','108','112','116','120','124','128','132','136','140','144','149','153','157','161','165'].map((c) => (
                      <option key={c} value={c}>CH {c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>TX Power (dBm)</label>
                  <input style={inp} type="number" min="0" max="30" value={txPower} onChange={(e) => setTxPower(e.target.value)} placeholder="e.g. 20" />
                </div>
              </div>
              <button onClick={handlePushRadio} disabled={cfgLoading} style={actionBtn('#22c55e')}>
                {cfgLoading ? 'Pushing…' : '📡 Push Radio Config'}
              </button>
            </CfgCard>

            {/* Management IP */}
            <CfgCard title="Management IP Address" icon="🌐" color="#a78bfa">
              <div style={{ marginBottom: 8 }}>
                <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 4 }}>IP Type</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['DHCP', 'STATIC', 'SLAAC'] as const).map((t) => (
                    <button key={t} onClick={() => setMgmtIpType(t)}
                      style={{ background: mgmtIpType === t ? 'var(--accent-bg)' : 'none', border: `1px solid ${mgmtIpType === t ? 'var(--accent)' : 'var(--border-strong)'}`, color: mgmtIpType === t ? 'var(--accent)' : 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {mgmtIpType === 'STATIC' && (
                <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                  <div>
                    <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>Static IP</label>
                    <input style={inp} value={staticIp} onChange={(e) => setStaticIp(e.target.value)} placeholder="192.168.1.100" />
                  </div>
                  <div>
                    <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 2 }}>Gateway</label>
                    <input style={inp} value={staticGw} onChange={(e) => setStaticGw(e.target.value)} placeholder="192.168.1.1" />
                  </div>
                </div>
              )}
              <button onClick={handlePushMgmtIp} disabled={cfgLoading} style={actionBtn('#a78bfa')}>
                {cfgLoading ? 'Pushing…' : '🌐 Push IP Config'}
              </button>
            </CfgCard>

            {/* Ethernet Port Control */}
            <CfgCard title="Ethernet Port Control" icon="🔌" color="#22d3ee">
              <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 6 }}>Port State</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {(['up', 'down'] as const).map((s) => (
                  <button key={s} onClick={() => setEthPort(s)}
                    style={{ background: ethPort === s ? (s === 'up' ? '#14532d' : '#7f1d1d') : 'none', border: `1px solid ${ethPort === s ? (s === 'up' ? '#22c55e' : '#ef4444') : 'var(--border-strong)'}`, color: ethPort === s ? (s === 'up' ? '#86efac' : '#fca5a5') : 'var(--text-muted)', padding: '5px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 12, textTransform: 'capitalize' }}>
                    {s === 'up' ? '▲ Up' : '▼ Down'}
                  </button>
                ))}
              </div>
              <button onClick={handlePushEthernet} disabled={cfgLoading} style={actionBtn('#22d3ee')}>
                {cfgLoading ? 'Pushing…' : '🔌 Apply Port State'}
              </button>
            </CfgCard>

            {/* VLAN Configuration */}
            <CfgCard title="VLAN Configuration" icon="🏷" color="#fb923c">
              <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>VLAN ID (1–4094)</label>
              <input style={{ ...inp, width: '100%', marginBottom: 10 }} type="number" min="1" max="4094"
                value={vlanId} onChange={(e) => setVlanId(e.target.value)} placeholder="e.g. 100" />
              <button onClick={handlePushVlan} disabled={cfgLoading || !vlanId}
                style={{ ...actionBtn('#fb923c'), opacity: !vlanId ? 0.5 : 1 }}>
                {cfgLoading ? 'Pushing…' : '🏷 Apply VLAN'}
              </button>
            </CfgCard>

            {/* Quick Actions */}
            <CfgCard title="Quick Actions" icon="⚡" color="#ef4444">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={handleReboot} style={{ ...actionBtn('#ef4444'), textAlign: 'left' }}>⟳ Reboot Device</button>
                <button onClick={handleWifiRestart} style={{ ...actionBtn('#f59e0b'), textAlign: 'left' }}>↺ WiFi Restart</button>
                <button onClick={() => apiClient.post(`/devices/${device.id}/capture-birth-certificate`).then(() => setCfgMsg({ type: 'ok', text: 'Birth certificate captured.' })).catch(() => setCfgMsg({ type: 'err', text: 'Birth certificate capture failed.' }))}
                  style={{ ...actionBtn('#22c55e'), textAlign: 'left' }}>📋 Capture Birth Certificate</button>
              </div>
            </CfgCard>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function FieldCard({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, gridColumn: full ? 'span 2' : undefined }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--bg-base)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontSize: 12, fontFamily: mono ? 'monospace' : undefined, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ActionCard({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
      <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>{desc}</div>
      {children}
    </div>
  );
}

function CfgCard({ title, icon, color, children }: { title: string; icon: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      </div>
      {children}
    </div>
  );
}

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
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../api/kpi.types';
import { apiClient } from '../api/client';
import { KpiLineChart } from '../components/kpi/KpiLineChart';

const C = {
  bg: '#0a1628', card: '#0d1b2a', border: '#1e293b', hi: '#1e3a5f',
  text: '#e2e8f0', muted: '#94a3b8', dim: '#64748b', faint: '#475569',
  blue: '#60a5fa', green: '#22c55e', amber: '#f59e0b', red: '#ef4444', orange: '#fb923c',
};

const SEV_COLOR: Record<string, string> = {
  CRITICAL: C.red, MAJOR: C.orange, MINOR: C.amber, WARNING: C.blue, CLEAR: C.green,
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
    apiClient.post(`/config/devices/${device.id}/reboot`).catch(() => {});
  };

  const handleWifiRestart = () => {
    if (!device || !confirm(`Restart WiFi on ${device.serialNumber}?`)) return;
    apiClient.post(`/config/devices/${device.id}/wifi-restart`).catch(() => {});
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const tabBtn = (t: DetailTab): React.CSSProperties => ({
    background: tab === t ? C.hi : 'none', border: `1px solid ${tab === t ? C.blue : '#374151'}`,
    color: tab === t ? C.blue : C.dim, padding: '6px 14px', borderRadius: 4,
    cursor: 'pointer', fontSize: 13,
  });
  const inp: React.CSSProperties = {
    background: '#0f172a', border: `1px solid ${C.hi}`, borderRadius: 4,
    color: C.text, padding: '6px 10px', fontSize: 12,
  };
  const actionBtn = (color: string = C.blue): React.CSSProperties => ({
    background: C.hi, border: 'none', color, padding: '7px 14px', borderRadius: 4,
    cursor: 'pointer', fontSize: 12, fontWeight: 600,
  });

  if (loading) return <div style={{ color: C.blue, padding: 32 }}>Loading device…</div>;
  if (error || !device) return (
    <div style={{ color: C.red, padding: 32 }}>
      {error ?? 'Device not found'}
      <button onClick={() => navigate('/devices')} style={{ marginLeft: 12, background: 'none', border: `1px solid #374151`, color: C.muted, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
        Back to Devices
      </button>
    </div>
  );

  const sm = STATUS_META[device.status] ?? STATUS_META.UNKNOWN;
  const bc = device.birthCertificate as Record<string, string | number | boolean> | undefined;
  const [lng, lat] = device.location?.coordinates ?? [null, null];

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <button onClick={() => navigate('/devices')} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 12 }}>
              ← Devices
            </button>
            <span style={{ color: C.faint }}>/</span>
            <span style={{ color: C.muted, fontSize: 12 }}>{device.serialNumber}</span>
          </div>
          <h2 style={{ color: C.text, margin: 0, fontSize: 20 }}>
            <span aria-hidden="true">{DEVICE_ICON[device.deviceType] ?? '📡'} </span>
            {device.deviceType} — {device.deviceId}
          </h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ background: sm.bg, color: sm.color, padding: '2px 10px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
              {sm.icon} {device.status}
            </span>
            <span style={{ color: C.dim, fontSize: 12, fontFamily: 'monospace' }}>{device.ipAddress}</span>
            <span style={{ color: C.faint, fontSize: 12 }}>{device.manufacturer} {device.model}</span>
            <span style={{ color: C.faint, fontSize: 11 }}>FW: {device.firmwareVersion}</span>
            {device.lastSeenAt && (
              <span style={{ color: C.faint, fontSize: 11 }}>Last seen: {new Date(device.lastSeenAt).toLocaleString()}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleWifiRestart} style={{ ...actionBtn(C.amber) }}>↺ WiFi Restart</button>
          <button onClick={handleReboot} style={{ ...actionBtn(C.red) }}>⟳ Reboot</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['overview', 'kpi', 'alarms', 'diagnostics', 'config'] as DetailTab[]).map((t) => (
          <button key={t} style={tabBtn(t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ─────────────── OVERVIEW ─────────────── */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

          {/* Identity */}
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

          {/* Location */}
          <FieldCard title="Location & GPS">
            {lat !== null && lng !== null ? (
              <>
                <Field label="Latitude" value={String(lat)} mono />
                <Field label="Longitude" value={String(lng)} mono />
                <div style={{ marginTop: 6 }}>
                  <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer"
                    style={{ color: C.blue, fontSize: 12 }}>
                    📍 View on Google Maps
                  </a>
                </div>
              </>
            ) : (
              <div style={{ color: C.faint, fontSize: 12 }}>No GPS coordinates recorded</div>
            )}
            {bc?.azimuthDegrees !== undefined && <Field label="Azimuth" value={`${bc.azimuthDegrees}°`} />}
            {bc?.tilt !== undefined && <Field label="Tilt" value={`${bc.tilt}°`} />}
          </FieldCard>

          {/* Birth Certificate (NMS-IV-05) */}
          <FieldCard title="Birth Certificate" full>
            {bc && Object.keys(bc).length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 4 }}>
                {Object.entries(bc).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ color: C.dim, fontSize: 11 }}>{k}</span>
                    <span style={{ color: C.text, fontSize: 12, fontFamily: 'monospace' }}>{String(v)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: C.faint, fontSize: 12 }}>
                No birth certificate on file.
                <button onClick={() => apiClient.post(`/devices/${device.id}/capture-birth-certificate`)}
                  style={{ marginLeft: 12, background: 'none', border: `1px solid #374151`, color: C.blue, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                  Capture Now
                </button>
              </div>
            )}
          </FieldCard>

          {/* Tags (NMS-IV-06) */}
          <FieldCard title="Tags (circle, city, name…)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {tags.length === 0 && <span style={{ color: C.faint, fontSize: 12 }}>No tags</span>}
              {tags.map((t) => (
                <span key={`${t.key}:${t.value}`} style={{ background: C.hi, color: C.blue, padding: '2px 8px', borderRadius: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {t.key}:{t.value}
                  <button onClick={() => handleRemoveTag(t)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 11 }}>×</button>
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

          {/* BTS-specific */}
          {device.deviceType === 'BTS' && (
            <FieldCard title="BTS Specific Fields">
              {bc?.operatingChannel !== undefined && <Field label="Channel" value={String(bc.operatingChannel)} />}
              {bc?.channelBandwidthMHz !== undefined && <Field label="Channel BW" value={`${bc.channelBandwidthMHz} MHz`} />}
              {bc?.frequencyMHz !== undefined && <Field label="Frequency" value={`${bc.frequencyMHz} MHz`} />}
              {bc?.txPower !== undefined && <Field label="TX Power" value={`${bc.txPower} dBm`} />}
              <Field label="Network ID" value={device.networkId ?? '—'} />
              <Field label="Org ID" value={device.organizationId ?? '—'} />
            </FieldCard>
          )}

          {/* CPE-specific */}
          {device.deviceType === 'CPE' && (
            <FieldCard title="CPE Specific Fields">
              {bc?.rssi !== undefined && <Field label="RSSI" value={`${bc.rssi} dBm`} />}
              {bc?.snr !== undefined && <Field label="SNR" value={`${bc.snr} dB`} />}
              {bc?.operatingChannel !== undefined && <Field label="Channel" value={String(bc.operatingChannel)} />}
              {bc?.channelBandwidthMHz !== undefined && <Field label="Channel BW" value={`${bc.channelBandwidthMHz} MHz`} />}
              {bc?.connectedBtsSerial !== undefined && <Field label="BTS Serial" value={String(bc.connectedBtsSerial)} mono />}
              <Field label="Network ID" value={device.networkId ?? '—'} />
            </FieldCard>
          )}

          {/* System */}
          <FieldCard title="System">
            <Field label="Registered" value={device.registeredAt ? new Date(device.registeredAt).toLocaleString() : '—'} />
            <Field label="Last Seen" value={device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—'} />
            <Field label="Hierarchy" value={device.hierarchyId ?? '—'} />
            {(device.pendingCommandCount ?? 0) > 0 && (
              <Field label="Pending Cmds" value={String(device.pendingCommandCount)} />
            )}
          </FieldCard>
        </div>
      )}

      {/* ─────────────── KPI ─────────────── */}
      {tab === 'kpi' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['1h', '6h', '24h', '7d'] as TimeRange[]).map((t) => (
              <button key={t} onClick={() => setKpiTime(t)}
                style={{ background: kpiTime === t ? C.hi : 'none', border: `1px solid ${kpiTime === t ? C.blue : '#374151'}`, color: kpiTime === t ? C.blue : C.dim, padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {t}
              </button>
            ))}
          </div>

          {kpiLoading && <div style={{ color: C.blue, fontSize: 13, marginBottom: 12 }}>Loading KPI data…</div>}

          {/* Current values row */}
          {kpiSeries.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {kpiSeries.filter((s) => s.data.length > 0).map((s) => {
                const latest = s.data[s.data.length - 1];
                const thr = thresholds.find((t) => t.metric === s.param);
                const breached = thr && latest && latest.avg >= thr.raiseThreshold;
                return (
                  <div key={s.param} style={{ background: C.card, border: `1px solid ${breached ? C.red : C.border}`, borderRadius: 8, padding: '10px 16px', minWidth: 110 }}>
                    <div style={{ color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.param}</div>
                    <div style={{ color: breached ? C.red : C.text, fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{latest?.avg?.toFixed(1) ?? '—'}</div>
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
              <div style={{ color: C.faint, fontSize: 13, gridColumn: '1/-1', padding: 32, textAlign: 'center' }}>
                No KPI data available for this device in the selected time range.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─────────────── ALARMS ─────────────── */}
      {tab === 'alarms' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['24h', '3d', '7d'] as const).map((r) => (
              <button key={r} onClick={() => setAlarmRange(r)}
                style={{ background: alarmRange === r ? C.hi : 'none', border: `1px solid ${alarmRange === r ? C.blue : '#374151'}`, color: alarmRange === r ? C.blue : C.dim, padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {r}
              </button>
            ))}
            <span style={{ marginLeft: 8, color: C.dim, fontSize: 12, alignSelf: 'center' }}>{alarms.length} events</span>
          </div>
          {alarmsLoading && <div style={{ color: C.blue, fontSize: 13 }}>Loading alarms…</div>}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Severity', 'Alarm', 'State', 'Time', 'Cleared At'].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', background: '#0f172a', color: C.dim, fontSize: 11, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {alarms.length === 0 && !alarmsLoading && (
                <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: C.faint, fontSize: 13 }}>
                  ✅ No alarms in last {alarmRange}
                </td></tr>
              )}
              {alarms.map((a) => (
                <tr key={a.id} style={{ background: C.card }}>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.bg}` }}>
                    <span style={{ color: SEV_COLOR[a.severity] ?? C.muted, fontSize: 12 }}>
                      {SEV_ICON[a.severity]} {a.severity}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', color: C.text, fontSize: 12, borderBottom: `1px solid ${C.bg}` }}>{a.alarmName}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.bg}` }}>
                    <span style={{ color: a.state === 'ACTIVE' ? C.red : a.state === 'ACKNOWLEDGED' ? C.amber : C.green, fontSize: 11 }}>{a.state}</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: C.dim, fontSize: 11, borderBottom: `1px solid ${C.bg}` }}>{new Date(a.timestamp).toLocaleString()}</td>
                  <td style={{ padding: '8px 12px', color: C.faint, fontSize: 11, borderBottom: `1px solid ${C.bg}` }}>{a.clearedAt ? new Date(a.clearedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─────────────── DIAGNOSTICS ─────────────── */}
      {tab === 'diagnostics' && (
        <div>
          {diagError && <div role="alert" style={{ background: '#7f1d1d', border: `1px solid ${C.red}`, borderRadius: 6, padding: '8px 14px', marginBottom: 14, color: '#fca5a5', fontSize: 13 }}>{diagError}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>

            {/* Log extraction */}
            <ActionCard title="Log Extraction" desc="Extract recent device logs (last 200 lines) for troubleshooting.">
              <button onClick={handleExtractLogs} disabled={logsLoading} style={actionBtn()}>
                {logsLoading ? 'Extracting…' : '📋 Extract Logs'}
              </button>
            </ActionCard>

            {/* Speed test — CPE only */}
            <ActionCard title="Link Speed Test" desc={device.deviceType !== 'CPE' ? 'Speed test is available for CPE devices only.' : 'Run an upload/download speed test on this CPE.'}>
              <button onClick={handleSpeedTest} disabled={speedLoading || device.deviceType !== 'CPE'}
                style={{ ...actionBtn(C.green), opacity: device.deviceType !== 'CPE' ? 0.4 : 1 }}>
                {speedLoading ? 'Testing…' : '⚡ Run Speed Test'}
              </button>
              {speedResult && (
                <div style={{ marginTop: 10, background: '#0f172a', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ color: C.green, fontWeight: 700, marginBottom: 4 }}>{speedResult.status}</div>
                  <div style={{ color: C.muted }}>⬇ DL: <strong style={{ color: C.text }}>{speedResult.downloadMbps} Mbps</strong></div>
                  <div style={{ color: C.muted }}>⬆ UL: <strong style={{ color: C.text }}>{speedResult.uploadMbps} Mbps</strong></div>
                  <div style={{ color: C.muted }}>Latency: <strong style={{ color: C.text }}>{speedResult.latencyMs} ms</strong></div>
                  <div style={{ color: C.muted }}>Packet Loss: <strong style={{ color: speedResult.packetLossPct > 1 ? C.red : C.text }}>{speedResult.packetLossPct}%</strong></div>
                  <div style={{ color: C.faint, fontSize: 10, marginTop: 4 }}>{new Date(speedResult.testedAt).toLocaleString()}</div>
                </div>
              )}
            </ActionCard>

            {/* Spectrum analysis */}
            <ActionCard title="Spectrum Analysis" desc="Capture a radio spectrum snapshot to identify interference.">
              <button onClick={handleSpectrum} disabled={spectrumLoading} style={actionBtn(C.amber)}>
                {spectrumLoading ? 'Scanning…' : '📡 Spectrum Scan'}
              </button>
              {spectrumResult && (
                <div style={{ marginTop: 10, background: '#0f172a', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ color: spectrumResult.status === 'SUCCESS' ? C.green : C.red, fontWeight: 700, marginBottom: 4 }}>{spectrumResult.status}</div>
                  <div style={{ color: C.muted, fontSize: 11 }}>{spectrumResult.buckets.length} frequency buckets captured</div>
                  {spectrumResult.buckets.slice(0, 5).map((b, i) => (
                    <div key={i} style={{ color: C.dim, fontSize: 10 }}>{b.frequencyMHz} MHz: {b.powerDbm} dBm</div>
                  ))}
                  {spectrumResult.buckets.length > 5 && <div style={{ color: C.faint, fontSize: 10 }}>…and {spectrumResult.buckets.length - 5} more</div>}
                  <div style={{ color: C.faint, fontSize: 10, marginTop: 4 }}>{new Date(spectrumResult.capturedAt).toLocaleString()}</div>
                </div>
              )}
            </ActionCard>
          </div>

          {/* Log viewer */}
          {logs.length > 0 && (
            <div>
              <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Device Logs</div>
              <div style={{ background: '#050d1a', border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
                {logs.map((l, i) => (
                  <div key={i} style={{ color: l.level === 'ERROR' ? C.red : l.level === 'WARN' ? C.amber : C.dim, marginBottom: 2 }}>
                    <span style={{ color: C.faint }}>{new Date(l.timestamp).toLocaleTimeString()}</span>
                    {' '}
                    <span style={{ color: l.level === 'ERROR' ? C.red : l.level === 'WARN' ? C.amber : C.blue }}>[{l.level}]</span>
                    {' '}
                    {l.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─────────────── CONFIG ─────────────── */}
      {tab === 'config' && (
        <div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 14 }}>
            Push configuration changes to this device or apply a template.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            <ConfigAction label="Firmware Upgrade" icon="⬆" desc="Push a firmware update to this device." color={C.amber} />
            <ConfigAction label="Reboot Device" icon="⟳" desc="Trigger a remote reboot." color={C.red} onClick={handleReboot} />
            <ConfigAction label="WiFi Restart" icon="↺" desc="Restart the wireless radio." color={C.blue} onClick={handleWifiRestart} />
            <ConfigAction label="Apply Template" icon="📋" desc="Apply a saved config template to this device." color={C.green} />
            <ConfigAction label="Ethernet Port Control" icon="🔌" desc="Enable or disable Ethernet ports." color={C.muted} />
            <ConfigAction label="VLAN Configuration" icon="🌐" desc="Configure VLAN (single/double tagging)." color={C.muted} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function FieldCard({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, gridColumn: full ? 'span 2' : undefined }}>
      <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #0f172a' }}>
      <span style={{ color: '#64748b', fontSize: 11 }}>{label}</span>
      <span style={{ color: '#cbd5e1', fontSize: 12, fontFamily: mono ? 'monospace' : undefined, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ActionCard({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16 }}>
      <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>{desc}</div>
      {children}
    </div>
  );
}

function ConfigAction({ label, icon, desc, color, onClick }: { label: string; icon: string; desc: string; color: string; onClick?: () => void }) {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 10 }}>{desc}</div>
      <button onClick={onClick ?? (() => {})} style={{ background: '#1e3a5f', border: 'none', color, padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
        {icon} {label}
      </button>
    </div>
  );
}

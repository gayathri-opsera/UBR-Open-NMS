import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, CartesianGrid, Legend,
} from 'recharts';
import { Link, useNavigate } from 'react-router-dom';
import type { Alarm } from '../api/alarms.types';
import type { Device } from '../api/devices.types';
import { fetchAlarms } from '../api/alarms.api';
import { fetchDevices } from '../api/devices.api';

type DashboardMode = 'ALL' | 'BTS' | 'CPE' | 'IDU';
type WidgetId = 'stat-summary' | 'online-pie' | 'alarm-bar' | 'firmware-pie'
  | 'alarm-severity-pie' | 'device-type-bar' | 'recent-alarms' | 'offline-devices'
  | 'throughput' | 'link-health';

const WIDGET_LABELS: Record<WidgetId, string> = {
  'stat-summary': 'Summary Stats',
  'online-pie': 'Online vs Offline (Pie)',
  'alarm-bar': 'Top 10 Alarms (Bar)',
  'firmware-pie': 'Firmware Distribution (Pie)',
  'alarm-severity-pie': 'Alarm by Severity (Pie)',
  'device-type-bar': 'Device Type Split (Bar)',
  'recent-alarms': 'Recent Active Alarms',
  'offline-devices': 'Offline Devices',
  'throughput': 'Network Throughput',
  'link-health': 'Link Health Summary',
};

const DEFAULT_WIDGETS: WidgetId[] = [
  'stat-summary', 'online-pie', 'alarm-bar', 'firmware-pie',
  'alarm-severity-pie', 'device-type-bar', 'recent-alarms', 'offline-devices',
];

const CHART_COLORS = ['#60a5fa', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6', '#34d399', '#fbbf24'];
const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444', MAJOR: '#fb923c', MINOR: '#f59e0b', WARNING: '#60a5fa', CLEAR: '#22c55e', INDETERMINATE: '#94a3b8',
};

export default function DashboardPage(): React.ReactElement {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_lastRefresh, setLastRefresh] = useState(new Date());
  const [mode, setMode] = useState<DashboardMode>('ALL');
  const [filterCircle, setFilterCircle] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterFirmware, setFilterFirmware] = useState('');
  const [showWidgetPicker, setShowWidgetPicker] = useState(false);
  const [visibleWidgets, setVisibleWidgets] = useState<Set<WidgetId>>(new Set(DEFAULT_WIDGETS));

  const load = () => {
    setLoading(true); setError(null);
    Promise.all([
      fetchDevices({}).catch(() => [] as Device[]),
      fetchAlarms({}).catch(() => [] as Alarm[]),
    ]).then(([d, a]) => { setDevices(d); setAlarms(a); setLastRefresh(new Date()); })
      .catch(() => setError('Unable to load dashboard data.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const circles = useMemo(() => [...new Set(devices.flatMap((d) => (d.tags ?? []).filter((t) => t.key === 'circle').map((t) => t.value)))], [devices]);
  const ALLOWED_MODELS = ['A60', 'A61', 'IDU'];
  const models = ALLOWED_MODELS;
  const firmwares = useMemo(() => [...new Set(devices.map((d) => d.firmwareVersion).filter(Boolean))], [devices]);

  const filtered = useMemo(() => devices.filter((d) => {
    if (mode !== 'ALL' && d.deviceType !== mode) return false;    if (filterCircle && !d.tags?.some((t) => t.key === 'circle' && t.value === filterCircle)) return false;
    if (filterModel && d.model !== filterModel) return false;
    if (filterFirmware && d.firmwareVersion !== filterFirmware) return false;
    return true;
  }), [devices, mode, filterCircle, filterModel, filterFirmware]);

  const activeAlarms = useMemo(() => alarms.filter((a) => a.state === 'ACTIVE'), [alarms]);

  const onlinePieData = useMemo(() => [
    { name: 'Online', value: filtered.filter((d) => d.status === 'ONLINE').length, color: '#22c55e' },
    { name: 'Offline', value: filtered.filter((d) => d.status === 'OFFLINE').length, color: '#ef4444' },
    { name: 'Provisioning', value: filtered.filter((d) => d.status === 'PROVISIONING').length, color: '#60a5fa' },
  ].filter((x) => x.value > 0), [filtered]);

  const alarmBarData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeAlarms.forEach((a) => { counts[a.alarmName] = (counts[a.alarmName] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name: name.length > 20 ? name.slice(0, 18) + '…' : name, count }));
  }, [activeAlarms]);

  const firmwarePieData = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach((d) => { if (d.firmwareVersion) counts[d.firmwareVersion] = (counts[d.firmwareVersion] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, value], i) => ({ name, value, color: CHART_COLORS[i % CHART_COLORS.length] }));
  }, [filtered]);

  const alarmSevPieData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeAlarms.forEach((a) => { counts[a.severity] = (counts[a.severity] ?? 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value, color: SEV_COLOR[name] ?? '#94a3b8' }));
  }, [activeAlarms]);

  const deviceTypeBarData = useMemo(() => [
    { name: 'BTS', count: devices.filter((d) => d.deviceType === 'BTS').length, fill: '#60a5fa' },
    { name: 'CPE', count: devices.filter((d) => d.deviceType === 'CPE').length, fill: '#a78bfa' },
    { name: 'IDU', count: devices.filter((d) => d.deviceType === 'IDU').length, fill: '#22d3ee' },
  ].filter((d) => d.count > 0), [devices]);

  // BTS-specific stats
  const btsDevices = useMemo(() => filtered.filter((d) => d.deviceType === 'BTS'), [filtered]);
  const btsChannelData = useMemo(() => {
    const counts: Record<string, number> = {};
    btsDevices.forEach((d) => {
      const ch = (d as Device & { channel?: string | number }).channel;
      if (ch) counts[String(ch)] = (counts[String(ch)] ?? 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([channel, count]) => ({ channel: `Ch ${channel}`, count }));
  }, [btsDevices]);

  // CPE-specific stats
  const cpeDevices = useMemo(() => filtered.filter((d) => d.deviceType === 'CPE'), [filtered]);
  const rssiData = useMemo(() => {
    const buckets: Record<string, number> = { '>=-50': 0, '-50 to -65': 0, '-65 to -75': 0, '<-75': 0 };
    cpeDevices.forEach((d) => {
      const r = (d as Device & { rssi?: number }).rssi;
      if (r == null) return;
      if (r >= -50) buckets['>=-50']++;
      else if (r >= -65) buckets['-50 to -65']++;
      else if (r >= -75) buckets['-65 to -75']++;
      else buckets['<-75']++;
    });
    return Object.entries(buckets).map(([range, count]) => ({ range, count }));
  }, [cpeDevices]);

  const onlinePct = filtered.length > 0 ? Math.round((filtered.filter((d) => d.status === 'ONLINE').length / filtered.length) * 100) : 0;
  const show = (id: WidgetId) => visibleWidgets.has(id);
  const toggleWidget = (id: WidgetId) => setVisibleWidgets((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const modeLabel = { ALL: 'All Devices', BTS: 'BTS Dashboard', CPE: 'CPE Dashboard', IDU: 'IDU Dashboard' }[mode];

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', color: 'var(--text-primary)' }}>

      {/* ── SDD-style Tab bar (Custom | Dashboard1 | Dashboard2…) ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 14, borderBottom: '2px solid var(--border-subtle)' }}>
        {['Custom', 'Dashboard1', 'Dashboard2', 'Dashboard3'].map((tab, i) => {
          const active = (i === 1);  // Dashboard1 is active on this page
          return (
            <button key={tab}
              onClick={() => { if (i === 0) window.location.href = '/dashboards'; }}
              style={{
                padding: '10px 18px', border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 14, fontWeight: active ? 700 : 400,
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -2,
                transition: 'color 0.1s',
              }}>
              {tab}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowWidgetPicker((v) => !v)}
          style={{ background: showWidgetPicker ? 'var(--accent-bg)' : 'none', border: '1px solid var(--border-default)', color: 'var(--accent)', padding: '5px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, marginRight: 8 }}>
          ⚙ Widgets
        </button>
        <button onClick={load} disabled={loading}
          style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '5px 14px', borderRadius: 4, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 12, opacity: loading ? 0.7 : 1 }}>
          {loading ? '↻ Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Active filter tag chips ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const }}>
        {/* Device Type filter chips */}
        {(['ALL', 'BTS', 'CPE', 'IDU'] as DashboardMode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            style={{
              padding: '4px 12px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 12,
              fontWeight: mode === m ? 700 : 400,
              background: mode === m ? (m === 'ALL' ? '#1967D2' : m === 'BTS' ? '#0f9d58' : '#f4b400') : 'var(--bg-elevated)',
              color: mode === m ? '#fff' : 'var(--text-secondary)',
            }}>
            {m === 'ALL' ? 'ALL' : m}
          </button>
        ))}
        <span style={{ color: 'var(--border-default)', margin: '0 4px' }}>|</span>
        {circles.slice(0, 5).map((c) => (
          <button key={c} onClick={() => setFilterCircle(filterCircle === c ? '' : c)}
            style={{
              padding: '3px 10px', borderRadius: 12, border: '1px solid var(--border-default)',
              cursor: 'pointer', fontSize: 11,
              background: filterCircle === c ? 'var(--accent-bg)' : 'var(--bg-elevated)',
              color: filterCircle === c ? 'var(--accent)' : 'var(--text-muted)',
            }}>
            {c}
          </button>
        ))}
        <span style={{ color: 'var(--border-default)', margin: '0 4px' }}>|</span>
        <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)}
          style={{ border: '1px solid var(--border-default)', borderRadius: 6, padding: '3px 8px', fontSize: 11, background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <option value="">All models</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filterFirmware} onChange={(e) => setFilterFirmware(e.target.value)}
          style={{ border: '1px solid var(--border-default)', borderRadius: 6, padding: '3px 8px', fontSize: 11, background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <option value="">All versions</option>
          {firmwares.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        {(filterCircle || filterModel || filterFirmware) && (
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            Showing {filtered.length} of {devices.length} devices
          </span>
        )}
      </div>

      {/* Widget picker */}
      {showWidgetPicker && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Visible Widgets</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(Object.keys(WIDGET_LABELS) as WidgetId[]).map((id) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: visibleWidgets.has(id) ? 'var(--accent)' : 'var(--text-muted)' }}>
                <input type="checkbox" checked={visibleWidgets.has(id)} onChange={() => toggleWidget(id)} />
                {WIDGET_LABELS[id]}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#fca5a5', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
          <span>⚠ {error}</span>
          <button onClick={load} style={{ background: 'none', border: '1px solid #ef4444', color: '#fca5a5', padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Retry</button>
        </div>
      )}

      {/* Filters */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ color: 'var(--text-dim)', fontSize: 11 }}>Circle</label>
        <select style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 12 }}
          value={filterCircle} onChange={(e) => setFilterCircle(e.target.value)}>
          <option value="">All circles</option>
          {circles.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <label style={{ color: 'var(--text-dim)', fontSize: 11 }}>Model</label>
        <select style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 12 }}
          value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
          <option value="">All models</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <label style={{ color: 'var(--text-dim)', fontSize: 11 }}>Firmware</label>
        <select style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 12 }}
          value={filterFirmware} onChange={(e) => setFilterFirmware(e.target.value)}>
          <option value="">All versions</option>
          {firmwares.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>

        {(filterCircle || filterModel || filterFirmware) && (
          <button onClick={() => { setFilterCircle(''); setFilterModel(''); setFilterFirmware(''); }}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
            Clear ×
          </button>
        )}
        <div style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 12 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{modeLabel}</strong>
          {' — '}<strong style={{ color: 'var(--text-primary)' }}>{filtered.length}</strong> of {devices.length} devices
        </div>
      </div>

      {/* Summary stats */}
      {show('stat-summary') && (
        <section aria-label="Summary statistics" style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            <StatCard label="Online" value={filtered.filter((d) => d.status === 'ONLINE').length} total={filtered.length}
              color="#22c55e" icon="●" onClick={() => navigate(`/devices?status=ONLINE${mode !== 'ALL' ? `&type=${mode}` : ''}`)} pct />
            <StatCard label="Offline" value={filtered.filter((d) => d.status === 'OFFLINE').length} total={filtered.length}
              color="#ef4444" icon="●" onClick={() => navigate(`/devices?status=OFFLINE${mode !== 'ALL' ? `&type=${mode}` : ''}`)} pct />
            <StatCard label="Provisioning" value={filtered.filter((d) => d.status === 'PROVISIONING').length} total={filtered.length}
              color="#60a5fa" icon="◌" onClick={() => navigate(`/devices?status=PROVISIONING${mode !== 'ALL' ? `&type=${mode}` : ''}`)} pct />
            <StatCard label="Total" value={filtered.length}
              color="#94a3b8" icon="📡" onClick={() => navigate(`/devices${mode !== 'ALL' ? `?type=${mode}` : ''}`)} />
            <StatCard label="Critical Alarms" value={activeAlarms.filter((a) => a.severity === 'CRITICAL').length}
              color="#ef4444" icon="⛔" onClick={() => navigate('/alarms?severity=CRITICAL')} />
            <StatCard label="Major Alarms" value={activeAlarms.filter((a) => a.severity === 'MAJOR').length}
              color="#fb923c" icon="🔴" onClick={() => navigate('/alarms?severity=MAJOR')} />
            <StatCard label="Active Alarms" value={activeAlarms.length}
              color={activeAlarms.length > 0 ? '#f59e0b' : '#22c55e'} icon="🔔" onClick={() => navigate('/alarms')} />
            <StatCard label="Fleet Health" value={onlinePct} suffix="%" color={onlinePct >= 90 ? '#22c55e' : onlinePct >= 70 ? '#f59e0b' : '#ef4444'} icon="♥" onClick={() => navigate('/devices')} />
          </div>
        </section>
      )}

      {/* Mode-specific extra stats */}
      {mode === 'BTS' && btsDevices.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
          <StatCard label="BTS Total" value={btsDevices.length} color="#60a5fa" icon="🗼" onClick={() => navigate('/devices?type=BTS')} />
          <StatCard label="BTS Online" value={btsDevices.filter((d) => d.status === 'ONLINE').length} total={btsDevices.length} color="#22c55e" icon="●" onClick={() => navigate('/devices?type=BTS&status=ONLINE')} pct />
          <StatCard label="BTS Faulty" value={btsDevices.filter((d) => d.status === 'OFFLINE').length} color="#ef4444" icon="⚠" onClick={() => navigate('/devices?type=BTS&status=OFFLINE')} />
          <StatCard label="Avg CPEs/BTS" value={Math.round(devices.filter((d) => d.deviceType === 'CPE').length / Math.max(btsDevices.length, 1))} color="#a78bfa" icon="📡" onClick={() => navigate('/devices?type=CPE')} />
        </div>
      )}

      {mode === 'CPE' && cpeDevices.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
          <StatCard label="CPE Total" value={cpeDevices.length} color="#a78bfa" icon="📡" onClick={() => navigate('/devices?type=CPE')} />
          <StatCard label="CPE Online" value={cpeDevices.filter((d) => d.status === 'ONLINE').length} total={cpeDevices.length} color="#22c55e" icon="●" onClick={() => navigate('/devices?type=CPE&status=ONLINE')} pct />
          <StatCard label="CPE Offline" value={cpeDevices.filter((d) => d.status === 'OFFLINE').length} color="#ef4444" icon="⚠" onClick={() => navigate('/devices?type=CPE&status=OFFLINE')} />
          <StatCard label="IDU Total" value={devices.filter((d) => d.deviceType === 'IDU').length} color="#22d3ee" icon="🔌" onClick={() => navigate('/devices?type=IDU')} />
        </div>
      )}

      {/* Chart grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 12, marginBottom: 14 }}>
        {show('online-pie') && (
          <ChartCard title="Device Status" subtitle={`${modeLabel} · ${filtered.length} total`}>
            {onlinePieData.length === 0 ? <EmptyChart /> :
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={onlinePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value"
                    label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                    {onlinePieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>}
          </ChartCard>
        )}

        {show('alarm-severity-pie') && (
          <ChartCard title="Active Alarms by Severity" subtitle={`${activeAlarms.length} active`}>
            {alarmSevPieData.length === 0 ? <EmptyChart msg="No active alarms" /> :
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={alarmSevPieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                    {alarmSevPieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>}
          </ChartCard>
        )}

        {show('alarm-bar') && (
          <ChartCard title="Top 10 Alarms" subtitle="By occurrence count" wide>
            {alarmBarData.length === 0 ? <EmptyChart msg="No active alarms" /> :
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={alarmBarData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
                  <XAxis type="number" stroke="var(--text-muted)" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                  <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                  <Bar dataKey="count" fill="#ef4444" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>}
          </ChartCard>
        )}

        {show('firmware-pie') && (
          <ChartCard title="Firmware Version Distribution" subtitle={`${firmwarePieData.length} versions`}>
            {firmwarePieData.length === 0 ? <EmptyChart msg="No firmware data" /> :
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={firmwarePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value"
                    label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`} labelLine={false}>
                    {firmwarePieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                  <Legend iconSize={10} iconType="circle" wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
                </PieChart>
              </ResponsiveContainer>}
          </ChartCard>
        )}

        {show('device-type-bar') && mode === 'ALL' && (
          <ChartCard title="Device Type Breakdown" subtitle="BTS / CPE / IDU counts">
            {deviceTypeBarData.length === 0 ? <EmptyChart /> :
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={deviceTypeBarData} margin={{ top: 8, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis dataKey="name" stroke="var(--text-muted)" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
                  <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {deviceTypeBarData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>}
          </ChartCard>
        )}

        {/* BTS: channel distribution */}
        {mode === 'BTS' && btsChannelData.length > 0 && (
          <ChartCard title="BTS Channel Distribution" subtitle="Operating channel spread">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={btsChannelData} margin={{ top: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="channel" stroke="var(--text-muted)" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                <Bar dataKey="count" fill="#60a5fa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* CPE: RSSI distribution */}
        {mode === 'CPE' && cpeDevices.length > 0 && (
          <ChartCard title="CPE RSSI Distribution" subtitle="Signal quality buckets">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={rssiData} margin={{ top: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="range" stroke="var(--text-muted)" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
                <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <RTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
                <Bar dataKey="count" fill="#a78bfa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* Feed row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {show('recent-alarms') && (
          <FeedCard title={`Recent Active Alarms (${activeAlarms.length})`}
            action={<Link to="/alarms" style={{ color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>See all →</Link>}>
            {activeAlarms.length === 0
              ? <EmptyFeed icon="✅" title="No active alarms" sub="Network is healthy" />
              : [...activeAlarms].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 8).map((a) => (
                <FeedRow key={a.id}>
                  <span style={{ fontSize: 14 }}>{a.severity === 'CRITICAL' ? '⛔' : a.severity === 'MAJOR' ? '🔴' : '🟠'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.alarmName}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'monospace' }}>{a.deviceId}</div>
                  </div>
                  <time style={{ color: 'var(--text-dim)', fontSize: 11, whiteSpace: 'nowrap' }} dateTime={a.timestamp}>{rel(a.timestamp)}</time>
                </FeedRow>
              ))
            }
          </FeedCard>
        )}

        {show('offline-devices') && (
          <FeedCard title={`Offline Devices (${filtered.filter((d) => d.status === 'OFFLINE').length})`}
            action={<Link to={`/devices?status=OFFLINE${mode !== 'ALL' ? `&type=${mode}` : ''}`} style={{ color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>See all →</Link>}>
            {filtered.filter((d) => d.status === 'OFFLINE').length === 0
              ? <EmptyFeed icon="🟢" title="All devices online" sub="No unreachable devices" />
              : filtered.filter((d) => d.status === 'OFFLINE').slice(0, 8).map((d) => (
                <FeedRow key={d.id}>
                  <span style={{ color: '#ef4444', fontSize: 12 }}>●</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 }}>
                      {d.deviceType === 'BTS' ? '🗼 ' : d.deviceType === 'IDU' ? '🔌 ' : '📡 '}{d.serialNumber}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'monospace' }}>{d.ipAddress}</div>
                  </div>
                  {d.lastSeenAt && <time style={{ color: 'var(--text-dim)', fontSize: 11, whiteSpace: 'nowrap' }} dateTime={d.lastSeenAt}>{rel(d.lastSeenAt)}</time>}
                </FeedRow>
              ))
            }
          </FeedCard>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, total, color, icon, onClick, pct, suffix }: {
  label: string; value: number; total?: number; color: string; icon: string;
  onClick: () => void; pct?: boolean; suffix?: string;
}) {
  const pctVal = (pct && total && total > 0) ? ` (${Math.round((value / total) * 100)}%)` : '';
  return (
    <button onClick={onClick} style={{
      textDecoration: 'none', display: 'block', textAlign: 'left', width: '100%',
      background: 'var(--bg-surface)', border: `1px solid ${value > 0 && color !== '#94a3b8' ? color + '44' : 'var(--border-subtle)'}`,
      borderRadius: 8, padding: '12px 14px', cursor: 'pointer',
      transition: 'border-color 0.1s',
    }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
        <span aria-hidden="true">{icon} </span>{label}
      </div>
      <div style={{ color: value > 0 && color !== '#94a3b8' ? color : 'var(--text-dim)', fontSize: 26, fontWeight: 800, fontFamily: 'ui-monospace, monospace' }}>
        {value.toLocaleString()}{suffix ?? ''}
        {pctVal && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>{pctVal}</span>}
      </div>
    </button>
  );
}

function ChartCard({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, gridColumn: wide ? 'span 2' : undefined }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</div>
        {subtitle && <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function FeedCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function FeedRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--bg-card)' }}>{children}</div>;
}

function EmptyChart({ msg = 'No data available' }: { msg?: string }) {
  return <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>{msg}</div>;
}

function EmptyFeed({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{title}</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{sub}</div>
    </div>
  );
}

function rel(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

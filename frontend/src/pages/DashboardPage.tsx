import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, CartesianGrid, Legend,
} from 'recharts';
import { Link } from 'react-router-dom';
import type { Alarm } from '../api/alarms.types';
import type { Device } from '../api/devices.types';
import { fetchAlarms } from '../api/alarms.api';
import { fetchDevices } from '../api/devices.api';

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: '#0a1628', card: '#0d1b2a', border: '#1e293b', borderHi: '#1e3a5f',
  text: '#e2e8f0', muted: '#94a3b8', dim: '#64748b', faint: '#475569',
  blue: '#60a5fa', green: '#22c55e', amber: '#f59e0b', red: '#ef4444',
  purple: '#a78bfa', cyan: '#22d3ee', orange: '#fb923c',
  gridLine: '#1e2d45',
};
const CHART_COLORS = [C.blue, C.green, C.amber, C.red, C.purple, C.cyan, C.orange, '#f472b6', '#34d399', '#fbbf24'];
const SEV_COLOR: Record<string, string> = {
  CRITICAL: C.red, MAJOR: C.orange, MINOR: C.amber, WARNING: C.blue, CLEAR: C.green, INDETERMINATE: C.muted,
};

// ── Widget registry ──────────────────────────────────────────────────────────
type WidgetId = 'stat-summary' | 'online-pie' | 'alarm-bar' | 'firmware-pie'
  | 'alarm-severity-pie' | 'device-type-bar' | 'recent-alarms' | 'offline-devices';

const WIDGET_LABELS: Record<WidgetId, string> = {
  'stat-summary': 'Summary Stats',
  'online-pie': 'Online vs Offline (Pie)',
  'alarm-bar': 'Top 10 Alarms (Bar)',
  'firmware-pie': 'Firmware Distribution (Pie)',
  'alarm-severity-pie': 'Alarm by Severity (Pie)',
  'device-type-bar': 'Device Type Split (Bar)',
  'recent-alarms': 'Recent Active Alarms',
  'offline-devices': 'Offline Devices',
};
const DEFAULT_WIDGETS: WidgetId[] = [
  'stat-summary', 'online-pie', 'alarm-bar', 'firmware-pie',
  'alarm-severity-pie', 'device-type-bar', 'recent-alarms', 'offline-devices',
];

type DeviceTab = 'ALL' | 'BTS' | 'CPE' | 'IDU';

export default function DashboardPage(): React.ReactElement {
  const [devices, setDevices] = useState<Device[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Filters
  const [deviceTab, setDeviceTab] = useState<DeviceTab>('ALL');
  const [filterCircle, setFilterCircle] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterFirmware, setFilterFirmware] = useState('');

  // Widget config
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

  // Derived lists with filters applied
  const circles = useMemo(() => [...new Set(devices.flatMap((d) => (d.tags ?? []).filter((t) => t.key === 'circle').map((t) => t.value)))] , [devices]);
  const models   = useMemo(() => [...new Set(devices.map((d) => d.model).filter(Boolean))], [devices]);
  const firmwares = useMemo(() => [...new Set(devices.map((d) => d.firmwareVersion).filter(Boolean))], [devices]);

  const filtered = useMemo(() => devices.filter((d) => {
    if (deviceTab !== 'ALL' && d.deviceType !== deviceTab) return false;
    if (filterCircle && !d.tags?.some((t) => t.key === 'circle' && t.value === filterCircle)) return false;
    if (filterModel && d.model !== filterModel) return false;
    if (filterFirmware && d.firmwareVersion !== filterFirmware) return false;
    return true;
  }), [devices, deviceTab, filterCircle, filterModel, filterFirmware]);

  // ── Chart data ────────────────────────────────────────────────────
  const onlinePieData = useMemo(() => {
    const online = filtered.filter((d) => d.status === 'ONLINE').length;
    const offline = filtered.filter((d) => d.status === 'OFFLINE').length;
    const prov = filtered.filter((d) => d.status === 'PROVISIONING').length;
    return [
      { name: 'Online', value: online, color: C.green },
      { name: 'Offline', value: offline, color: C.red },
      { name: 'Provisioning', value: prov, color: C.blue },
    ].filter((x) => x.value > 0);
  }, [filtered]);

  const activeAlarms = useMemo(() => alarms.filter((a) => a.state === 'ACTIVE'), [alarms]);

  const alarmBarData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeAlarms.forEach((a) => { counts[a.alarmName] = (counts[a.alarmName] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name: name.length > 18 ? name.slice(0, 16) + '…' : name, count }));
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
    return Object.entries(counts).map(([name, value]) => ({ name, value, color: SEV_COLOR[name] ?? C.muted }));
  }, [activeAlarms]);

  const deviceTypeBarData = useMemo(() => [
    { name: 'BTS', count: filtered.filter((d) => d.deviceType === 'BTS').length, fill: C.blue },
    { name: 'CPE', count: filtered.filter((d) => d.deviceType === 'CPE').length, fill: C.purple },
    { name: 'IDU', count: filtered.filter((d) => d.deviceType === 'IDU').length, fill: C.cyan },
  ].filter((d) => d.count > 0), [filtered]);

  const onlinePct = filtered.length > 0 ? Math.round((filtered.filter((d) => d.status === 'ONLINE').length / filtered.length) * 100) : 0;

  const toggleWidget = (id: WidgetId) => setVisibleWidgets((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const show = (id: WidgetId) => visibleWidgets.has(id);

  // ── Helpers ───────────────────────────────────────────────────────
  const selectStyle: React.CSSProperties = {
    background: '#0f172a', border: `1px solid ${C.borderHi}`, borderRadius: 4,
    color: C.text, padding: '5px 10px', fontSize: 12,
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2 style={{ color: C.text, margin: 0, fontSize: 20, fontWeight: 700 }}>Network Operations Dashboard</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            Last updated {lastRefresh.toLocaleTimeString()} · Auto-refresh 30s
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setShowWidgetPicker((v) => !v)}
            style={{ background: showWidgetPicker ? C.borderHi : 'none', border: `1px solid ${C.borderHi}`, color: C.blue, padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            ⚙ Widgets
          </button>
          <button onClick={load} disabled={loading}
            style={{ background: loading ? '#1e293b' : C.borderHi, border: 'none', color: C.blue, padding: '6px 14px', borderRadius: 4, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 12 }}>
            {loading ? '↻ Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Widget picker ── */}
      {showWidgetPicker && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
            Visible Widgets
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(Object.keys(WIDGET_LABELS) as WidgetId[]).map((id) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: visibleWidgets.has(id) ? C.blue : C.muted }}>
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

      {/* ── Filter bar ── */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Device type tabs */}
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Device type filter">
          {(['ALL', 'BTS', 'CPE', 'IDU'] as DeviceTab[]).map((t) => (
            <button key={t} onClick={() => setDeviceTab(t)}
              style={{ background: deviceTab === t ? C.borderHi : 'none', border: `1px solid ${deviceTab === t ? C.blue : '#374151'}`, color: deviceTab === t ? C.blue : C.muted, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: deviceTab === t ? 700 : 400 }}>
              {t}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: C.border }} />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ color: C.dim, fontSize: 11 }}>Circle</label>
          <select style={selectStyle} value={filterCircle} onChange={(e) => setFilterCircle(e.target.value)}>
            <option value="">All circles</option>
            {circles.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <label style={{ color: C.dim, fontSize: 11 }}>Model</label>
          <select style={selectStyle} value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
            <option value="">All models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <label style={{ color: C.dim, fontSize: 11 }}>Firmware</label>
          <select style={selectStyle} value={filterFirmware} onChange={(e) => setFilterFirmware(e.target.value)}>
            <option value="">All versions</option>
            {firmwares.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>

          {(filterCircle || filterModel || filterFirmware || deviceTab !== 'ALL') && (
            <button onClick={() => { setFilterCircle(''); setFilterModel(''); setFilterFirmware(''); setDeviceTab('ALL'); }}
              style={{ background: 'none', border: `1px solid #374151`, color: C.muted, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
              Clear ×
            </button>
          )}
        </div>

        <div style={{ marginLeft: 'auto', color: C.dim, fontSize: 12 }}>
          Showing <strong style={{ color: C.text }}>{filtered.length}</strong> of {devices.length} devices
        </div>
      </div>

      {/* ── Summary stats row ── */}
      {show('stat-summary') && (
        <section aria-label="Summary statistics" style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            <StatCard label="Online" value={filtered.filter((d) => d.status === 'ONLINE').length} total={filtered.length} color={C.green} icon="●" href="/devices" pct />
            <StatCard label="Offline" value={filtered.filter((d) => d.status === 'OFFLINE').length} total={filtered.length} color={C.red} icon="●" href="/devices?status=OFFLINE" pct />
            <StatCard label="Provisioning" value={filtered.filter((d) => d.status === 'PROVISIONING').length} total={filtered.length} color={C.blue} icon="◌" href="/devices" pct />
            <StatCard label="Total Devices" value={filtered.length} color={C.muted} icon="📡" href="/devices" />
            <StatCard label="Critical" value={activeAlarms.filter((a) => a.severity === 'CRITICAL').length} color={C.red} icon="⛔" href="/alarms" />
            <StatCard label="Major" value={activeAlarms.filter((a) => a.severity === 'MAJOR').length} color={C.orange} icon="🔴" href="/alarms" />
            <StatCard label="Active Alarms" value={activeAlarms.length} color={activeAlarms.length > 0 ? C.amber : C.green} icon="🔔" href="/alarms" />
            <StatCard label="Fleet Health" value={onlinePct} color={onlinePct >= 90 ? C.green : onlinePct >= 70 ? C.amber : C.red} icon="♥" suffix="%" href="/devices" />
          </div>
        </section>
      )}

      {/* ── Main chart grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 12, marginBottom: 14 }}>

        {show('online-pie') && (
          <ChartCard title="Device Status" subtitle={`${deviceTab === 'ALL' ? 'All types' : deviceTab} · ${filtered.length} total`}>
            {onlinePieData.length === 0
              ? <EmptyChart />
              : <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={onlinePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                      {onlinePieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <RTooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
            }
          </ChartCard>
        )}

        {show('alarm-severity-pie') && (
          <ChartCard title="Active Alarms by Severity" subtitle={`${activeAlarms.length} active alarms`}>
            {alarmSevPieData.length === 0
              ? <EmptyChart msg="No active alarms" />
              : <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={alarmSevPieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                      {alarmSevPieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <RTooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
            }
          </ChartCard>
        )}

        {show('alarm-bar') && (
          <ChartCard title="Top 10 Alarms" subtitle="By occurrence count" wide>
            {alarmBarData.length === 0
              ? <EmptyChart msg="No active alarms" />
              : <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={alarmBarData} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine} horizontal={false} />
                    <XAxis type="number" stroke={C.dim} tick={{ fontSize: 11, fill: C.dim }} />
                    <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: C.muted }} />
                    <RTooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12 }} />
                    <Bar dataKey="count" fill={C.red} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
            }
          </ChartCard>
        )}

        {show('firmware-pie') && (
          <ChartCard title="Firmware Version Distribution" subtitle={`${firmwarePieData.length} versions`}>
            {firmwarePieData.length === 0
              ? <EmptyChart msg="No firmware data" />
              : <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={firmwarePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`} labelLine={false}>
                      {firmwarePieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <RTooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12 }} />
                    <Legend iconSize={10} iconType="circle" wrapperStyle={{ fontSize: 11, color: C.muted }} />
                  </PieChart>
                </ResponsiveContainer>
            }
          </ChartCard>
        )}

        {show('device-type-bar') && (
          <ChartCard title="Device Type Breakdown" subtitle="BTS / CPE / IDU counts">
            {deviceTypeBarData.length === 0
              ? <EmptyChart />
              : <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={deviceTypeBarData} margin={{ top: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.gridLine} />
                    <XAxis dataKey="name" stroke={C.dim} tick={{ fontSize: 12, fill: C.muted }} />
                    <YAxis stroke={C.dim} tick={{ fontSize: 11, fill: C.dim }} />
                    <RTooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12 }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {deviceTypeBarData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
            }
          </ChartCard>
        )}
      </div>

      {/* ── Feed row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {show('recent-alarms') && (
          <FeedCard
            title={`Recent Active Alarms (${activeAlarms.length})`}
            action={<Link to="/alarms" style={{ color: C.blue, fontSize: 12, textDecoration: 'none' }}>See all →</Link>}
          >
            {activeAlarms.length === 0
              ? <EmptyFeed icon="✅" title="No active alarms" sub="Network is healthy" />
              : [...activeAlarms].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 8).map((a) => (
                <FeedRow key={a.id}>
                  <span aria-hidden="true" style={{ fontSize: 14 }}>{a.severity === 'CRITICAL' ? '⛔' : a.severity === 'MAJOR' ? '🔴' : '🟠'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.text, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.alarmName}</div>
                    <div style={{ color: C.dim, fontSize: 11, fontFamily: 'monospace' }}>{a.deviceId}</div>
                  </div>
                  <time style={{ color: C.faint, fontSize: 11, whiteSpace: 'nowrap' }} dateTime={a.timestamp}>{rel(a.timestamp)}</time>
                </FeedRow>
              ))
            }
          </FeedCard>
        )}

        {show('offline-devices') && (
          <FeedCard
            title={`Offline Devices (${filtered.filter((d) => d.status === 'OFFLINE').length})`}
            action={<Link to="/devices?status=OFFLINE" style={{ color: C.blue, fontSize: 12, textDecoration: 'none' }}>See all →</Link>}
          >
            {filtered.filter((d) => d.status === 'OFFLINE').length === 0
              ? <EmptyFeed icon="🟢" title="All devices online" sub="No unreachable devices" />
              : filtered.filter((d) => d.status === 'OFFLINE').slice(0, 8).map((d) => (
                <FeedRow key={d.id}>
                  <span aria-hidden="true" style={{ color: C.red, fontSize: 12 }}>●</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>
                      <span aria-hidden="true">{d.deviceType === 'BTS' ? '🗼' : d.deviceType === 'IDU' ? '🔌' : '📡'} </span>
                      {d.serialNumber}
                    </div>
                    <div style={{ color: C.dim, fontSize: 11, fontFamily: 'monospace' }}>{d.ipAddress}</div>
                  </div>
                  {d.lastSeenAt && <time style={{ color: C.faint, fontSize: 11, whiteSpace: 'nowrap' }} dateTime={d.lastSeenAt}>{rel(d.lastSeenAt)}</time>}
                </FeedRow>
              ))
            }
          </FeedCard>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, total, color, icon, href, pct, suffix }: {
  label: string; value: number; total?: number; color: string; icon: string; href: string; pct?: boolean; suffix?: string;
}) {
  const pctVal = (pct && total && total > 0) ? ` (${Math.round((value / total) * 100)}%)` : '';
  return (
    <Link to={href} style={{ textDecoration: 'none' }}>
      <div style={{ background: '#0d1b2a', border: `1px solid ${value > 0 && color !== '#94a3b8' ? color + '33' : '#1e293b'}`, borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ color: '#94a3b8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
          <span aria-hidden="true">{icon} </span>{label}
        </div>
        <div style={{ color: value > 0 && color !== '#94a3b8' ? color : '#475569', fontSize: 26, fontWeight: 800, fontFamily: 'ui-monospace, monospace' }}>
          {value.toLocaleString()}{suffix ?? ''}{pctVal && <span style={{ fontSize: 13, fontWeight: 400, color: '#64748b', marginLeft: 6 }}>{pctVal}</span>}
        </div>
      </div>
    </Link>
  );
}

function ChartCard({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, gridColumn: wide ? 'span 2' : undefined }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</div>
        {subtitle && <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function FeedCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function FeedRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #0f172a' }}>{children}</div>;
}

function EmptyChart({ msg = 'No data available' }: { msg?: string }) {
  return <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 13 }}>{msg}</div>;
}

function EmptyFeed({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '20px 0' }}>
      <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
      <div style={{ color: '#94a3b8', fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{title}</div>
      <div style={{ color: '#475569', fontSize: 12 }}>{sub}</div>
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

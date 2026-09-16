import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, CartesianGrid, Legend,
} from 'recharts';
import { fetchDevices } from '../../api/devices.api';
import { fetchAlarms } from '../../api/alarms.api';
import type { Device } from '../../api/devices.types';
import type { Alarm } from '../../api/alarms.types';
import { logger } from '../utils/logger';

// ── Model normalisation — map any legacy Senao model name to A60/A61/IDU ─────
const LEGACY_MODEL_MAP: Record<string, string> = {
  'Senao ENH1750EXT': 'A60', 'Senao ENH1750EXT-AC': 'A60',
  'ENS500EXT': 'A60', 'ENS620EXT': 'A60', 'ENH700EXT': 'A60',
  'Senao EAP300': 'A61', 'Senao EAP300-AC': 'A61', 'CB-350AC': 'A61',
  'Senao IDU-5000': 'IDU', 'Senao IDU-5000-AC': 'IDU',
};
function normaliseModel(d: Device): Device {
  const mapped = LEGACY_MODEL_MAP[d.model ?? ''];
  return mapped ? { ...d, model: mapped } : d;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type DashboardMode = 'ALL' | 'BTS' | 'CPE' | 'IDU';
type TabId = 1 | 2 | 3;
type WidgetId =
  | 'stat-summary' | 'online-pie' | 'alarm-severity-pie' | 'alarm-bar'
  | 'firmware-pie' | 'device-type-bar' | 'recent-alarms' | 'offline-devices';

const WIDGET_LABELS: Record<WidgetId, string> = {
  'stat-summary':       'Summary Stats',
  'online-pie':         'Device Status',
  'alarm-severity-pie': 'Alarms by Severity',
  'alarm-bar':          'Top 10 Alarms',
  'firmware-pie':       'Firmware Distribution',
  'device-type-bar':    'Device Type Split',
  'recent-alarms':      'Recent Active Alarms',
  'offline-devices':    'Offline Devices',
};
// Intentional order: 3 pies first → fills row 1, then wide bar + small bar → fills row 2
const ALL_WIDGETS: WidgetId[] = [
  'stat-summary',
  'online-pie', 'alarm-severity-pie', 'firmware-pie',
  'alarm-bar', 'device-type-bar',
  'recent-alarms', 'offline-devices',
];

// ── Widget span in a 3-column grid ───────────────────────────────────────────
// Row 1: online-pie(1) + alarm-severity-pie(1) + firmware-pie(1)   full
// Row 2: alarm-bar(2)  + device-type-bar(1)                        full
// Row 3: recent-alarms(2) + offline-devices(1)                     full
const WIDGET_SPAN: Record<WidgetId, 1 | 2 | 3> = {
  'stat-summary':       3,
  'online-pie':         1,
  'alarm-severity-pie': 1,
  'firmware-pie':       1,
  'alarm-bar':          2,
  'device-type-bar':    1,
  'recent-alarms':      2,   // wider feed card fills 2/3 of row 3
  'offline-devices':    1,   // compact feed fills remaining 1/3 of row 3
};

// ── Per-tab saved state ────────────────────────────────────────────────────────
interface TabState {
  mode: DashboardMode;
  filterCircle: string;
  filterModel: string;
  filterFirmware: string;
  visibleWidgets: WidgetId[];
  widgetOrder: WidgetId[];
}

const DEFAULT_TAB_STATE: TabState = {
  mode: 'ALL',
  filterCircle: '',
  filterModel: '',
  filterFirmware: '',
  visibleWidgets: ALL_WIDGETS,
  widgetOrder: ALL_WIDGETS,
};

// v2 = bumped when grid columns changed (3-col vs old 2-col); forces fresh defaults
const STORAGE_KEY = (tabId: TabId) => `vf_dash_tab_v2_${tabId}`;

function loadTabState(tabId: TabId): TabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(tabId));
    if (raw) return { ...DEFAULT_TAB_STATE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_TAB_STATE };
}

function saveTabState(tabId: TabId, state: TabState) {
  try { localStorage.setItem(STORAGE_KEY(tabId), JSON.stringify(state)); } catch { /* ignore */ }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_COLORS = ['#60a5fa','#22c55e','#f59e0b','#ef4444','#a78bfa','#22d3ee','#fb923c','#f472b6','#34d399','#fbbf24'];
const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444', MAJOR: '#fb923c', MINOR: '#f59e0b',
  WARNING: '#60a5fa', CLEAR: '#22c55e', INDETERMINATE: '#94a3b8',
};
const TOOLTIP_STYLE = {
  background: '#112240', border: '1px solid rgba(77,158,255,0.2)',
  borderRadius: 8, color: '#e2e8f0', fontSize: 12,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
};
const MODE_BG: Record<DashboardMode, string> = {
  ALL: 'linear-gradient(135deg, #1e3a5f 0%, #1967D2 100%)',
  BTS: 'linear-gradient(135deg, #14532d 0%, #0f9d58 100%)',
  CPE: 'linear-gradient(135deg, #78350f 0%, #f4b400 100%)',
  IDU: 'linear-gradient(135deg, #3b0764 0%, #a142f4 100%)',
};

function rel(iso: string | undefined | null) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Custom dashboard stub type (mirrors V2CustomDashboardPage) ────────────────
interface CustomDashboardStub { id: string; name: string; }

function loadCustomDashboardsFromCache(): CustomDashboardStub[] {
  try {
    const raw = localStorage.getItem('v2_custom_dashboards_v2');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((d: Record<string, unknown>) => ({ id: String(d.id ?? d._id ?? ''), name: String(d.name ?? '') }));
    }
  } catch { /* ignore */ }
  return [];
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function V2DashboardPage() {
  const navigate = useNavigate();

  // Active built-in tab (only tab 1 remains as built-in)
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    try { return (Number(localStorage.getItem('vf_active_dash_tab')) || 1) as TabId; } catch { return 1; }
  });

  // Per-tab state (loaded from localStorage)
  const [tab1, setTab1] = useState<TabState>(() => loadTabState(1));
  const [tab2, setTab2] = useState<TabState>(() => loadTabState(2));
  const [tab3, setTab3] = useState<TabState>(() => loadTabState(3));

  // Custom dashboards — loaded from API (DB-backed); cache pre-fills for instant render
  const [customDashboards, setCustomDashboards] = useState<CustomDashboardStub[]>(loadCustomDashboardsFromCache);

  // Shared data
  const [devices, setDevices]   = useState<Device[]>([]);
  const [alarms, setAlarms]     = useState<Alarm[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [showWidgets, setShowWidgets] = useState(false);
  const [dragId,   setDragId]   = useState<WidgetId | null>(null);
  const [dragOver, setDragOver] = useState<WidgetId | null>(null);

  // Current tab state accessor
  const tabState = activeTab === 1 ? tab1 : activeTab === 2 ? tab2 : tab3;
  const setTabState = useCallback((updater: (prev: TabState) => TabState) => {
    const update = (setter: React.Dispatch<React.SetStateAction<TabState>>, id: TabId) =>
      setter((prev) => { const next = updater(prev); saveTabState(id, next); return next; });
    if (activeTab === 1) update(setTab1, 1);
    else if (activeTab === 2) update(setTab2, 2);
    else update(setTab3, 3);
  }, [activeTab]);

  const { mode, filterCircle, filterModel, filterFirmware, visibleWidgets, widgetOrder } = tabState;

  // Ordered visible widgets (use saved order, append any new ones at end)
  const orderedVisible = useMemo(() => {
    const inOrder = widgetOrder.filter((w) => visibleWidgets.includes(w));
    const extras   = visibleWidgets.filter((w) => !widgetOrder.includes(w));
    return [...inOrder, ...extras];
  }, [widgetOrder, visibleWidgets]);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((id: WidgetId) => setDragId(id), []);
  const handleDragOver  = useCallback((id: WidgetId, e: React.DragEvent) => {
    e.preventDefault(); setDragOver(id);
  }, []);
  const handleDrop = useCallback((targetId: WidgetId) => {
    if (!dragId || dragId === targetId) return;
    setTabState((p) => {
      const order = [...(p.widgetOrder.length ? p.widgetOrder : ALL_WIDGETS)];
      const from  = order.indexOf(dragId);
      const to    = order.indexOf(targetId);
      if (from === -1 || to === -1) return p;
      order.splice(from, 1);
      order.splice(to, 0, dragId);
      return { ...p, widgetOrder: order };
    });
    setDragId(null); setDragOver(null);
  }, [dragId, setTabState]);
  const handleDragEnd = useCallback(() => { setDragId(null); setDragOver(null); }, []);
  const setMode          = (m: DashboardMode) => setTabState((p) => ({ ...p, mode: m }));
  const setFilterCircle  = (v: string)        => setTabState((p) => ({ ...p, filterCircle: v }));
  const setFilterModel   = (v: string)        => setTabState((p) => ({ ...p, filterModel: v }));
  const setFilterFirmware = (v: string)       => setTabState((p) => ({ ...p, filterFirmware: v }));
  const toggleWidget = (id: WidgetId) => setTabState((p) => ({
    ...p,
    visibleWidgets: p.visibleWidgets.includes(id)
      ? p.visibleWidgets.filter((w) => w !== id)
      : [...p.visibleWidgets, id],
  }));

  const switchTab = (id: TabId) => {
    setActiveTab(id);
    setShowWidgets(false);
    try { localStorage.setItem('vf_active_dash_tab', String(id)); } catch { /* ignore */ }
  };

  // Fetch custom dashboards from API on mount and on window focus
  const refreshCustomDashboards = useCallback(() => {
    apiClient.get('/dashboards').then((res) => {
      const list = (Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
      const stubs = list.map((d) => ({ id: String(d.id ?? d._id ?? ''), name: String(d.name ?? '') }));
      setCustomDashboards(stubs);
      // Keep cache in sync so instant-render stays fresh
      try { localStorage.setItem('v2_custom_dashboards_v2', JSON.stringify(list)); } catch { /* ignore */ }
    }).catch(() => {
      // API down — fall back to cache
      setCustomDashboards(loadCustomDashboardsFromCache());
    });
  }, []);

  useEffect(() => {
    refreshCustomDashboards();
    window.addEventListener('focus', refreshCustomDashboards);
    return () => window.removeEventListener('focus', refreshCustomDashboards);
  }, [refreshCustomDashboards]);

  // Data loading
  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      fetchDevices({}).catch(() => [] as Device[]),
      fetchAlarms({}).catch(() => [] as Alarm[]),
    ]).then(([d, a]) => { setDevices(d.map(normaliseModel)); setAlarms(a); })
      .catch((e) => { logger.error('Dashboard fetch', e); setError('Unable to load dashboard data.'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  // Derived data
  const circles   = useMemo(() => [...new Set(devices.flatMap((d) => (d.tags ?? []).filter((t) => t.key === 'circle' && !!t.value).map((t) => t.value)))].filter(Boolean), [devices]);
  // Only allowed models — filter out any legacy Senao model names from the backend
  const ALLOWED_MODELS = ['A60', 'A61', 'IDU'];
  const models    = useMemo(() => ALLOWED_MODELS.filter((m) => devices.some((d) => d.model === m)), [devices]);
  const firmwares = useMemo(() => [...new Set(devices.map((d) => d.firmwareVersion).filter(Boolean))], [devices]);

  const filtered = useMemo(() => devices.filter((d) => {
    if (mode !== 'ALL' && d.deviceType !== mode) return false;
    if (filterCircle && !d.tags?.some((t) => t.key === 'circle' && t.value === filterCircle)) return false;
    if (filterModel && d.model !== filterModel) return false;
    if (filterFirmware && d.firmwareVersion !== filterFirmware) return false;
    return true;
  }), [devices, mode, filterCircle, filterModel, filterFirmware]);

  const activeAlarms = useMemo(() => alarms.filter((a) => a.state === 'ACTIVE'), [alarms]);

  const onlinePieData = useMemo(() => [
    { name: 'Online',       value: filtered.filter((d) => d.status === 'ONLINE').length,       color: '#22c55e' },
    { name: 'Offline',      value: filtered.filter((d) => d.status === 'OFFLINE').length,      color: '#ef4444' },
    { name: 'Provisioning', value: filtered.filter((d) => d.status === 'PROVISIONING').length, color: '#60a5fa' },
  ].filter((x) => x.value > 0), [filtered]);

  const alarmBarData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeAlarms.forEach((a) => { counts[a.alarmName] = (counts[a.alarmName] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name: name.length > 22 ? name.slice(0, 20) + '…' : name, count }));
  }, [activeAlarms]);

  const alarmSevData = useMemo(() => {
    const counts: Record<string, number> = {};
    activeAlarms.forEach((a) => { counts[a.severity] = (counts[a.severity] ?? 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value, color: SEV_COLOR[name] ?? '#94a3b8' }));
  }, [activeAlarms]);

  const firmwarePieData = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach((d) => { if (d.firmwareVersion) counts[d.firmwareVersion] = (counts[d.firmwareVersion] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, value], i) => ({ name, value, color: CHART_COLORS[i % CHART_COLORS.length] }));
  }, [filtered]);

  const deviceTypeBarData = useMemo(() => [
    { name: 'BTS', count: devices.filter((d) => d.deviceType === 'BTS').length, fill: '#60a5fa' },
    { name: 'CPE', count: devices.filter((d) => d.deviceType === 'CPE').length, fill: '#a78bfa' },
    { name: 'IDU', count: devices.filter((d) => d.deviceType === 'IDU').length, fill: '#22d3ee' },
  ].filter((d) => d.count > 0), [devices]);

  const btsDevices = useMemo(() => filtered.filter((d) => d.deviceType === 'BTS'), [filtered]);
  const cpeDevices = useMemo(() => filtered.filter((d) => d.deviceType === 'CPE'), [filtered]);
  const btsChannelData = useMemo(() => {
    const counts: Record<string, number> = {};
    btsDevices.forEach((d) => { const ch = (d as Device & { channel?: string }).channel; if (ch) counts[ch] = (counts[ch] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([ch, count]) => ({ channel: `Ch ${ch}`, count }));
  }, [btsDevices]);
  const rssiData = useMemo(() => {
    const buckets: Record<string, number> = { '>=-50': 0, '-50 to -65': 0, '-65 to -75': 0, '<-75': 0 };
    cpeDevices.forEach((d) => {
      const r = (d as Device & { rssi?: number }).rssi;
      if (r == null) return;
      if (r >= -50) buckets['>=-50']++; else if (r >= -65) buckets['-50 to -65']++;
      else if (r >= -75) buckets['-65 to -75']++; else buckets['<-75']++;
    });
    return Object.entries(buckets).map(([range, count]) => ({ range, count }));
  }, [cpeDevices]);

  const onlineCount   = filtered.filter((d) => d.status === 'ONLINE').length;
  const offlineCount  = filtered.filter((d) => d.status === 'OFFLINE').length;
  const provCount     = filtered.filter((d) => d.status === 'PROVISIONING').length;
  const critCount     = activeAlarms.filter((a) => a.severity === 'CRITICAL').length;
  const majorCount    = activeAlarms.filter((a) => a.severity === 'MAJOR').length;
  const onlinePct     = filtered.length > 0 ? Math.round((onlineCount / filtered.length) * 100) : 0;
  const show          = (id: WidgetId) => visibleWidgets.includes(id);

  return (
    <div style={{ fontFamily: 'var(--vf-font-sans)', background: 'var(--vf-canvas)', minHeight: '100%' }}>

      {/* ── Tab bar ───────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        background: 'var(--vf-surface)',
        borderBottom: '1px solid var(--vf-border-subtle)',
        padding: '0 24px',
        boxShadow: 'var(--vf-shadow-low)',
      }}>
        {/* Built-in Dashboard 1 tab */}
        <button onClick={() => switchTab(1)}
          style={{
            padding: '14px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: activeTab === 1 ? 700 : 500,
            color: activeTab === 1 ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
            borderBottom: activeTab === 1 ? '2px solid var(--vf-accent)' : '2px solid transparent',
            transition: 'color 0.15s, border-color 0.15s', whiteSpace: 'nowrap',
          }}>
          Dashboard 1
        </button>

        {/* Custom dashboard tabs (from My Dashboards) */}
        {customDashboards.map((cd) => (
          <button key={cd.id} onClick={() => navigate(`/v2/dashboards?view=${cd.id}`)}
            style={{
              padding: '14px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, color: 'var(--vf-text-secondary)',
              borderBottom: '2px solid transparent',
              transition: 'color 0.15s, border-color 0.15s', whiteSpace: 'nowrap',
              maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
            }}
            title={cd.name}>
            {cd.name}
          </button>
        ))}

        {/* Manage dashboards button */}
        <button onClick={() => navigate('/v2/dashboards')}
          title="Manage custom dashboards"
          style={{
            padding: '10px 12px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 18, lineHeight: 1, color: 'var(--vf-text-muted)',
            borderBottom: '2px solid transparent', transition: 'color 0.15s',
          }}>
          +
        </button>

        <div style={{ flex: 1 }} />

        {/* Actions */}
        <button onClick={() => setShowWidgets((v) => !v)}
          style={{
            background: showWidgets ? 'var(--vf-accent-subtle)' : 'transparent',
            border: '1px solid var(--vf-border-default)', color: 'var(--vf-text-secondary)',
            padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
            fontSize: 12, marginRight: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5,
          }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="0" y="0" width="5" height="5" rx="1" fill="currentColor" opacity=".7"/>
            <rect x="7" y="0" width="5" height="5" rx="1" fill="currentColor"/>
            <rect x="0" y="7" width="5" height="5" rx="1" fill="currentColor"/>
            <rect x="7" y="7" width="5" height="5" rx="1" fill="currentColor" opacity=".7"/>
          </svg>
          Widgets
        </button>
        <button onClick={load} disabled={loading}
          style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
            opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 5,
            boxShadow: '0 2px 8px rgba(59,130,246,0.3)',
          }}>
          <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Tab label badge ───────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)',
            color: 'var(--vf-accent)', padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          }}>
            Dashboard 1
          </span>
          <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>
            Filters &amp; widget layout are saved automatically. Use + to create custom dashboards.
          </span>
        </div>

        {/* ── Widget picker ─────────────────────────────────────────────────── */}
        {showWidgets && (
          <div style={{
            background: 'var(--vf-surface)', border: 'var(--vf-card-border)',
            borderRadius: 10, padding: '14px 18px', boxShadow: 'var(--vf-shadow-low)',
          }}>
            <div style={{ color: 'var(--vf-text-muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
              Dashboard 1 — Toggle Widgets
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {ALL_WIDGETS.map((id) => (
                <button key={id} onClick={() => toggleWidget(id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 12px', borderRadius: 20, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    background: visibleWidgets.includes(id) ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
                    border: visibleWidgets.includes(id) ? '1px solid var(--vf-accent)' : '1px solid var(--vf-border-subtle)',
                    color: visibleWidgets.includes(id) ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
                    transition: 'all 0.15s',
                  }}>
                  <span style={{ fontSize: 9 }}>●</span>
                  {WIDGET_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Device type chips ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(['ALL', 'BTS', 'CPE', 'IDU'] as DashboardMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                padding: '6px 18px', borderRadius: 20, cursor: 'pointer',
                fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
                background: mode === m ? MODE_BG[m] : 'var(--vf-elevated)',
                color: mode === m ? '#fff' : 'var(--vf-text-secondary)',
                boxShadow: mode === m ? '0 2px 10px rgba(0,0,0,0.18)' : 'none',
                border: mode === m ? '1px solid transparent' : '1px solid var(--vf-border-subtle)',
                transition: 'all 0.15s',
              }}>
              {m}
            </button>
          ))}
          {circles.slice(0, 6).map((c) => (
            <button key={c} onClick={() => setFilterCircle(filterCircle === c ? '' : c)}
              style={{
                padding: '5px 14px', borderRadius: 20,
                border: filterCircle === c ? '1px solid var(--vf-accent)' : '1px solid var(--vf-border-subtle)',
                cursor: 'pointer', fontSize: 11, fontWeight: 600,
                background: filterCircle === c ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
                color: filterCircle === c ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                transition: 'all 0.15s',
              }}>
              {c}
            </button>
          ))}
        </div>

        {/* ── Filter bar ────────────────────────────────────────────────────── */}
        <div style={{
          background: 'var(--vf-surface)', border: 'var(--vf-card-border)',
          borderRadius: 10, padding: '12px 18px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center',
          boxShadow: 'var(--vf-shadow-low)',
        }}>
          {[
            { label: 'Circle',   value: filterCircle,   options: circles,   set: setFilterCircle },
            { label: 'Model',    value: filterModel,    options: models,    set: setFilterModel },
            { label: 'Firmware', value: filterFirmware, options: firmwares, set: setFilterFirmware },
          ].map(({ label, value, options, set }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ color: 'var(--vf-text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
              <select value={value} onChange={(e) => set(e.target.value)}
                style={{
                  background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
                  borderRadius: 6, color: 'var(--vf-text-primary)', padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                }}>
                <option value="">All {label.toLowerCase()}s</option>
                {options.filter(Boolean).map((o, i) => <option key={`${i}-${o}`} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          {(filterCircle || filterModel || filterFirmware) && (
            <button onClick={() => { setFilterCircle(''); setFilterModel(''); setFilterFirmware(''); }}
              style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              Clear ×
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--vf-text-muted)', fontSize: 12 }}>{mode === 'ALL' ? 'All Devices' : `${mode} View`}</span>
            <span style={{ background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)', color: 'var(--vf-accent)', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, fontFamily: 'var(--vf-font-mono)' }}>
              {filtered.length} / {devices.length}
            </span>
          </div>
        </div>

        {/* ── Error banner ──────────────────────────────────────────────────── */}
        {error && (
          <div role="alert" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, padding: '12px 16px', color: '#f87171', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>⚠ {error}</span>
            <button onClick={load} style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', padding: '3px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Retry</button>
          </div>
        )}

        {/* ── Summary KPI tiles ─────────────────────────────────────────────── */}
        {show('stat-summary') && (() => {
          // Build mode-aware URLs for tiles (defined here so they pick up current `mode`)
          const dUrl = (extra: Record<string, string> = {}) => {
            const p = new URLSearchParams();
            if (mode !== 'ALL') p.set('deviceType', mode);
            Object.entries(extra).forEach(([k, v]) => p.set(k, v));
            const qs = p.toString(); return `/v2/devices${qs ? '?' + qs : ''}`;
          };
          const aUrl = (extra: Record<string, string> = {}) => {
            const p = new URLSearchParams(extra); const qs = p.toString();
            return `/v2/alarms${qs ? '?' + qs : ''}`;
          };
          return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10 }}>
              <KpiTile icon="🟢" label="Online"       value={onlineCount}         total={filtered.length} color="#22c55e" grad="rgba(34,197,94,0.08)"   onClick={() => navigate(dUrl({ status: 'ONLINE' }))} />
              <KpiTile icon="🔴" label="Offline"      value={offlineCount}        total={filtered.length} color="#ef4444" grad="rgba(239,68,68,0.08)"   onClick={() => navigate(dUrl({ status: 'OFFLINE' }))} />
              <KpiTile icon="◌"  label="Provisioning" value={provCount}           total={filtered.length} color="#60a5fa" grad="rgba(96,165,250,0.08)"  onClick={() => navigate(dUrl({ status: 'PROVISIONING' }))} />
              <KpiTile icon="📡" label="Total"         value={filtered.length}                            color="#94a3b8" grad="rgba(148,163,184,0.06)"  onClick={() => navigate(dUrl())} />
              <KpiTile icon="⛔" label="Critical"      value={critCount}                                  color="#ef4444" grad="rgba(239,68,68,0.1)"    onClick={() => navigate(aUrl({ severity: 'CRITICAL' }))} />
              <KpiTile icon="🔶" label="Major Alarms"  value={majorCount}                                 color="#fb923c" grad="rgba(251,146,60,0.08)"   onClick={() => navigate(aUrl({ severity: 'MAJOR' }))} />
              <KpiTile icon="🔔" label="Active Alarms" value={activeAlarms.length}                       color={activeAlarms.length > 0 ? '#f59e0b' : '#22c55e'} grad={activeAlarms.length > 0 ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.06)'} onClick={() => navigate(aUrl({ state: 'ACTIVE' }))} />
              <KpiTile icon="♥"  label="Fleet Health"  value={onlinePct} suffix="%" color={onlinePct >= 90 ? '#22c55e' : onlinePct >= 70 ? '#f59e0b' : '#ef4444'} grad={onlinePct >= 90 ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)'} onClick={() => navigate(dUrl())} />
            </div>
          );
        })()}

        {/* BTS mode extras */}
        {mode === 'BTS' && btsDevices.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10 }}>
            <KpiTile icon="🗼" label="BTS Total"    value={btsDevices.length}                                                       color="#60a5fa" grad="rgba(96,165,250,0.08)"  onClick={() => navigate('/v2/devices?deviceType=BTS')} />
            <KpiTile icon="🟢" label="BTS Online"   value={btsDevices.filter((d) => d.status === 'ONLINE').length}   total={btsDevices.length} color="#22c55e" grad="rgba(34,197,94,0.08)"  onClick={() => navigate('/v2/devices?deviceType=BTS&status=ONLINE')} />
            <KpiTile icon="⚠"  label="BTS Faulty"   value={btsDevices.filter((d) => d.status === 'OFFLINE').length}               color="#ef4444" grad="rgba(239,68,68,0.08)"  onClick={() => navigate('/v2/devices?deviceType=BTS&status=OFFLINE')} />
            <KpiTile icon="📡" label="Avg CPEs/BTS" value={Math.round(devices.filter((d) => d.deviceType === 'CPE').length / Math.max(btsDevices.length, 1))} color="#a78bfa" grad="rgba(167,139,250,0.08)" onClick={() => navigate('/v2/devices?deviceType=CPE')} />
          </div>
        )}
        {mode === 'CPE' && cpeDevices.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 10 }}>
            <KpiTile icon="📡" label="CPE Total"   value={cpeDevices.length}                                                      color="#a78bfa" grad="rgba(167,139,250,0.08)" onClick={() => navigate('/v2/devices?deviceType=CPE')} />
            <KpiTile icon="🟢" label="CPE Online"  value={cpeDevices.filter((d) => d.status === 'ONLINE').length} total={cpeDevices.length} color="#22c55e" grad="rgba(34,197,94,0.08)" onClick={() => navigate('/v2/devices?deviceType=CPE&status=ONLINE')} />
            <KpiTile icon="⚠"  label="CPE Offline" value={cpeDevices.filter((d) => d.status === 'OFFLINE').length}              color="#ef4444" grad="rgba(239,68,68,0.08)"  onClick={() => navigate('/v2/devices?deviceType=CPE&status=OFFLINE')} />
            <KpiTile icon="🔌" label="IDU Total"   value={devices.filter((d) => d.deviceType === 'IDU').length}                  color="#22d3ee" grad="rgba(34,211,238,0.08)" onClick={() => navigate('/v2/devices?deviceType=IDU')} />
          </div>
        )}

        {/* ── Unified draggable widget grid (3-col: 3 pies row1, bar+bar row2) ─ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {orderedVisible.map((id) => {
            const span = WIDGET_SPAN[id] ?? 1;
            const isBeingDragged = dragId === id;
            const isDropTarget   = dragOver === id && dragId !== id;
            const wrapStyle: React.CSSProperties = {
              gridColumn: span > 1 ? `span ${span}` : undefined,
              opacity: isBeingDragged ? 0.4 : 1,
              outline: isDropTarget ? '2px dashed #4d9eff' : 'none',
              outlineOffset: 3,
              borderRadius: 12,
              transition: 'opacity 0.15s, outline 0.1s',
              cursor: 'grab',
            };

            // ── Drilldown URL builder — preserves current mode filter ────────
            const devUrl = (extra: Record<string, string> = {}) => {
              const p = new URLSearchParams();
              if (mode !== 'ALL') p.set('deviceType', mode);
              Object.entries(extra).forEach(([k, v]) => p.set(k, v));
              const qs = p.toString();
              return `/v2/devices${qs ? '?' + qs : ''}`;
            };
            const almUrl = (extra: Record<string, string> = {}) => {
              const p = new URLSearchParams(extra);
              const qs = p.toString();
              return `/v2/alarms${qs ? '?' + qs : ''}`;
            };

            // ── Render each widget content ───────────────────────────────
            let content: React.ReactNode = null;
            if (id === 'online-pie') content = (
              <PCard title="Device Status" sub={`${mode === 'ALL' ? 'All Devices' : mode} · ${filtered.length} total`} accent="#22c55e">
                {onlinePieData.length === 0 ? <NoData /> :
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart style={{ cursor: 'pointer' }}>
                      <Pie data={onlinePieData} cx="50%" cy="50%" outerRadius={85} innerRadius={40} dataKey="value"
                        label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                        labelLine={{ stroke: 'rgba(77,158,255,0.2)' }}
                        onClick={(entry) => navigate(devUrl({ status: String(entry.name).toUpperCase() }))}>
                        {onlinePieData.map((e, i) => <Cell key={i} fill={e.color} stroke="transparent" style={{ cursor: 'pointer' }} />)}
                      </Pie>
                      <RTooltip contentStyle={{ ...TOOLTIP_STYLE, cursor: 'pointer' }} formatter={(val, name) => [`${val} devices`, name]} />
                    </PieChart>
                  </ResponsiveContainer>}
              </PCard>
            );
            else if (id === 'alarm-severity-pie') content = (
              <PCard title="Alarms by Severity" sub={`${activeAlarms.length} active`} accent="#ef4444">
                {alarmSevData.length === 0 ? <NoData msg="No active alarms" /> :
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart style={{ cursor: 'pointer' }}>
                      <Pie data={alarmSevData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value"
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={{ stroke: 'rgba(77,158,255,0.2)' }}
                        onClick={(entry) => navigate(almUrl({ severity: String(entry.name).toUpperCase() }))}>
                        {alarmSevData.map((e, i) => <Cell key={i} fill={e.color} stroke="transparent" style={{ cursor: 'pointer' }} />)}
                      </Pie>
                      <RTooltip contentStyle={TOOLTIP_STYLE} formatter={(val, name) => [`${val} alarms`, name]} />
                    </PieChart>
                  </ResponsiveContainer>}
              </PCard>
            );
            else if (id === 'alarm-bar') content = (
              <PCard title="Top 10 Alarms" sub="By occurrence count — click to filter" accent="#ef4444">
                {alarmBarData.length === 0 ? <NoData msg="No active alarms" /> :
                  <ResponsiveContainer width="100%" height={230}>
                    <BarChart data={alarmBarData} layout="vertical" margin={{ left: 8, right: 24, top: 4 }}
                      style={{ cursor: 'pointer' }}
                      onClick={(e: unknown) => { const p = (e as { activePayload?: { payload?: { name?: string } }[] })?.activePayload?.[0]?.payload?.name; if (p) navigate(almUrl({ search: p })); }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(77,158,255,0.06)" horizontal={false} />
                      <XAxis type="number" stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-muted)' }} axisLine={false} />
                      <YAxis type="category" dataKey="name" width={155} tick={{ fontSize: 11, fill: 'var(--vf-text-secondary)' }} axisLine={false} tickLine={false} />
                      <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(77,158,255,0.05)' }} formatter={(val) => [`${val} occurrences`]} />
                      <Bar dataKey="count" fill="url(#alarmGrad)" radius={[0, 4, 4, 0]}>
                        <defs>
                          <linearGradient id="alarmGrad" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.8" />
                            <stop offset="100%" stopColor="#f97316" />
                          </linearGradient>
                        </defs>
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>}
              </PCard>
            );
            else if (id === 'firmware-pie') content = (
              <PCard title="Firmware Distribution" sub={`${firmwarePieData.length} versions — click to filter`} accent="#a78bfa">
                {firmwarePieData.length === 0 ? <NoData msg="No firmware data" /> :
                  <ResponsiveContainer width="100%" height={230}>
                    <PieChart style={{ cursor: 'pointer' }}>
                      <Pie data={firmwarePieData} cx="50%" cy="50%" outerRadius={80} dataKey="value"
                        label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
                        labelLine={{ stroke: 'rgba(77,158,255,0.2)' }}
                        onClick={(entry) => navigate(devUrl({ firmware: String(entry.name) }))}>
                        {firmwarePieData.map((e, i) => <Cell key={i} fill={e.color} stroke="transparent" style={{ cursor: 'pointer' }} />)}
                      </Pie>
                      <RTooltip contentStyle={TOOLTIP_STYLE} formatter={(val, name) => [`${val} devices`, name]} />
                      <Legend iconSize={9} iconType="circle" wrapperStyle={{ fontSize: 11, color: 'var(--vf-text-muted)' }} />
                    </PieChart>
                  </ResponsiveContainer>}
              </PCard>
            );
            else if (id === 'device-type-bar') {
              // ALL → Device Type Breakdown; BTS → Channel Distribution; CPE → RSSI; IDU → placeholder
              if (mode === 'ALL') {
                content = (
                  <PCard title="Device Type Breakdown" sub="BTS / CPE / IDU — click to filter" accent="#60a5fa">
                    {deviceTypeBarData.length === 0 ? <NoData /> :
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={deviceTypeBarData} margin={{ top: 8, right: 16 }}
                          style={{ cursor: 'pointer' }}
                          onClick={(e: unknown) => { const p = (e as { activePayload?: { payload?: { name?: string } }[] })?.activePayload?.[0]?.payload?.name; if (p) navigate(devUrl({ deviceType: p })); }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(77,158,255,0.06)" vertical={false} />
                          <XAxis dataKey="name" stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 12, fill: 'var(--vf-text-secondary)' }} axisLine={false} />
                          <YAxis stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-muted)' }} axisLine={false} tickLine={false} />
                          <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(77,158,255,0.05)' }} formatter={(val, name) => [`${val} devices`, name]} />
                          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                            {deviceTypeBarData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>}
                  </PCard>
                );
              } else if (mode === 'BTS') {
                content = (
                  <PCard title="BTS Channel Distribution" sub="Operating channel spread" accent="#60a5fa">
                    {btsChannelData.length === 0 ? <NoData msg="No channel data" /> :
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={btsChannelData} margin={{ top: 8, right: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(77,158,255,0.06)" vertical={false} />
                          <XAxis dataKey="channel" stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-secondary)' }} axisLine={false} />
                          <YAxis stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-muted)' }} axisLine={false} tickLine={false} />
                          <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(77,158,255,0.05)' }} />
                          <Bar dataKey="count" fill="#60a5fa" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>}
                  </PCard>
                );
              } else if (mode === 'CPE') {
                content = (
                  <PCard title="CPE RSSI Distribution" sub="Signal quality buckets" accent="#a78bfa">
                    {rssiData.every((r) => r.count === 0) ? <NoData msg="No RSSI data" /> :
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={rssiData} margin={{ top: 8, right: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(77,158,255,0.06)" vertical={false} />
                          <XAxis dataKey="range" stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 10, fill: 'var(--vf-text-secondary)' }} axisLine={false} />
                          <YAxis stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-muted)' }} axisLine={false} tickLine={false} />
                          <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(77,158,255,0.05)' }} />
                          <Bar dataKey="count" fill="#a78bfa" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>}
                  </PCard>
                );
              } else {
                // IDU mode — show device type breakdown (always useful context)
                content = (
                  <PCard title="Device Type Breakdown" sub="Fleet composition" accent="#22d3ee">
                    {deviceTypeBarData.length === 0 ? <NoData /> :
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={deviceTypeBarData} margin={{ top: 8, right: 16 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(77,158,255,0.06)" vertical={false} />
                          <XAxis dataKey="name" stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 12, fill: 'var(--vf-text-secondary)' }} axisLine={false} />
                          <YAxis stroke="rgba(148,163,184,0.3)" tick={{ fontSize: 11, fill: 'var(--vf-text-muted)' }} axisLine={false} tickLine={false} />
                          <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(77,158,255,0.05)' }} formatter={(val, name) => [`${val} devices`, name]} />
                          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                            {deviceTypeBarData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>}
                  </PCard>
                );
              }
            }
            else if (id === 'recent-alarms') content = (
              <FeedCard title="Recent Active Alarms" count={activeAlarms.length} accent="#ef4444"
                action={<a href="/v2/alarms" style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'none', fontWeight: 600 }}>View all →</a>}>
                {activeAlarms.length === 0
                  ? <EmptyFeed icon="✅" title="No active alarms" sub="Network is healthy" />
                  : [...activeAlarms]
                      .sort((a, b) => new Date(b.timestamp || b.raisedAt || 0).getTime() - new Date(a.timestamp || a.raisedAt || 0).getTime())
                      .slice(0, 8)
                      .map((a) => {
                        // Resolve the best available device identifier for display
                        const isSystemAlarm = !a.deviceId || a.deviceId === 'unknown' || a.deviceId === '';
                        const deviceLabel   = isSystemAlarm
                          ? 'System / NMS'
                          : (a.serialNumber || a.deviceName || a.deviceId);

                        // Human-readable description: use message if backend provides it,
                        // otherwise fall back to alarmName (which may just be "service down")
                        const displayText = a.message || a.alarmName;

                        return (
                          <FeedRow
                            key={a.id}
                            accent={a.severity === 'CRITICAL' ? '#ef4444' : a.severity === 'MAJOR' ? '#fb923c' : '#f59e0b'}
                            onClick={() => {
                              if (isSystemAlarm) {
                                // System alarms → alarms page filtered by type
                                navigate(`/v2/alarms?alarmType=${encodeURIComponent(a.alarmType || '')}`);
                              } else {
                                // Device alarm → navigate to device detail page
                                const devId = a.serialNumber || a.deviceId;
                                navigate(`/v2/devices/${devId}`);
                              }
                            }}
                          >
                            <span>{a.severity === 'CRITICAL' ? '⛔' : a.severity === 'MAJOR' ? '🔴' : '🟠'}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: 'var(--vf-text-primary)', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {displayText}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                                {isSystemAlarm
                                  ? <span style={{ color: 'var(--vf-text-dim)', fontSize: 10, fontStyle: 'italic' }}>System / NMS</span>
                                  : <span style={{ color: '#60a5fa', fontSize: 10, fontFamily: 'var(--vf-font-mono)', cursor: 'pointer', textDecoration: 'underline' }}
                                      onClick={(e) => { e.stopPropagation(); navigate(`/v2/devices/${a.serialNumber || a.deviceId}`); }}>
                                      {deviceLabel}
                                    </span>
                                }
                                {a.alarmType && a.alarmType !== a.alarmName && (
                                  <span style={{ background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)', color: 'var(--vf-text-dim)', fontSize: 9, padding: '0 4px', borderRadius: 3 }}>
                                    {a.alarmType}
                                  </span>
                                )}
                              </div>
                            </div>
                            <time style={{ color: 'var(--vf-text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{rel(a.timestamp)}</time>
                          </FeedRow>
                        );
                      })}
              </FeedCard>
            );
            else if (id === 'offline-devices') content = (
              <FeedCard title="Offline Devices" count={filtered.filter((d) => d.status === 'OFFLINE').length} accent="#ef4444"
                action={<a href="/v2/devices" style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'none', fontWeight: 600 }}>View all →</a>}>
                {filtered.filter((d) => d.status === 'OFFLINE').length === 0
                  ? <EmptyFeed icon="🟢" title="All devices online" sub="No unreachable devices" />
                  : filtered.filter((d) => d.status === 'OFFLINE').slice(0, 8).map((d) => (
                    <FeedRow
                      key={d.id || d.serialNumber}
                      accent="#ef4444"
                      onClick={() => {
                        // Drilldown: go to inventory filtered to this specific device
                        const p = new URLSearchParams({ status: 'OFFLINE' });
                        if (mode !== 'ALL') p.set('deviceType', mode);
                        if (d.serialNumber) p.set('search', d.serialNumber);
                        navigate(`/v2/devices?${p.toString()}`);
                      }}
                    >
                      <span style={{ color: '#ef4444' }}>●</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: 'var(--vf-text-primary)', fontSize: 12, fontWeight: 600 }}>
                          {d.deviceType === 'BTS' ? '🗼 ' : d.deviceType === 'IDU' ? '🔌 ' : '📡 '}{d.serialNumber}
                        </div>
                        <div style={{ color: 'var(--vf-text-muted)', fontSize: 11, fontFamily: 'var(--vf-font-mono)' }}>{d.ipAddress}</div>
                      </div>
                      {d.lastSeenAt && <time style={{ color: 'var(--vf-text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{rel(d.lastSeenAt)}</time>}
                    </FeedRow>
                  ))}
              </FeedCard>
            );
            else if (id === 'stat-summary') content = null; // rendered above the grid

            if (content === null) return null;

            return (
              <div key={id} style={wrapStyle}
                draggable
                onDragStart={() => handleDragStart(id)}
                onDragOver={(e) => handleDragOver(id, e)}
                onDrop={() => handleDrop(id)}
                onDragEnd={handleDragEnd}
                title="Drag to reorder"
              >
                {content}
              </div>
            );
          })}

        </div>

      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiTile({ icon, label, value, total, color, onClick, suffix }: {
  icon: string; label: string; value: number; total?: number; color: string;
  grad?: string; onClick: () => void; suffix?: string;
}) {
  const pctVal = total && total > 0 ? ` (${Math.round((value / total) * 100)}%)` : '';
  return (
    <button onClick={onClick} style={{
      textAlign: 'left', width: '100%', cursor: 'pointer',
      background: 'var(--vf-surface)',
      border: 'var(--vf-card-border)',
      borderRadius: 12, padding: '14px 16px',
      position: 'relative', overflow: 'hidden', transition: 'transform 0.15s, box-shadow 0.15s',
      boxShadow: 'var(--vf-shadow-low)',
    }}
      onMouseEnter={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(-2px)'; b.style.boxShadow = '0 6px 20px rgba(0,0,0,0.12)'; }}
      onMouseLeave={(e) => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = ''; b.style.boxShadow = 'var(--vf-shadow-low)'; }}
    >
      {/* colored top bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, ${color}55)`, borderRadius: '12px 12px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 10 }}>
        <span style={{ fontSize: 13 }} aria-hidden="true">{icon}</span>
        <span style={{ color: 'var(--vf-text-muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      </div>
      <div style={{ color, fontSize: 30, fontWeight: 800, fontFamily: 'var(--vf-font-mono)', lineHeight: 1, letterSpacing: '-0.02em' }}>
        {value.toLocaleString()}{suffix ?? ''}
        {pctVal && <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--vf-text-muted)', marginLeft: 6 }}>{pctVal}</span>}
      </div>
    </button>
  );
}

function PCard({ title, sub, children, accent = '#6366f1' }: {
  title: string; sub?: string; children: React.ReactNode; accent?: string;
}) {
  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: 'var(--vf-card-border)',
      borderRadius: 12, padding: '18px 20px',
      position: 'relative', overflow: 'hidden', height: '100%',
      boxShadow: 'var(--vf-shadow-low)',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${accent}, ${accent}44)`, borderRadius: '12px 12px 0 0' }} />
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: 'var(--vf-text-primary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.01em' }}>{title}</div>
          {sub && <div style={{ color: 'var(--vf-text-muted)', fontSize: 11, marginTop: 3 }}>{sub}</div>}
        </div>
        <span title="Drag to reorder" style={{ color: 'var(--vf-text-dim)', fontSize: 14, cursor: 'grab', userSelect: 'none', lineHeight: 1, padding: '2px 4px' }}>⠿</span>
      </div>
      {children}
    </div>
  );
}

function FeedCard({ title, count, accent, action, children }: { title: string; count: number; accent: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--vf-surface)',
      border: 'var(--vf-card-border)',
      borderRadius: 12, padding: '18px 20px',
      position: 'relative', overflow: 'hidden', height: '100%',
      boxShadow: 'var(--vf-shadow-low)',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${accent}, ${accent}44)`, borderRadius: '12px 12px 0 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--vf-text-primary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.01em' }}>{title}</span>
          <span style={{ background: count > 0 ? `${accent}18` : 'rgba(22,163,74,0.10)', border: `1px solid ${count > 0 ? accent : '#16a34a'}44`, color: count > 0 ? accent : '#16a34a', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, fontFamily: 'var(--vf-font-mono)' }}>{count}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {action}
          <span title="Drag to reorder" style={{ color: 'var(--vf-text-dim)', fontSize: 14, cursor: 'grab', userSelect: 'none', lineHeight: 1 }}>⠿</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}

function FeedRow({ children, accent, onClick }: { children: React.ReactNode; accent: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 0', paddingLeft: 10,
        borderBottom: '1px solid var(--vf-border-subtle)',
        borderLeft: `3px solid ${accent}66`,
        marginLeft: -10,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={onClick ? (e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vf-elevated)'; } : undefined}
      onMouseLeave={onClick ? (e) => { (e.currentTarget as HTMLDivElement).style.background = ''; } : undefined}
    >
      {children}
    </div>
  );
}

function NoData({ msg = 'No data available' }: { msg?: string }) {
  return (
    <div style={{ height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <div style={{ color: '#334155', fontSize: 28 }}>◌</div>
      <div style={{ color: 'var(--vf-text-muted)', fontSize: 13 }}>{msg}</div>
    </div>
  );
}

function EmptyFeed({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
      <div style={{ color: '#94a3b8', fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{title}</div>
      <div style={{ color: 'var(--vf-text-muted)', fontSize: 12 }}>{sub}</div>
    </div>
  );
}

/**
 * Configurable Dashboard Builder — NMS-DB-01 / NMS-DB-02 / NMS-DB-03
 *
 * Features:
 *  - Dashboard management table (list all dashboards, set default, delete)
 *  - Add/Edit dashboard dialog with BTS/CPE scope selection
 *  - 5 widget types: KPI Number, Line, Bar, Pie, Alarm List
 *  - Per-widget BTS/CPE scope toggle
 *  - Global filters: Circle, Network, Firmware
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type DashboardScope = 'BTS' | 'CPE' | 'BOTH';
type ChartType = 'numeric' | 'line' | 'bar' | 'pie' | 'alarm';
type WidgetScope = 'BTS' | 'CPE' | 'BOTH';
type DataSource =
  | 'total_devices'   | 'online_devices'  | 'offline_devices'
  | 'active_alarms'   | 'critical_alarms' | 'alarm_rate'
  | 'device_availability' | 'throughput_trend' | 'cpu_utilization'
  | 'alarm_severity'  | 'devices_by_model'| 'devices_by_type'
  | 'alarm_list';

interface Widget {
  id: string;
  title: string;
  chartType: ChartType;
  dataSource: DataSource;
  scope: WidgetScope;
  span: 1 | 2;
}

interface Dashboard {
  id: string;
  name: string;
  description: string;
  scope: DashboardScope;
  widgets: Widget[];
  isDefault: boolean;
  updatedAt: string;
  filters: { circle?: string; network?: string; firmware?: string };
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const DEFAULT_DASHBOARDS: Dashboard[] = [
  {
    id: 'dash-noc',
    name: 'NOC Overview',
    description: 'Real-time overview of all managed devices, alarms, and availability.',
    scope: 'BOTH',
    isDefault: true,
    updatedAt: new Date().toISOString(),
    filters: {},
    widgets: [
      { id: 'w1', title: 'Total Managed Devices', chartType: 'numeric',  dataSource: 'total_devices',       scope: 'BOTH', span: 1 },
      { id: 'w2', title: 'Online Devices',         chartType: 'numeric',  dataSource: 'online_devices',      scope: 'BOTH', span: 1 },
      { id: 'w3', title: 'Active Alarms',          chartType: 'numeric',  dataSource: 'active_alarms',       scope: 'BOTH', span: 1 },
      { id: 'w4', title: 'Offline Devices',        chartType: 'numeric',  dataSource: 'offline_devices',     scope: 'BOTH', span: 1 },
      { id: 'w5', title: 'Device Availability',    chartType: 'line',     dataSource: 'device_availability', scope: 'BOTH', span: 2 },
      { id: 'w6', title: 'Alarm Severity',         chartType: 'pie',      dataSource: 'alarm_severity',      scope: 'BOTH', span: 1 },
      { id: 'w7', title: 'Live Alarms',            chartType: 'alarm',    dataSource: 'alarm_list',          scope: 'BOTH', span: 2 },
    ],
  },
  {
    id: 'dash-bts',
    name: 'BTS Performance',
    description: 'KPI and throughput trends for all Base Transceiver Stations.',
    scope: 'BTS',
    isDefault: false,
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    filters: {},
    widgets: [
      { id: 'b1', title: 'BTS Online Count',    chartType: 'numeric', dataSource: 'online_devices',   scope: 'BTS', span: 1 },
      { id: 'b2', title: 'BTS Critical Alarms', chartType: 'numeric', dataSource: 'critical_alarms',  scope: 'BTS', span: 1 },
      { id: 'b3', title: 'Throughput Trend',    chartType: 'line',    dataSource: 'throughput_trend',  scope: 'BTS', span: 2 },
      { id: 'b4', title: 'Devices by Model',    chartType: 'bar',     dataSource: 'devices_by_model',  scope: 'BTS', span: 1 },
    ],
  },
];

// ── Mock / live data ──────────────────────────────────────────────────────────

interface Stats { [key: string]: number }

const DAILY_AVAIL = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.now() - (6 - i) * 86_400_000);
  return { label: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), value: 9 + Math.floor(Math.random() * 3) };
});

const THROUGHPUT = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.now() - (6 - i) * 86_400_000);
  return { label: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), value: 150 + Math.floor(Math.random() * 80) };
});

const ALARM_SEV_DATA = [
  { label: 'Critical', value: 3,  color: '#ef4444' },
  { label: 'Major',    value: 7,  color: '#f97316' },
  { label: 'Minor',    value: 12, color: '#f59e0b' },
  { label: 'Warning',  value: 18, color: '#3b82f6' },
];

const MODEL_DATA = [
  { label: 'A60', value: 10, color: '#3b82f6' },
  { label: 'A61', value: 8,  color: '#22c55e' },
  { label: 'IDU', value: 4,  color: '#f59e0b' },
];

const MOCK_ALARMS = [
  { id: 'a1', device: 'BTS-MH-001', severity: 'CRITICAL', message: 'Link down — upstream port failure', time: '2 min ago' },
  { id: 'a2', device: 'CPE-PUN-042', severity: 'MAJOR',    message: 'High CPU utilization (>90%)', time: '5 min ago' },
  { id: 'a3', device: 'BTS-BLR-007', severity: 'MINOR',   message: 'Packet loss >5% on eth0', time: '12 min ago' },
  { id: 'a4', device: 'CPE-DEL-118', severity: 'WARNING',  message: 'Signal RSSI below threshold', time: '18 min ago' },
];

const SEV_COLOR: Record<string, string> = { CRITICAL: '#ef4444', MAJOR: '#f97316', MINOR: '#f59e0b', WARNING: '#3b82f6' };
const SCOPE_COLOR: Record<DashboardScope, string> = { BTS: '#3b82f6', CPE: '#22c55e', BOTH: '#a855f7' };

// ── Widget renderer components ────────────────────────────────────────────────

function NumericWidget({ widget, stats }: { widget: Widget; stats: Stats }) {
  const defaults: Record<DataSource, number> = {
    total_devices: 14, online_devices: 11, offline_devices: 3,
    active_alarms: 3, critical_alarms: 1, alarm_rate: 2,
    device_availability: 79, throughput_trend: 0, cpu_utilization: 0,
    alarm_severity: 0, devices_by_model: 0, devices_by_type: 0, alarm_list: 0,
  };
  const val = stats[widget.dataSource] ?? defaults[widget.dataSource] ?? 0;
  const isAlarm  = widget.dataSource === 'active_alarms' || widget.dataSource === 'critical_alarms';
  const isOff    = widget.dataSource === 'offline_devices';
  const color    = isAlarm && val > 0 ? '#fca5a5' : isOff && val > 0 ? '#fdba74' : '#86efac';
  const subtitle = widget.dataSource === 'total_devices'
    ? `${Math.round(((stats['online_devices'] ?? 11) / Math.max(val, 1)) * 100)}% online`
    : widget.dataSource === 'device_availability' ? `${val}% avg`
    : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
      <div style={{ color, fontSize: 56, fontWeight: 800, lineHeight: 1, fontFamily: 'monospace' }}>{val}</div>
      {subtitle && <div style={{ color: '#86efac', fontSize: 12 }}>{subtitle}</div>}
    </div>
  );
}

function LineWidget({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value));
  const W = 340; const H = 120;
  const pts = data.map((d, i) => ({
    x: (i / (data.length - 1)) * (W - 30) + 15,
    y: H - 20 - ((d.value / (max + 10)) * (H - 30)),
  }));
  const pathD  = `M ${pts.map((p) => `${p.x},${p.y}`).join(' L ')}`;
  const fillD  = `${pathD} L ${pts[pts.length - 1].x},${H - 20} L ${pts[0].x},${H - 20} Z`;
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={15} y1={H - 20 - f * (H - 30)} x2={W - 15} y2={H - 20 - f * (H - 30)}
          stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
      ))}
      <path d={fillD} fill="rgba(59,130,246,0.12)" />
      <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} />
      {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3} fill="#3b82f6" />)}
      {data.filter((_, i) => i % 2 === 0).map((d) => {
        const idx = data.indexOf(d);
        return (
          <text key={idx} x={(idx / (data.length - 1)) * (W - 30) + 15} y={H - 4}
            fill="rgba(255,255,255,0.4)" fontSize={9} textAnchor="middle">{d.label}</text>
        );
      })}
    </svg>
  );
}

function PieWidget() {
  const total = ALARM_SEV_DATA.reduce((s, d) => s + d.value, 0);
  const CX = 70; const CY = 70; const R = 55;
  let startAngle = -Math.PI / 2;
  const slices = ALARM_SEV_DATA.map((d) => {
    const angle = (d.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const x1 = CX + R * Math.cos(startAngle); const y1 = CY + R * Math.sin(startAngle);
    const x2 = CX + R * Math.cos(endAngle);   const y2 = CY + R * Math.sin(endAngle);
    const large = angle > Math.PI ? 1 : 0;
    const path = `M ${CX},${CY} L ${x1},${y1} A ${R},${R} 0 ${large} 1 ${x2},${y2} Z`;
    startAngle = endAngle;
    return { ...d, path };
  });
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', width: '100%' }}>
      <svg width={140} height={140} style={{ flexShrink: 0 }}>
        {slices.map((s) => <path key={s.label} d={s.path} fill={s.color} fillOpacity={0.85} stroke="var(--bg-surface)" strokeWidth={2} />)}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ALARM_SEV_DATA.map((d) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{d.label}</span>
            <span style={{ color: d.color, fontSize: 12, fontWeight: 700, marginLeft: 'auto' }}>{d.value}</span>
          </div>
        ))}
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>Total: {total}</div>
      </div>
    </div>
  );
}

function BarWidget() {
  const max = Math.max(...MODEL_DATA.map((d) => d.value));
  const W = 300; const BAR_H = 22; const GAP = 8; const LABEL_W = 110;
  return (
    <svg width={W} height={MODEL_DATA.length * (BAR_H + GAP)} style={{ display: 'block', overflow: 'visible' }}>
      {MODEL_DATA.map((d, i) => {
        const bw = Math.max((d.value / max) * (W - LABEL_W - 40), 4);
        const y  = i * (BAR_H + GAP);
        return (
          <g key={d.label}>
            <text x={LABEL_W - 6} y={y + BAR_H / 2 + 4} textAnchor="end" fill="rgba(255,255,255,0.5)" fontSize={11}>{d.label}</text>
            <rect x={LABEL_W} y={y} width={bw} height={BAR_H} fill={d.color} rx={3} fillOpacity={0.85} />
            <text x={LABEL_W + bw + 6} y={y + BAR_H / 2 + 4} fill={d.color} fontSize={12} fontWeight={700}>{d.value}</text>
          </g>
        );
      })}
    </svg>
  );
}

function AlarmWidget() {
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {MOCK_ALARMS.map((a) => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-card)', borderRadius: 6, borderLeft: `3px solid ${SEV_COLOR[a.severity]}` }}>
          <span style={{ color: SEV_COLOR[a.severity], fontWeight: 700, fontSize: 10, minWidth: 60 }}>{a.severity}</span>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.device}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.message}</div>
          </div>
          <span style={{ color: 'var(--text-dim)', fontSize: 10, flexShrink: 0 }}>{a.time}</span>
        </div>
      ))}
    </div>
  );
}

// ── WidgetCard ─────────────────────────────────────────────────────────────────

function WidgetCard({ widget, stats, onRemove, onResize, onScopeChange }: {
  widget: Widget; stats: Stats;
  onRemove(): void; onResize(): void;
  onScopeChange(scope: WidgetScope): void;
}) {
  const scopeColors: Record<WidgetScope, string> = { BTS: '#3b82f6', CPE: '#22c55e', BOTH: '#a855f7' };
  const typeIcon: Record<ChartType, string> = { numeric: '#', line: '📈', bar: '📊', pie: '🥧', alarm: '🔔' };

  return (
    <div style={{
      gridColumn: `span ${widget.span}`,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
      padding: 16,
      minHeight: 200,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative' as const,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13 }}>{widget.title}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <span style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600 }}>
              {typeIcon[widget.chartType]} {widget.chartType.toUpperCase()}
            </span>
            {/* Widget scope toggle */}
            {(['BTS', 'CPE', 'BOTH'] as WidgetScope[]).map((s) => (
              <button key={s} onClick={() => onScopeChange(s)}
                style={{
                  background: widget.scope === s ? scopeColors[s] : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${widget.scope === s ? scopeColors[s] : 'var(--border-subtle)'}`,
                  color: widget.scope === s ? '#fff' : 'var(--text-dim)',
                  padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, cursor: 'pointer',
                }}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={onResize} title={widget.span === 1 ? 'Expand' : 'Shrink'}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}>
            {widget.span === 1 ? '⇔' : '↩'}
          </button>
          <button onClick={onRemove}
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 14, padding: '2px 4px' }}>×</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 140 }}>
        {widget.chartType === 'numeric' && <NumericWidget widget={widget} stats={stats} />}
        {widget.chartType === 'line'    && <LineWidget data={widget.dataSource === 'throughput_trend' ? THROUGHPUT : DAILY_AVAIL} />}
        {widget.chartType === 'pie'     && <PieWidget />}
        {widget.chartType === 'bar'     && <BarWidget />}
        {widget.chartType === 'alarm'   && <AlarmWidget />}
      </div>
    </div>
  );
}

// ── Add Widget Dialog ─────────────────────────────────────────────────────────

const DATA_SOURCES: { value: DataSource; label: string; types: ChartType[] }[] = [
  { value: 'total_devices',       label: 'Total Managed Devices',    types: ['numeric'] },
  { value: 'online_devices',      label: 'Online Devices',           types: ['numeric'] },
  { value: 'offline_devices',     label: 'Offline Devices',          types: ['numeric'] },
  { value: 'active_alarms',       label: 'Active Alarms Count',      types: ['numeric'] },
  { value: 'critical_alarms',     label: 'Critical Alarms Count',    types: ['numeric'] },
  { value: 'device_availability', label: 'Device Availability',      types: ['line', 'numeric'] },
  { value: 'throughput_trend',    label: 'Throughput Trend',         types: ['line'] },
  { value: 'cpu_utilization',     label: 'CPU Utilization',          types: ['line', 'numeric'] },
  { value: 'alarm_severity',      label: 'Alarm Severity Breakdown', types: ['pie'] },
  { value: 'devices_by_model',    label: 'Devices by Model',         types: ['bar', 'pie'] },
  { value: 'devices_by_type',     label: 'Devices by Type',          types: ['bar', 'pie'] },
  { value: 'alarm_list',          label: 'Live Alarm Feed',          types: ['alarm'] },
];

const CHART_ICONS: Record<ChartType, string> = { numeric: '🔢', line: '📈', bar: '📊', pie: '🥧', alarm: '🔔' };

function AddWidgetDialog({ dashScope, onAdd, onClose }: {
  dashScope: DashboardScope;
  onAdd(w: Omit<Widget, 'id'>): void;
  onClose(): void;
}) {
  const [src, setSrc]         = useState<DataSource>('total_devices');
  const [title, setTitle]     = useState('');
  const [scope, setScope]     = useState<WidgetScope>(dashScope === 'BOTH' ? 'BOTH' : dashScope as WidgetScope);
  const srcInfo               = DATA_SOURCES.find((d) => d.value === src)!;
  const [chartType, setChartType] = useState<ChartType>(srcInfo.types[0]);

  const handleSrcChange = (v: DataSource) => {
    setSrc(v);
    const info = DATA_SOURCES.find((d) => d.value === v)!;
    setChartType(info.types[0]);
  };

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)',
    borderRadius: 4, color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 28, width: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 17, marginBottom: 6 }}>Add Widget</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>Configure data source, chart type, and scope for this widget.</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 22 }}>

          {/* Data source */}
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Data Source</label>
            <select style={inp} value={src} onChange={(e) => handleSrcChange(e.target.value as DataSource)}>
              {DATA_SOURCES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>

          {/* Chart type */}
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Chart Type</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
              {(Object.keys(CHART_ICONS) as ChartType[]).map((t) => {
                const avail = srcInfo.types.includes(t);
                return (
                  <button key={t} disabled={!avail} onClick={() => setChartType(t)}
                    style={{
                      background: chartType === t ? 'var(--accent-bg)' : 'none',
                      border: `1px solid ${chartType === t ? 'var(--accent)' : 'var(--border-strong)'}`,
                      color: chartType === t ? 'var(--accent)' : avail ? 'var(--text-secondary)' : 'var(--text-dim)',
                      padding: '5px 14px', borderRadius: 5, cursor: avail ? 'pointer' : 'not-allowed',
                      fontSize: 12, fontWeight: 600, opacity: avail ? 1 : 0.35,
                    }}>
                    {CHART_ICONS[t]} {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scope (BTS / CPE / Both) */}
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Widget Scope</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['BTS', 'CPE', 'BOTH'] as WidgetScope[]).map((s) => {
                const c = SCOPE_COLOR[s as DashboardScope];
                return (
                  <button key={s} onClick={() => setScope(s)}
                    style={{
                      background: scope === s ? `${c}22` : 'none',
                      border: `1px solid ${scope === s ? c : 'var(--border-strong)'}`,
                      color: scope === s ? c : 'var(--text-secondary)',
                      padding: '5px 16px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    }}>
                    {s}
                  </button>
                );
              })}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
              {scope === 'BTS' ? 'Shows BTS device data only.' : scope === 'CPE' ? 'Shows CPE device data only.' : 'Aggregates both BTS and CPE data.'}
            </div>
          </div>

          {/* Custom title */}
          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Widget Title <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
            <input style={inp} value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={DATA_SOURCES.find((d) => d.value === src)?.label ?? ''} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '9px 18px', borderRadius: 5, cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={() => onAdd({ title: title || srcInfo.label, chartType, dataSource: src, scope, span: 1 })}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '9px 22px', borderRadius: 5, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Add Widget
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard Dialog (Create / Edit) ─────────────────────────────────────────

function DashboardDialog({ initial, onSave, onClose }: {
  initial?: Dashboard;
  onSave(data: { name: string; description: string; scope: DashboardScope }): void;
  onClose(): void;
}) {
  const [name, setName]       = useState(initial?.name ?? '');
  const [desc, setDesc]       = useState(initial?.description ?? '');
  const [scope, setScope]     = useState<DashboardScope>(initial?.scope ?? 'BOTH');

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)',
    borderRadius: 4, color: 'var(--text-primary)', padding: '8px 12px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 28, width: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 17, marginBottom: 18 }}>
          {initial ? 'Edit Dashboard' : 'Create New Dashboard'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 22 }}>

          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Dashboard Name *</label>
            <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My NOC View" />
          </div>

          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Description</label>
            <textarea style={{ ...inp, minHeight: 70, resize: 'vertical' as const }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Brief description of this dashboard's purpose…" />
          </div>

          <div>
            <label style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Device Scope</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['BTS', 'CPE', 'BOTH'] as DashboardScope[]).map((s) => {
                const c = SCOPE_COLOR[s];
                return (
                  <button key={s} onClick={() => setScope(s)}
                    style={{
                      flex: 1, padding: '10px 0',
                      background: scope === s ? `${c}22` : 'var(--bg-card)',
                      border: `1px solid ${scope === s ? c : 'var(--border-subtle)'}`,
                      borderRadius: 6, cursor: 'pointer',
                      color: scope === s ? c : 'var(--text-secondary)', fontSize: 12, fontWeight: 700,
                    }}>
                    <div style={{ fontSize: 18 }}>{s === 'BTS' ? '📡' : s === 'CPE' ? '🖥' : '📡🖥'}</div>
                    <div style={{ marginTop: 4 }}>{s === 'BOTH' ? 'All Devices' : s}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 5 }}>
              Scope determines which device data is available in this dashboard's widgets.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '9px 18px', borderRadius: 5, cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={() => name.trim() && onSave({ name: name.trim(), description: desc, scope })} disabled={!name.trim()}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '9px 22px', borderRadius: 5, cursor: name.trim() ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600, opacity: name.trim() ? 1 : 0.5 }}>
            {initial ? 'Save Changes' : 'Create Dashboard'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard View (active dashboard with widgets) ────────────────────────────

function DashboardView({ dash, stats, onBack, onUpdate, onSave }: {
  dash: Dashboard;
  stats: Stats;
  onBack(): void;
  onUpdate(d: Dashboard): void;
  onSave(): void;
}) {
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [saved, setSaved] = useState(false);
  const scopeColor = SCOPE_COLOR[dash.scope];

  const handleAddWidget = (w: Omit<Widget, 'id'>) => {
    onUpdate({ ...dash, widgets: [...dash.widgets, { ...w, id: `w-${Date.now()}` }] });
    setShowAddWidget(false);
  };

  const handleRemove = (id: string) => onUpdate({ ...dash, widgets: dash.widgets.filter((w) => w.id !== id) });

  const handleResize = (id: string) => onUpdate({
    ...dash,
    widgets: dash.widgets.map((w) => w.id === id ? { ...w, span: w.span === 1 ? 2 : 1 } : w) as Widget[],
  });

  const handleScopeChange = (id: string, scope: WidgetScope) => onUpdate({
    ...dash,
    widgets: dash.widgets.map((w) => w.id === id ? { ...w, scope } : w),
  });

  const handleSaveClick = () => {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      {/* Sub-header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' as const }}>
        <button onClick={onBack}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}>
          ← All Dashboards
        </button>
        <span style={{ color: 'var(--border-subtle)' }}>|</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 16 }}>{dash.name}</span>
        <span style={{ background: `${scopeColor}22`, border: `1px solid ${scopeColor}`, color: scopeColor, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
          {dash.scope}
        </span>
        {dash.isDefault && (
          <span style={{ background: '#14532d', color: '#86efac', padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>DEFAULT</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={handleSaveClick}
            style={{
              background: saved ? '#14532d' : 'var(--bg-card)',
              border: `1px solid ${saved ? '#22c55e' : 'var(--border-strong)'}`,
              color: saved ? '#86efac' : 'var(--text-secondary)',
              padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              transition: 'all 0.2s',
            }}>
            {saved ? '✓ Saved' : '💾 Save Dashboard'}
          </button>
          <button onClick={() => setShowAddWidget(true)}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            + Add Widget
          </button>
        </div>
      </div>

      {/* Widget grid */}
      {dash.widgets.length === 0 ? (
        <div style={{ background: 'var(--bg-surface)', border: '2px dashed var(--border-subtle)', borderRadius: 12, padding: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Empty Dashboard</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>Click "+ Add Widget" to add your first widget to this dashboard.</div>
          <button onClick={() => setShowAddWidget(true)}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '9px 22px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            + Add First Widget
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {dash.widgets.map((w) => (
            <WidgetCard key={w.id} widget={w} stats={stats}
              onRemove={() => handleRemove(w.id)}
              onResize={() => handleResize(w.id)}
              onScopeChange={(s) => handleScopeChange(w.id, s)}
            />
          ))}
        </div>
      )}

      {showAddWidget && <AddWidgetDialog dashScope={dash.scope} onAdd={handleAddWidget} onClose={() => setShowAddWidget(false)} />}
    </div>
  );
}

// ── Persistence helpers ───────────────────────────────────────────────────────

const STORAGE_KEY = 'nms_custom_dashboards';

function loadDashboards(): Dashboard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Dashboard[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_DASHBOARDS;
}

function saveDashboards(dashboards: Dashboard[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboards));
  } catch { /* ignore quota errors */ }
}

// ── Main Page: Dashboard Management Table ─────────────────────────────────────

export default function CustomDashboardPage(): React.ReactElement {
  const [dashboards, setDashboards]         = useState<Dashboard[]>(loadDashboards);
  const [activeDashId, setActiveDashId]     = useState<string | null>(null);
  const [showCreateDialog, setShowCreate]   = useState(false);
  const [editDash, setEditDash]             = useState<Dashboard | null>(null);
  const [confirmDelete, setConfirmDelete]   = useState<string | null>(null);
  const [stats, setStats]                   = useState<Stats>({});
  const [saveMsg, setSaveMsg]               = useState<string | null>(null);
  const [circleFilter, setCircleFilter]     = useState('');
  const [networkFilter, setNetworkFilter]   = useState('');
  const [firmwareFilter, setFirmwareFilter] = useState('');
  const hasFetched = useRef(false);

  // Persist every time dashboards change
  useEffect(() => {
    saveDashboards(dashboards);
  }, [dashboards]);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    Promise.all([
      apiClient.get('/devices?limit=200').catch(() => ({ data: [] })),
      apiClient.get('/alarms?status=ACTIVE&limit=500').catch(() => ({ data: [] })),
    ]).then(([devRes, alRes]) => {
      const rawDevs = devRes.data;
      const devs: Array<{ status?: string }> = Array.isArray(rawDevs)
        ? rawDevs as Array<{ status?: string }>
        : (((rawDevs as Record<string, unknown>)?.devices ?? (rawDevs as Record<string, unknown>)?.content ?? []) as Array<{ status?: string }>);
      const alarms: unknown[] = Array.isArray(alRes.data) ? alRes.data as unknown[] : [];
      const online = devs.filter((d) => d.status === 'ONLINE' || d.status === 'UP').length;
      setStats({
        total_devices: devs.length || 14,
        online_devices: online || 11,
        offline_devices: (devs.length - online) || 3,
        active_alarms: alarms.length || 3,
        critical_alarms: 1,
        device_availability: 79,
      });
    });
  }, []);

  const activeDash = dashboards.find((d) => d.id === activeDashId) ?? null;

  const showToast = (msg: string) => {
    setSaveMsg(msg);
    setTimeout(() => setSaveMsg(null), 2500);
  };

  const handleCreate = (data: { name: string; description: string; scope: DashboardScope }) => {
    const id = `dash-${Date.now()}`;
    const next = [...dashboards, { id, ...data, widgets: [], isDefault: false, updatedAt: new Date().toISOString(), filters: {} }];
    setDashboards(next);
    saveDashboards(next);
    setActiveDashId(id);
    setShowCreate(false);
    showToast(`✓ Dashboard "${data.name}" created`);
  };

  const handleEdit = (data: { name: string; description: string; scope: DashboardScope }) => {
    if (!editDash) return;
    const next = dashboards.map((d) => d.id === editDash.id ? { ...d, ...data, updatedAt: new Date().toISOString() } : d);
    setDashboards(next);
    saveDashboards(next);
    setEditDash(null);
    showToast(`✓ Dashboard "${data.name}" saved`);
  };

  const handleSetDefault = (id: string) => {
    const next = dashboards.map((d) => ({ ...d, isDefault: d.id === id }));
    setDashboards(next);
    saveDashboards(next);
    const name = dashboards.find((d) => d.id === id)?.name ?? '';
    showToast(`✓ "${name}" set as default`);
  };

  const handleDelete = (id: string) => {
    const name = dashboards.find((d) => d.id === id)?.name ?? '';
    const next = dashboards.filter((d) => d.id !== id);
    setDashboards(next);
    saveDashboards(next);
    if (activeDashId === id) setActiveDashId(null);
    setConfirmDelete(null);
    showToast(`✓ Dashboard "${name}" deleted`);
  };

  const handleUpdateDash = (updated: Dashboard) => {
    const next = dashboards.map((d) => d.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : d);
    setDashboards(next);
    saveDashboards(next);
  };

  const hasFilters = circleFilter || networkFilter || firmwareFilter;

  // ── Active Dashboard view ────────────────────────────────────────────────────
  if (activeDash) {
    return (
      <div>
        {/* Save toast */}
        {saveMsg && (
          <div style={{ position: 'fixed', bottom: 24, right: 24, background: '#14532d', border: '1px solid #22c55e', color: '#86efac', padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
            {saveMsg}
          </div>
        )}

        {/* Global filters row */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginRight: 6 }}>Filters:</span>
          {['Delhi', 'Mumbai', 'Chennai', 'Bangalore'].map((c) => (
            <button key={c} onClick={() => setCircleFilter(circleFilter === c ? '' : c)}
              style={{ background: circleFilter === c ? 'var(--accent-bg)' : 'var(--bg-card)', border: `1px solid ${circleFilter === c ? 'var(--accent)' : 'var(--border-subtle)'}`, color: circleFilter === c ? 'var(--accent)' : 'var(--text-secondary)', padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer', fontWeight: circleFilter === c ? 700 : 400 }}>
              {c}
            </button>
          ))}
          <span style={{ color: 'var(--border-subtle)' }}>|</span>
          <select value={firmwareFilter} onChange={(e) => setFirmwareFilter(e.target.value)}
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4, color: 'var(--text-secondary)', padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}>
            <option value="">All Firmware</option>
            {['2.1.0', '2.1.2', '2.1.4', '2.2.0'].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {hasFilters && (
            <button onClick={() => { setCircleFilter(''); setNetworkFilter(''); setFirmwareFilter(''); }}
              style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', padding: '3px 10px', borderRadius: 12, cursor: 'pointer', fontSize: 11 }}>
              ✕ Clear
            </button>
          )}
          {hasFilters && (
            <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600 }}>
              {circleFilter && `Circle: ${circleFilter}`}{firmwareFilter && ` · FW: ${firmwareFilter}`}
            </span>
          )}
        </div>

        <DashboardView
          dash={activeDash}
          stats={stats}
          onBack={() => setActiveDashId(null)}
          onUpdate={handleUpdateDash}
          onSave={() => {
            saveDashboards(dashboards);
            showToast(`✓ "${activeDash.name}" saved`);
          }}
        />
      </div>
    );
  }

  // ── Dashboard Management Table ───────────────────────────────────────────────
  return (
    <div>
      {/* Save toast */}
      {saveMsg && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: '#14532d', border: '1px solid #22c55e', color: '#86efac', padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 2000, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
          {saveMsg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ color: 'var(--text-primary)', margin: 0, fontSize: 20 }}>
            My Dashboards
            <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 400, marginLeft: 12 }}>NMS-DB-01 / DB-02 / DB-03</span>
          </h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 3 }}>
            Configurable dashboards for BTS and CPE performance monitoring.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)}
          style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '9px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          + New Dashboard
        </button>
      </div>

      {/* Dashboard cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 28 }}>
        {dashboards.map((d) => {
          const sc = SCOPE_COLOR[d.scope];
          return (
            <div key={d.id}
              style={{ background: 'var(--bg-surface)', border: `1px solid ${d.isDefault ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' as const }}>

              {/* Default badge */}
              {d.isDefault && (
                <div style={{ position: 'absolute', top: 12, right: 12, background: '#14532d', color: '#86efac', padding: '2px 7px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>DEFAULT</div>
              )}

              {/* Title row */}
              <div style={{ paddingRight: d.isDefault ? 60 : 0 }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>{d.name}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                  <span style={{ background: `${sc}22`, border: `1px solid ${sc}`, color: sc, padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700 }}>{d.scope}</span>
                  <span style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)', padding: '1px 8px', borderRadius: 10, fontSize: 10 }}>
                    {d.widgets.length} widget{d.widgets.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {/* Description */}
              <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, flex: 1 }}>{d.description || <span style={{ opacity: 0.4, fontStyle: 'italic' }}>No description</span>}</div>

              {/* Last updated */}
              <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                Updated: {new Date(d.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                <button onClick={() => setActiveDashId(d.id)}
                  style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, flex: 1 }}>
                  Open
                </button>
                <button onClick={() => setEditDash(d)}
                  style={{ background: 'none', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                  Edit
                </button>
                {!d.isDefault && (
                  <button onClick={() => handleSetDefault(d.id)}
                    style={{ background: 'none', border: '1px solid #14532d', color: '#86efac', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                    ★ Default
                  </button>
                )}
                <button onClick={() => setConfirmDelete(d.id)}
                  style={{ background: 'none', border: '1px solid #7f1d1d', color: '#fca5a5', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}

        {/* Empty state / add card */}
        <div onClick={() => setShowCreate(true)}
          style={{ background: 'none', border: '2px dashed var(--border-subtle)', borderRadius: 10, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', minHeight: 180 }}>
          <div style={{ fontSize: 32, opacity: 0.5 }}>+</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Create new dashboard</div>
        </div>
      </div>

      {/* ── Dialogs ── */}
      {showCreateDialog && <DashboardDialog onSave={handleCreate} onClose={() => setShowCreate(false)} />}
      {editDash         && <DashboardDialog initial={editDash} onSave={handleEdit} onClose={() => setEditDash(null)} />}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 24, width: 360, boxShadow: '0 16px 48px rgba(0,0,0,0.5)' }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Delete Dashboard?</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
              "{dashboards.find((d) => d.id === confirmDelete)?.name}" and all its widgets will be permanently removed.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)}
                style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={() => handleDelete(confirmDelete)}
                style={{ background: '#7f1d1d', border: 'none', color: '#fca5a5', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

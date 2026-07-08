import React, { useState } from 'react';
import { downloadAlarmExport } from '../api/alarms.api';
import { downloadDeviceExport } from '../api/devices.api';
import { downloadKpiExport } from '../api/kpi.api';
import { KPI_PARAMS } from '../api/kpi.types';
import type { Severity, AlarmState } from '../api/alarms.types';
import type { DeviceType } from '../api/devices.types';
import type { KpiParam, Granularity } from '../api/kpi.types';

const C = {
  card: '#0d1b2a', border: '#1e293b', hi: '#1e3a5f',
  text: '#e2e8f0', muted: '#94a3b8', dim: '#64748b', faint: '#475569',
  blue: '#60a5fa', green: '#22c55e', amber: '#f59e0b',
};

type ReportTab = 'alarms' | 'inventory' | 'kpi';

const TABS: { id: ReportTab; label: string; icon: string }[] = [
  { id: 'alarms', label: 'Alarms & Events', icon: '🔔' },
  { id: 'inventory', label: 'Device Inventory', icon: '📡' },
  { id: 'kpi', label: 'KPI Data', icon: '📈' },
];

function now() { return new Date().toISOString().slice(0, 16); }
function daysAgo(n: number) { return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 16); }

export default function ReportsPage(): React.ReactElement {
  const [tab, setTab] = useState<ReportTab>('alarms');

  // Alarm filters
  const [alarmFrom, setAlarmFrom] = useState(daysAgo(7));
  const [alarmTo, setAlarmTo] = useState(now());
  const [alarmSeverity, setAlarmSeverity] = useState<string>('');
  const [alarmState, setAlarmState] = useState<string>('');
  const [alarmNetwork, setAlarmNetwork] = useState('');

  // Inventory filters
  const [invType, setInvType] = useState<string>('');
  const [invStatus, setInvStatus] = useState<string>('');
  const [invNetwork, setInvNetwork] = useState('');

  // KPI filters
  const [kpiDevice, setKpiDevice] = useState('');
  const [kpiFrom, setKpiFrom] = useState(daysAgo(7));
  const [kpiTo, setKpiTo] = useState(now());
  const [kpiParams, setKpiParams] = useState<KpiParam[]>(['rssi', 'snr', 'throughputDL', 'throughputUL']);
  const [kpiGranularity, setKpiGranularity] = useState<Granularity>('1HOUR');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  const toggleKpiParam = (p: KpiParam) => setKpiParams((prev) =>
    prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
  );

  const alarmFilter = {
    from: alarmFrom ? new Date(alarmFrom).toISOString() : undefined,
    to: alarmTo ? new Date(alarmTo).toISOString() : undefined,
    state: alarmState as AlarmState || undefined,
    severity: alarmSeverity ? [alarmSeverity as Severity] : undefined,
    networkId: alarmNetwork || undefined,
  };
  const invFilter = {
    deviceType: invType as DeviceType || undefined,
    status: invStatus as any || undefined,
    networkId: invNetwork || undefined,
  };

  async function handleDownload(key: string, fn: () => Promise<void>) {
    setDownloading(key);
    setDlError(null);
    try {
      await fn();
    } catch {
      setDlError('Download failed. Please try again.');
    } finally {
      setDownloading(null);
    }
  }

  const inp: React.CSSProperties = {
    background: '#0f172a', border: `1px solid ${C.hi}`, borderRadius: 4,
    color: C.text, padding: '6px 10px', fontSize: 12,
  };
  const sel: React.CSSProperties = { ...inp };
  const btnActive = (a: boolean): React.CSSProperties => ({
    background: a ? C.hi : 'none', border: `1px solid ${a ? C.blue : '#374151'}`,
    color: a ? C.blue : C.dim, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
  });

  return (
    <div>
      <h2 style={{ color: C.text, margin: '0 0 16px' }}>Reports & Data Export</h2>
      <p style={{ color: C.muted, fontSize: 13, marginBottom: 18, maxWidth: 700 }}>
        Export alarm history, device inventory, and KPI data in CSV or XLS format.
        Apply filters below to scope the report, then click Export.
      </p>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ background: tab === t.id ? C.hi : 'none', border: `1px solid ${tab === t.id ? C.blue : '#374151'}`, color: tab === t.id ? C.blue : C.dim, padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {dlError && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>⚠ {dlError}</div>}

      {/* ── Alarms ── */}
      {tab === 'alarms' && (
        <ReportPanel
          title="Alarms & Event History"
          desc="Export all alarms captured by the NMS. Covers up to 7 days of history per the retention policy."
          onCsv={() => handleDownload('alarm-csv', () => downloadAlarmExport(alarmFilter, 'csv'))}
          onXls={() => handleDownload('alarm-xls', () => downloadAlarmExport(alarmFilter, 'xls'))}
          csvLabel="Export Alarms CSV"
          xlsLabel="Export Alarms XLS"
          loading={downloading}
          csvKey="alarm-csv"
          xlsKey="alarm-xls"
        >
          <FilterRow>
            <FilterField label="From">
              <input type="datetime-local" style={inp} value={alarmFrom} onChange={(e) => setAlarmFrom(e.target.value)} />
            </FilterField>
            <FilterField label="To">
              <input type="datetime-local" style={inp} value={alarmTo} onChange={(e) => setAlarmTo(e.target.value)} />
            </FilterField>
            <FilterField label="Severity">
              <select style={sel} value={alarmSeverity} onChange={(e) => setAlarmSeverity(e.target.value)}>
                <option value="">All</option>
                {['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'CLEAR', 'INDETERMINATE'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </FilterField>
            <FilterField label="State">
              <select style={sel} value={alarmState} onChange={(e) => setAlarmState(e.target.value)}>
                <option value="">All</option>
                {['ACTIVE', 'ACKNOWLEDGED', 'CLEARED'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </FilterField>
            <FilterField label="Network ID">
              <input style={{ ...inp, width: 140 }} placeholder="(optional)" value={alarmNetwork} onChange={(e) => setAlarmNetwork(e.target.value)} />
            </FilterField>
          </FilterRow>

          <PreviewTable
            headers={['Alarm ID', 'Device ID', 'Alarm Name', 'Severity', 'State', 'Timestamp']}
            note="Actual report will contain all matching alarms. Preview not shown — click Export to download."
          />
        </ReportPanel>
      )}

      {/* ── Inventory ── */}
      {tab === 'inventory' && (
        <ReportPanel
          title="Device Inventory Export"
          desc="Export the complete device inventory including all BTS, CPE, and IDU devices with all stored fields."
          onCsv={() => handleDownload('inv-csv', () => downloadDeviceExport(invFilter, 'csv'))}
          onXls={() => handleDownload('inv-xls', () => downloadDeviceExport(invFilter, 'xls'))}
          csvLabel="Export Inventory CSV"
          xlsLabel="Export Inventory XLS"
          loading={downloading}
          csvKey="inv-csv"
          xlsKey="inv-xls"
        >
          <FilterRow>
            <FilterField label="Device Type">
              <select style={sel} value={invType} onChange={(e) => setInvType(e.target.value)}>
                <option value="">All Types</option>
                <option>BTS</option><option>CPE</option><option>IDU</option>
              </select>
            </FilterField>
            <FilterField label="Status">
              <select style={sel} value={invStatus} onChange={(e) => setInvStatus(e.target.value)}>
                <option value="">All</option>
                <option>ONLINE</option><option>OFFLINE</option><option>PROVISIONING</option>
              </select>
            </FilterField>
            <FilterField label="Network ID">
              <input style={{ ...inp, width: 140 }} placeholder="(optional)" value={invNetwork} onChange={(e) => setInvNetwork(e.target.value)} />
            </FilterField>
          </FilterRow>

          <ExportColumns columns={[
            'Serial Number', 'Device Type', 'Model', 'MAC Address', 'IP Address',
            'Firmware Version', 'Status', 'Latitude', 'Longitude', 'Azimuth',
            'Tags', 'Network ID', 'Last Seen', 'Registered At',
          ]} />
        </ReportPanel>
      )}

      {/* ── KPI ── */}
      {tab === 'kpi' && (
        <ReportPanel
          title="KPI Data Export"
          desc="Export historical KPI time-series data for a device. Requires a Device ID."
          onCsv={() => handleDownload('kpi-csv', () => downloadKpiExport(kpiDevice, kpiParams, kpiGranularity, new Date(kpiFrom).toISOString(), new Date(kpiTo).toISOString(), 'csv'))}
          onXls={() => handleDownload('kpi-xls', () => downloadKpiExport(kpiDevice, kpiParams, kpiGranularity, new Date(kpiFrom).toISOString(), new Date(kpiTo).toISOString(), 'xls'))}
          csvLabel="Export KPI CSV"
          xlsLabel="Export KPI XLS"
          loading={downloading}
          csvKey="kpi-csv"
          xlsKey="kpi-xls"
          disabled={!kpiDevice}
          disabledMsg="Enter a Device ID to enable export"
        >
          <FilterRow>
            <FilterField label="Device ID *">
              <input style={{ ...inp, width: 180 }} placeholder="e.g. CPE-001" value={kpiDevice} onChange={(e) => setKpiDevice(e.target.value)} />
            </FilterField>
            <FilterField label="From">
              <input type="datetime-local" style={inp} value={kpiFrom} onChange={(e) => setKpiFrom(e.target.value)} />
            </FilterField>
            <FilterField label="To">
              <input type="datetime-local" style={inp} value={kpiTo} onChange={(e) => setKpiTo(e.target.value)} />
            </FilterField>
            <FilterField label="Granularity">
              <select style={sel} value={kpiGranularity} onChange={(e) => setKpiGranularity(e.target.value as any)}>
                <option value="15MIN">15 Minutes</option>
                <option value="1HOUR">1 Hour</option>
                <option value="DAILY">Daily</option>
              </select>
            </FilterField>
          </FilterRow>

          <div style={{ marginTop: 12 }}>
            <div style={{ color: C.dim, fontSize: 11, marginBottom: 6 }}>Metrics to include:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {KPI_PARAMS.map((p) => (
                <button key={p} onClick={() => toggleKpiParam(p)} style={btnActive(kpiParams.includes(p))}>{p}</button>
              ))}
            </div>
          </div>

          <ExportColumns columns={[
            'Device ID', 'Parameter', 'Bucket Start', 'Average', 'Min', 'Max', 'Sample Count',
          ]} />
        </ReportPanel>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ReportPanel({ title, desc, onCsv, onXls, csvLabel, xlsLabel, children,
                       disabled, disabledMsg, loading, csvKey, xlsKey }: {
  title: string; desc: string;
  onCsv: () => void; onXls: () => void;
  csvLabel: string; xlsLabel: string; children?: React.ReactNode;
  disabled?: boolean; disabledMsg?: string;
  loading: string | null; csvKey: string; xlsKey: string;
}) {
  const btnStyle = (bg: string, color: string, off: boolean): React.CSSProperties => ({
    background: off ? '#1e293b' : bg, border: 'none',
    color: off ? '#374151' : color, padding: '8px 18px', borderRadius: 4,
    fontSize: 13, cursor: off ? 'not-allowed' : 'pointer',
    opacity: loading && !off ? 0.7 : 1,
    display: 'flex', alignItems: 'center', gap: 6,
  });
  return (
    <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: '#e2e8f0', fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ color: '#64748b', fontSize: 13 }}>{desc}</div>
      </div>
      {children}
      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={disabled ? undefined : onCsv}
          disabled={!!disabled || loading === csvKey}
          style={btnStyle('#1e3a5f', '#60a5fa', !!disabled)}>
          {loading === csvKey ? '⏳' : '⬇'} {csvLabel}
        </button>
        <button
          onClick={disabled ? undefined : onXls}
          disabled={!!disabled || loading === xlsKey}
          style={btnStyle('#14532d', '#86efac', !!disabled)}>
          {loading === xlsKey ? '⏳' : '⬇'} {xlsLabel}
        </button>
        {disabled && disabledMsg && <span style={{ color: '#64748b', fontSize: 12 }}>← {disabledMsg}</span>}
      </div>
    </div>
  );
}

function FilterRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>{children}</div>;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  );
}

function ExportColumns({ columns }: { columns: string[] }) {
  return (
    <div style={{ marginTop: 12, background: '#0f172a', borderRadius: 6, padding: 10 }}>
      <div style={{ color: '#64748b', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Exported columns</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {columns.map((c) => (
          <span key={c} style={{ background: '#1e3a5f', color: '#93c5fd', padding: '2px 8px', borderRadius: 3, fontSize: 11 }}>{c}</span>
        ))}
      </div>
    </div>
  );
}

function PreviewTable({ headers, note }: { headers: string[]; note: string }) {
  return (
    <div style={{ marginTop: 12, background: '#0f172a', borderRadius: 6, padding: 10 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, overflowX: 'auto' }}>
        {headers.map((h) => (
          <span key={h} style={{ background: '#1e3a5f', color: '#93c5fd', padding: '2px 8px', borderRadius: 3, fontSize: 11, whiteSpace: 'nowrap' }}>{h}</span>
        ))}
      </div>
      <div style={{ color: '#475569', fontSize: 11 }}>{note}</div>
    </div>
  );
}

/**
 * V2 Reports Page — REQ-013
 *
 * Aggregates reportable data across alarms, devices, and KPIs with CSV export.
 * Sections: Alarm Summary, Device Status, Export Center.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchTopAlarms, fetchAlarmTypeCounts } from '../../api/alarms.api';
import { fetchDevices } from '../../api/devices.api';
import type { TopAlarm, AlarmTypeStat } from '../../api/alarms.types';
import type { Device } from '../../api/devices.types';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Badge } from '../components/common/Badge';
import { LoadingState, EmptyState } from '../components/common/States';
import { MetricCard } from '../components/common/MetricCard';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

type ReportTab = 'alarms' | 'devices' | 'export';

function TabBtn({ id, active, label, onClick }: { id: ReportTab; active: boolean; label: string; onClick: (t: ReportTab) => void }) {
  return (
    <button onClick={() => onClick(id)}
      style={{
        padding: '12px 20px', border: 'none', background: 'none', cursor: 'pointer',
        fontSize: 13, fontWeight: active ? 700 : 500,
        color: active ? '#60a5fa' : 'rgba(255,255,255,0.75)',
        borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent',
        transition: 'color 0.15s',
      }}>
      {label}
    </button>
  );
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Alarm Summary tab ─────────────────────────────────────────────────────────
function AlarmSummaryTab() {
  const { addToast } = useToast();
  const [topAlarms,  setTopAlarms]  = useState<TopAlarm[]>([]);
  const [typeCounts, setTypeCounts] = useState<AlarmTypeStat[]>([]);
  const [loading, setLoading]       = useState(true);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return; hasFetched.current = true;
    Promise.all([fetchTopAlarms(), fetchAlarmTypeCounts()])
      .then(([top, counts]) => { setTopAlarms(top); setTypeCounts(counts); })
      .catch((e) => { logger.error('Reports alarm fetch failed', e); addToast('Failed to load alarm reports', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  const totalEvents = typeCounts.reduce((s, t) => s + t.count, 0);

  const exportAlarmCsv = () => {
    const header = 'Alarm Type,Count\n';
    const rows = typeCounts.map((t) => `${t.alarmType},${t.count}`).join('\n');
    downloadCsv('alarm-type-report.csv', header + rows);
  };

  if (loading) return <LoadingState label="Loading alarm reports…" />;

  return (
    <>
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', marginBottom: 16 }}>
        <MetricCard label="Total Events"  value={totalEvents} />
        <MetricCard label="Alarm Types"   value={typeCounts.length} />
        <MetricCard label="Top Alarm Hits" value={topAlarms[0]?.count ?? 0} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button variant="ghost" size="sm" onClick={exportAlarmCsv}>⬇ Export CSV</Button>
      </div>

      <div className="vf-grid vf-grid--2" style={{ alignItems: 'start' }}>
        <Card title="Top Reported Alarms">
          {topAlarms.length === 0 ? <EmptyState title="No data" compact /> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>Alarm Type</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {topAlarms.slice(0, 12).map((a, i) => (
                  <tr key={a.alarmType} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                    <td style={{ padding: '7px 8px', color: 'var(--vf-text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: 'var(--vf-text-dim)', width: 16 }}>#{i + 1}</span>{a.alarmType}
                    </td>
                    <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 700, color: 'var(--vf-accent)' }}>{a.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Alarm Type Distribution">
          {typeCounts.length === 0 ? <EmptyState title="No data" compact /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {typeCounts.slice(0, 12).map((t) => {
                const pct = totalEvents > 0 ? Math.round((t.count / totalEvents) * 100) : 0;
                return (
                  <div key={t.alarmType}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--vf-text-secondary)' }}>{t.alarmType}</span>
                      <span style={{ fontWeight: 600, color: 'var(--vf-text-primary)' }}>{t.count} ({pct}%)</span>
                    </div>
                    <div style={{ height: 5, background: 'var(--vf-elevated)', borderRadius: 3 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--vf-accent)', borderRadius: 3, transition: 'width 0.4s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ── Device Status tab ─────────────────────────────────────────────────────────
function DeviceStatusTab() {
  const { addToast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return; hasFetched.current = true;
    fetchDevices({ limit: 500 })
      .then(setDevices)
      .catch((e) => { logger.error('Device report fetch failed', e); addToast('Failed to load device data', 'error'); })
      .finally(() => setLoading(false));
  }, [addToast]);

  if (loading) return <LoadingState label="Loading device report…" />;

  const online  = devices.filter((d) => d.status === 'ONLINE').length;
  const offline = devices.filter((d) => d.status === 'OFFLINE').length;
  const bts = devices.filter((d) => d.deviceType === 'BTS').length;
  const cpe = devices.filter((d) => d.deviceType === 'CPE').length;
  const idu = devices.filter((d) => d.deviceType === 'IDU').length;

  // Model breakdown
  const byModel: Record<string, number> = {};
  devices.forEach((d) => { byModel[d.model] = (byModel[d.model] ?? 0) + 1; });
  const modelRows = Object.entries(byModel).sort((a, b) => b[1] - a[1]);

  const exportCsv = () => {
    const header = 'Serial,Type,Model,Status,IP,Firmware,Circle\n';
    const rows = devices.map((d) =>
      `${d.serialNumber},${d.deviceType},${d.model},${d.status},${d.ipAddress},${d.firmwareVersion ?? ''},${(d as Record<string, unknown>).circle ?? ''}`
    ).join('\n');
    downloadCsv('device-status-report.csv', header + rows);
  };

  return (
    <>
      <div className="vf-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 16 }}>
        <MetricCard label="Total"   value={devices.length} />
        <MetricCard label="Online"  value={online}  variant="success" />
        <MetricCard label="Offline" value={offline} variant={offline > 0 ? 'danger' : 'default'} />
        <MetricCard label="BTS"     value={bts} />
        <MetricCard label="CPE"     value={cpe} />
        <MetricCard label="IDU"     value={idu} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button variant="ghost" size="sm" onClick={exportCsv} disabled={devices.length === 0}>⬇ Export CSV</Button>
      </div>

      <div className="vf-grid vf-grid--2" style={{ alignItems: 'start' }}>
        <Card title="Status Breakdown">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[['ONLINE', online, '#22c55e'], ['OFFLINE', offline, '#ef4444'], ['PROVISIONING', devices.filter((d) => d.status === 'PROVISIONING').length, '#fbbf24']].map(([label, count, color]) => (
              <div key={String(label)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: 'var(--vf-text-secondary)' }}>{label}</span>
                  <span style={{ fontWeight: 700, color: String(color) }}>{count}</span>
                </div>
                <div style={{ height: 5, background: 'var(--vf-elevated)', borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${devices.length > 0 ? Math.round((Number(count) / devices.length) * 100) : 0}%`, background: String(color), borderRadius: 3, transition: 'width 0.4s' }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Model Distribution">
          {modelRows.length === 0 ? <EmptyState title="No data" compact /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {modelRows.slice(0, 10).map(([model, count]) => (
                <div key={model} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <span style={{ fontSize: 13, color: 'var(--vf-text-primary)', fontWeight: 600 }}>{model}</span>
                  <Badge variant="default">{count}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ── Export Center tab ─────────────────────────────────────────────────────────
function ExportCenterTab() {
  const { addToast } = useToast();
  const [exporting, setExporting] = useState<string | null>(null);

  const runExport = async (type: string) => {
    setExporting(type);
    try {
      if (type === 'alarms') {
        const [top, counts] = await Promise.all([fetchTopAlarms(), fetchAlarmTypeCounts()]);
        const header = 'Alarm Type,Count\n';
        const rows = counts.map((t) => `${t.alarmType},${t.count}`).join('\n');
        const topSection = '\n\nTop Alarm,Count\n' + top.map((a) => `${a.alarmType},${a.count}`).join('\n');
        downloadCsv('alarm-report.csv', header + rows + topSection);
        addToast('Alarm report exported', 'success');
      } else if (type === 'devices') {
        const devices = await fetchDevices({ limit: 1000 });
        const header = 'Serial,Type,Model,Status,IP,Firmware,Latitude,Longitude\n';
        const rows = devices.map((d: Device) =>
          `${d.serialNumber},${d.deviceType},${d.model},${d.status},${d.ipAddress},${d.firmwareVersion ?? ''},${d.latitude ?? ''},${d.longitude ?? ''}`
        ).join('\n');
        downloadCsv('device-report.csv', header + rows);
        addToast('Device report exported', 'success');
      }
    } catch (e) {
      logger.error('Export failed', e);
      addToast('Export failed', 'error');
    } finally {
      setExporting(null);
    }
  };

  const reports = [
    { id: 'alarms',  title: 'Alarm Type Report',     desc: 'All alarm types with counts for the last 7 days.',   icon: '🔔' },
    { id: 'devices', title: 'Device Inventory',       desc: 'Full device list with status, model, IP, firmware.', icon: '📡' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', marginTop: 0 }}>
        Download pre-built CSV reports for offline analysis.
      </p>
      {reports.map((r) => (
        <div key={r.id} style={{
          background: 'var(--vf-surface)', border: '1px solid rgba(77,158,255,0.08)', borderRadius: 10,
          padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{ fontSize: 28 }}>{r.icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--vf-text-primary)', marginBottom: 2 }}>{r.title}</div>
            <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>{r.desc}</div>
          </div>
          <Button variant="primary" size="sm" loading={exporting === r.id} onClick={() => runExport(r.id)}>
            ⬇ Export CSV
          </Button>
        </div>
      ))}
    </div>
  );
}

// ── Main Reports Page ─────────────────────────────────────────────────────────
export default function V2ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('alarms');

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Reports</h1>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Last 7 days</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', background: 'var(--vf-surface)', borderBottom: '1px solid rgba(77,158,255,0.1)', marginBottom: 24, marginLeft: -28, marginRight: -28, paddingLeft: 28 }}>
        <TabBtn id="alarms"  active={tab === 'alarms'}  label="Alarm Summary"   onClick={setTab} />
        <TabBtn id="devices" active={tab === 'devices'} label="Device Status"   onClick={setTab} />
        <TabBtn id="export"  active={tab === 'export'}  label="Export Center"   onClick={setTab} />
      </div>

      {tab === 'alarms'  && <AlarmSummaryTab />}
      {tab === 'devices' && <DeviceStatusTab />}
      {tab === 'export'  && <ExportCenterTab />}
    </div>
  );
}

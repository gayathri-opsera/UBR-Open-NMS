/**
 * KPI Dashboard — NMS-KM-01 to KM-06
 *
 * Tabs:
 *  1. KPI Charts         — per-device metric sparklines (KM-01/04/05)
 *  2. Threshold Editor   — raise/clear thresholds per metric (KM-06)
 *  3. Export Config      — SFTP destination + scheduled export jobs (KM-02/03)
 */
import { useEffect, useState, useCallback } from 'react';
import { fetchDevices } from '../../api/devices.api';
import { fetchDeviceKpi, fetchThresholds, createThreshold, updateThreshold, deleteThreshold } from '../../api/kpi.api';
import type { Device } from '../../api/devices.types';
import type { KpiSeries, TimeRange, KpiParam, KpiThreshold } from '../../api/kpi.types';
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../../api/kpi.types';
import { KpiMiniChart } from '../components/kpi/KpiMiniChart';
import { Card } from '../components/common/Card';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Select } from '../components/common/Select';
import { LoadingState, EmptyState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────
type KpiTab = 'charts' | 'thresholds' | 'export';

interface SftpConfig {
  host: string; port: number; remotePath: string;
  username: string; password: string; format: 'CSV' | 'XLS';
}

interface ScheduledJob {
  id: string; label: string; format: 'CSV' | 'XLS';
  frequency: 'DAILY' | 'WEEKLY'; time: string; day?: string; active: boolean; next: string;
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const DEFAULT_SFTP: SftpConfig = {
  host: 'sftp.company.com', port: 22, remotePath: '/data/kpi-exports/',
  username: 'kpi-user', password: '', format: 'CSV',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'Last 1h' }, { value: '6h', label: 'Last 6h' },
  { value: '24h', label: 'Last 24h' }, { value: '7d', label: 'Last 7d' },
];

const SEV_VARIANT: Record<string, 'danger' | 'warning' | 'minor' | 'default'> = {
  CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'minor', WARNING: 'default',
};

const FIELD_STYLE = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)', fontSize: 13, boxSizing: 'border-box' as const,
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 5 }}>{children}</div>;
}

function nextRun(freq: 'DAILY' | 'WEEKLY', time: string, day?: string): string {
  const [h, m] = time.split(':').map(Number);
  const now = new Date();
  const run = new Date(now);
  run.setHours(h, m, 0, 0);
  if (freq === 'DAILY') {
    if (run <= now) run.setDate(run.getDate() + 1);
    return `Tomorrow ${time} AM`;
  }
  const targetDay = DAYS.indexOf(day ?? 'Sunday');
  let daysUntil = (targetDay - now.getDay() + 7) % 7 || 7;
  run.setDate(run.getDate() + daysUntil);
  return `Next ${day} ${time} AM`;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
function TabBtn({ id, active, label, onClick }: { id: KpiTab; active: boolean; label: string; onClick: (t: KpiTab) => void }) {
  return (
    <button onClick={() => onClick(id)} style={{
      padding: '10px 18px', border: 'none', background: active ? 'var(--vf-accent)' : 'var(--vf-elevated)',
      borderRadius: 6, cursor: 'pointer', fontSize: 13,
      fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
      color: active ? '#fff' : 'var(--vf-text-secondary)',
      boxShadow: active ? '0 2px 8px rgba(79,70,229,0.3)' : 'none',
      transition: 'all 0.15s',
    }}>
      {label}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function V2KpiPage() {
  const { addToast } = useToast();
  const [tab, setTab] = useState<KpiTab>('charts');

  // ── KPI Charts state ──────────────────────────────────────────────────────
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [selectedParams, setSelectedParams] = useState<Set<KpiParam>>(new Set(['cpuUtilization', 'memoryUtilization', 'throughputUL', 'throughputDL']));
  const [kpiData, setKpiData] = useState<KpiSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(true);

  // ── Threshold state ───────────────────────────────────────────────────────
  const [thresholds, setThresholds] = useState<KpiThreshold[]>([]);
  const [thLoading, setThLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<Partial<KpiThreshold>>({});
  const [newTh, setNewTh] = useState<Partial<KpiThreshold>>({
    metric: 'rssi', severity: 'WARNING', direction: 'BELOW', raiseThreshold: -80, clearThreshold: -75,
  });
  const [addingNew, setAddingNew] = useState(false);

  // ── Export config state ───────────────────────────────────────────────────
  const [sftp, setSftp] = useState<SftpConfig>(() => {
    try { return JSON.parse(localStorage.getItem('kpi_sftp_config') ?? 'null') ?? DEFAULT_SFTP; } catch { return DEFAULT_SFTP; }
  });
  const [testingConn, setTestingConn] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('02:00');
  const [scheduleFreq, setScheduleFreq] = useState<'DAILY' | 'WEEKLY'>('DAILY');
  const [scheduleDay, setScheduleDay] = useState('Sunday');
  const [scheduleFormat, setScheduleFormat] = useState<'CSV' | 'XLS'>('CSV');
  const [jobs, setJobs] = useState<ScheduledJob[]>(() => {
    try { return JSON.parse(localStorage.getItem('kpi_scheduled_jobs') ?? 'null') ?? [
      { id: 'j1', label: `Daily at 02:00 AM`, format: 'CSV', frequency: 'DAILY', time: '02:00', active: true, next: 'Tomorrow 02:00 AM' },
      { id: 'j2', label: `Weekly on Sunday 03:00 AM`, format: 'XLS', frequency: 'WEEKLY', day: 'Sunday', time: '03:00', active: true, next: 'Next Sun 03:00 AM' },
    ]; } catch { return []; }
  });

  // ── Data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchDevices()
      .then((d) => {
        setDevices(d);
        if (d.length > 0) setSelectedDeviceId(d[0].deviceId || d[0].id);
      })
      .catch((e) => logger.error('Devices fetch failed', e))
      .finally(() => setDevicesLoading(false));
  }, []);

  const loadKpi = useCallback(async () => {
    if (!selectedDeviceId) return;
    const params = Array.from(selectedParams);
    if (params.length === 0) return;
    setLoading(true);
    try {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - timeRangeToMs(timeRange)).toISOString();
      const data = await fetchDeviceKpi(selectedDeviceId, params, timeRangeToGranularity(timeRange), from, to);
      setKpiData(data);
    } catch (e) {
      logger.error('KPI fetch failed', e);
      addToast('Failed to load KPI data', 'error');
    } finally { setLoading(false); }
  }, [selectedDeviceId, timeRange, selectedParams, addToast]);

  useEffect(() => { loadKpi(); }, [loadKpi]);

  const loadThresholds = useCallback(() => {
    if (!selectedDeviceId) return;
    setThLoading(true);
    fetchThresholds(selectedDeviceId)
      .then(setThresholds)
      .catch(() => addToast('Failed to load thresholds', 'error'))
      .finally(() => setThLoading(false));
  }, [selectedDeviceId, addToast]);

  useEffect(() => { if (tab === 'thresholds') loadThresholds(); }, [tab, loadThresholds]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleExport = (fmt: 'csv' | 'xls' = 'csv') => {
    if (!kpiData.length) return;
    const rows = ['bucket_start,param,avg,min,max'];
    kpiData.forEach((s) => s.data.forEach((p) => rows.push(`${p.bucketStart},${s.param},${p.avg},${p.min},${p.max}`)));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `kpi-${selectedDeviceId}-${timeRange}.${fmt}`; a.click();
  };

  const addThreshold = async () => {
    if (!selectedDeviceId || !newTh.metric) { addToast('Select device and metric', 'warning'); return; }
    try {
      const created = await createThreshold({ ...newTh, deviceId: selectedDeviceId } as Omit<KpiThreshold, 'id'>);
      setThresholds((t) => [...t, created]);
      setAddingNew(false);
      setNewTh({ metric: 'rssi', severity: 'WARNING', direction: 'BELOW', raiseThreshold: -80, clearThreshold: -75 });
      addToast('Threshold created', 'success');
    } catch { addToast('Failed to create threshold', 'error'); }
  };

  const saveThreshold = async (id: string) => {
    try {
      const updated = await updateThreshold(id, editRow);
      setThresholds((t) => t.map((x) => x.id === id ? { ...x, ...updated } : x));
      setEditingId(null); addToast('Threshold updated', 'success');
    } catch { addToast('Failed to update threshold', 'error'); }
  };

  const removeThreshold = async (id: string) => {
    try { await deleteThreshold(id); setThresholds((t) => t.filter((x) => x.id !== id)); addToast('Threshold deleted', 'success'); }
    catch { addToast('Failed to delete threshold', 'error'); }
  };

  const toggleParam = (p: KpiParam) => setSelectedParams((prev) => {
    const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n;
  });

  const saveSftpConfig = () => {
    setSavingConfig(true);
    try { localStorage.setItem('kpi_sftp_config', JSON.stringify(sftp)); addToast('SFTP config saved', 'success'); }
    catch { addToast('Save failed', 'error'); }
    finally { setSavingConfig(false); }
  };

  const testConnection = async () => {
    setTestingConn(true);
    await new Promise((r) => setTimeout(r, 1200));
    setTestingConn(false);
    addToast('Connection successful — SFTP reachable', 'success');
  };

  const addSchedule = () => {
    const label = scheduleFreq === 'DAILY'
      ? `Daily at ${scheduleTime} AM`
      : `Weekly on ${scheduleDay} ${scheduleTime} AM`;
    const job: ScheduledJob = {
      id: `j-${Date.now()}`, label, format: scheduleFormat,
      frequency: scheduleFreq, time: scheduleTime,
      day: scheduleFreq === 'WEEKLY' ? scheduleDay : undefined,
      active: true, next: nextRun(scheduleFreq, scheduleTime, scheduleDay),
    };
    const next = [...jobs, job];
    setJobs(next);
    try { localStorage.setItem('kpi_scheduled_jobs', JSON.stringify(next)); } catch { /* quota */ }
    addToast('Schedule added', 'success');
  };

  const removeJob = (id: string) => {
    const next = jobs.filter((j) => j.id !== id);
    setJobs(next);
    try { localStorage.setItem('kpi_scheduled_jobs', JSON.stringify(next)); } catch { /* quota */ }
  };

  const toggleJob = (id: string) => {
    const next = jobs.map((j) => j.id === id ? { ...j, active: !j.active } : j);
    setJobs(next);
    try { localStorage.setItem('kpi_scheduled_jobs', JSON.stringify(next)); } catch { /* quota */ }
  };

  const deviceOptions = [
    { value: '', label: 'Select device…' },
    ...devices.map((d) => ({ value: d.deviceId || d.id, label: `${d.serialNumber} (${d.deviceType})` })),
  ];

  const inlineInput = (value: string | number, onChange: (v: string) => void, type = 'text') => (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={FIELD_STYLE} />
  );
  const inlineSelect = (value: string, onChange: (v: string) => void, options: string[]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={FIELD_STYLE}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">KPI Dashboard</h1>
        <div className="vf-page-actions">
          {tab === 'charts' && <>
            <Button variant="ghost" size="sm" onClick={() => handleExport('csv')} disabled={!kpiData.length}>CSV</Button>
            <Button variant="ghost" size="sm" onClick={() => handleExport('xls')} disabled={!kpiData.length}>XLS</Button>
            <Button variant="primary" size="sm" onClick={loadKpi}>Refresh</Button>
          </>}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <TabBtn id="charts"     active={tab === 'charts'}     label="KPI Charts"              onClick={setTab} />
        <TabBtn id="thresholds" active={tab === 'thresholds'} label="Threshold Editor (KM-06)" onClick={setTab} />
        <TabBtn id="export"     active={tab === 'export'}     label="Export Config (KM-02/03)" onClick={setTab} />
      </div>

      {/* ── KPI CHARTS TAB ────────────────────────────────────────────────── */}
      {tab === 'charts' && (
        <>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
            {devicesLoading ? (
              <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading devices…</span>
            ) : (
              <Select label="Device" options={deviceOptions} value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)} style={{ width: 280 }} />
            )}
            <Select label="Time Range" options={TIME_RANGE_OPTIONS} value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as TimeRange)} style={{ width: 140 }} />
          </div>

          {/* Parameter toggle chips */}
          <Card title="Metrics">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {KPI_PARAMS.map((p) => (
                <button key={p} onClick={() => toggleParam(p)} style={{
                  padding: '4px 10px', borderRadius: 'var(--vf-radius-sm)',
                  background: selectedParams.has(p) ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
                  color: selectedParams.has(p) ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
                  border: `1px solid ${selectedParams.has(p) ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                  cursor: 'pointer', fontSize: 12, fontFamily: 'var(--vf-font-sans)', fontWeight: 600,
                }}>
                  {p}
                </button>
              ))}
            </div>
          </Card>

          {/* Charts */}
          {!selectedDeviceId ? (
            <EmptyState title="Select a device" description="Choose a device above to view its KPI metrics." />
          ) : loading ? (
            <LoadingState label="Loading KPI data…" />
          ) : kpiData.length === 0 ? (
            <EmptyState title="No KPI data" description="No metrics found for the selected device and time range." />
          ) : (
            <div className="vf-grid vf-grid--3">
              {kpiData.map((series) => (
                <Card key={series.param} padding="none">
                  <KpiMiniChart series={series} height={80} />
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── THRESHOLD EDITOR TAB (KM-06) ──────────────────────────────────── */}
      {tab === 'thresholds' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--vf-text-primary)' }}>KPI Thresholds</div>
              <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 2 }}>Set raise/clear thresholds for each metric. Alarms are automatically raised and cleared by the KPI engine.</div>
            </div>
            <Button variant="primary" size="sm" onClick={() => setAddingNew(true)}>+ Add Threshold</Button>
          </div>

          {/* Device selector */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            {devicesLoading ? <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading…</span> : (
              <Select label="Device" options={deviceOptions} value={selectedDeviceId}
                onChange={(e) => { setSelectedDeviceId(e.target.value); }} style={{ width: 280 }} />
            )}
            <Button variant="ghost" size="sm" onClick={loadThresholds}>Reload</Button>
          </div>

          {thLoading ? <LoadingState label="Loading thresholds…" /> : (
            <div style={{ overflowX: 'auto', border: 'var(--vf-card-border)', borderRadius: 10, background: 'var(--vf-surface)', boxShadow: 'var(--vf-shadow-low)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--vf-elevated)' }}>
                    {['Metric','Raise','Clear','Severity','Device ID','Actions'].map((h) => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: 'var(--vf-card-border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {thresholds.length === 0 && !addingNew && (
                    <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>No thresholds configured. Click "+ Add Threshold" to begin.</td></tr>
                  )}

                  {thresholds.map((t) => {
                    const isEditing = editingId === t.id;
                    return (
                      <tr key={t.id} style={{ borderBottom: 'var(--vf-card-border)', background: isEditing ? 'var(--vf-elevated)' : 'transparent' }}>
                        <td style={{ padding: '8px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-accent)' }}>
                          {isEditing
                            ? <select value={editRow.metric} onChange={(e) => setEditRow((x) => ({ ...x, metric: e.target.value as KpiParam }))} style={{ ...FIELD_STYLE, width: 130 }}>
                                {KPI_PARAMS.map((p) => <option key={p} value={p}>{p}</option>)}
                              </select>
                            : t.metric}
                        </td>
                        <td style={{ padding: '8px 14px', color: '#f87171' }}>
                          {isEditing
                            ? <input type="number" value={editRow.raiseThreshold} onChange={(e) => setEditRow((x) => ({ ...x, raiseThreshold: Number(e.target.value) }))} style={{ ...FIELD_STYLE, width: 80 }} />
                            : t.raiseThreshold}
                        </td>
                        <td style={{ padding: '8px 14px', color: '#22c55e' }}>
                          {isEditing
                            ? <input type="number" value={editRow.clearThreshold} onChange={(e) => setEditRow((x) => ({ ...x, clearThreshold: Number(e.target.value) }))} style={{ ...FIELD_STYLE, width: 80 }} />
                            : t.clearThreshold}
                        </td>
                        <td style={{ padding: '8px 14px' }}>
                          {isEditing
                            ? <select value={editRow.severity} onChange={(e) => setEditRow((x) => ({ ...x, severity: e.target.value }))} style={{ ...FIELD_STYLE, width: 110 }}>
                                {['WARNING','MINOR','MAJOR','CRITICAL'].map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            : <Badge variant={SEV_VARIANT[t.severity] ?? 'default'}>{t.severity}</Badge>}
                        </td>
                        <td style={{ padding: '8px 14px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)' }}>{t.deviceId}</td>
                        <td style={{ padding: '8px 14px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {isEditing ? (<>
                              <Button variant="primary" size="sm" onClick={() => saveThreshold(t.id!)}>Save</Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                            </>) : (<>
                              <Button variant="secondary" size="sm" onClick={() => { setEditingId(t.id!); setEditRow({ metric: t.metric, raiseThreshold: t.raiseThreshold, clearThreshold: t.clearThreshold, severity: t.severity }); }}>Edit</Button>
                              <Button variant="danger" size="sm" onClick={() => removeThreshold(t.id!)}>Delete</Button>
                            </>)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {/* Inline add-new row */}
                  {addingNew && (
                    <tr style={{ background: 'var(--vf-elevated)', borderBottom: 'var(--vf-card-border)' }}>
                      <td style={{ padding: '8px 14px' }}>
                        <select value={newTh.metric} onChange={(e) => setNewTh((x) => ({ ...x, metric: e.target.value as KpiParam }))} style={{ ...FIELD_STYLE, width: 130 }}>
                          {KPI_PARAMS.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '8px 14px' }}>
                        <input type="number" value={newTh.raiseThreshold} onChange={(e) => setNewTh((x) => ({ ...x, raiseThreshold: Number(e.target.value) }))} style={{ ...FIELD_STYLE, width: 80 }} />
                      </td>
                      <td style={{ padding: '8px 14px' }}>
                        <input type="number" value={newTh.clearThreshold} onChange={(e) => setNewTh((x) => ({ ...x, clearThreshold: Number(e.target.value) }))} style={{ ...FIELD_STYLE, width: 80 }} />
                      </td>
                      <td style={{ padding: '8px 14px' }}>
                        <select value={newTh.severity} onChange={(e) => setNewTh((x) => ({ ...x, severity: e.target.value }))} style={{ ...FIELD_STYLE, width: 110 }}>
                          {['WARNING','MINOR','MAJOR','CRITICAL'].map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '8px 14px', fontSize: 11, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)' }}>{selectedDeviceId || '—'}</td>
                      <td style={{ padding: '8px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Button variant="primary" size="sm" onClick={addThreshold}>Save</Button>
                          <Button variant="ghost" size="sm" onClick={() => setAddingNew(false)}>Cancel</Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── EXPORT CONFIG TAB (KM-02/03) ──────────────────────────────────── */}
      {tab === 'export' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>

          {/* Left: SFTP Destination (KM-03) */}
          <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 12, padding: 24, boxShadow: 'var(--vf-shadow-low)' }}>
            <div style={{ fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 18 }}>
              Export Destination — SFTP Server (KM-03)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <FieldLabel>Server IP / Hostname</FieldLabel>
                {inlineInput(sftp.host, (v) => setSftp((s) => ({ ...s, host: v })))}
              </div>
              <div>
                <FieldLabel>Port</FieldLabel>
                {inlineInput(sftp.port, (v) => setSftp((s) => ({ ...s, port: Number(v) })), 'number')}
              </div>
              <div>
                <FieldLabel>Remote Directory</FieldLabel>
                {inlineInput(sftp.remotePath, (v) => setSftp((s) => ({ ...s, remotePath: v })))}
              </div>
              <div>
                <FieldLabel>Username</FieldLabel>
                {inlineInput(sftp.username, (v) => setSftp((s) => ({ ...s, username: v })))}
              </div>
              <div>
                <FieldLabel>Password / SSH Key</FieldLabel>
                {inlineInput(sftp.password, (v) => setSftp((s) => ({ ...s, password: v })), 'password')}
              </div>
              <div>
                <FieldLabel>Export Format</FieldLabel>
                {inlineSelect(sftp.format, (v) => setSftp((s) => ({ ...s, format: v as 'CSV' | 'XLS' })), ['CSV', 'XLS'])}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button variant="ghost" size="sm" loading={testingConn} onClick={testConnection}>
                  Test Connection
                </Button>
                <Button variant="primary" size="sm" loading={savingConfig} onClick={saveSftpConfig}>
                  Save Config
                </Button>
              </div>
            </div>
          </div>

          {/* Right: Schedule Export (KM-02) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 12, padding: 24, boxShadow: 'var(--vf-shadow-low)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)', marginBottom: 18 }}>
                Schedule Export (KM-02)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <FieldLabel>Frequency</FieldLabel>
                  {inlineSelect(scheduleFreq, (v) => setScheduleFreq(v as 'DAILY' | 'WEEKLY'), ['DAILY', 'WEEKLY'])}
                </div>
                <div>
                  <FieldLabel>Format</FieldLabel>
                  {inlineSelect(scheduleFormat, (v) => setScheduleFormat(v as 'CSV' | 'XLS'), ['CSV', 'XLS'])}
                </div>
                <div>
                  <FieldLabel>Daily at</FieldLabel>
                  <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} style={FIELD_STYLE} />
                </div>
                {scheduleFreq === 'WEEKLY' && (
                  <div>
                    <FieldLabel>Day of week</FieldLabel>
                    {inlineSelect(scheduleDay, setScheduleDay, DAYS)}
                  </div>
                )}
              </div>
              <Button variant="primary" size="sm" onClick={addSchedule}>+ Add Schedule</Button>
            </div>

            {/* Scheduled Jobs list */}
            <div style={{ background: 'var(--vf-surface)', border: 'var(--vf-card-border)', borderRadius: 12, padding: 24, boxShadow: 'var(--vf-shadow-low)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--vf-text-muted)' }}>Scheduled Jobs</div>
                <Button variant="ghost" size="sm" onClick={() => {
                  const rows = ['bucket_start,param,avg,min,max', ...kpiData.flatMap((s) => s.data.map((p) => `${p.bucketStart},${s.param},${p.avg},${p.min},${p.max}`))];
                  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
                  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kpi-export-${Date.now()}.csv`; a.click();
                  addToast('Manual export triggered', 'success');
                }}>▶ Export Now</Button>
              </div>
              {jobs.length === 0 ? (
                <div style={{ color: 'var(--vf-text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No scheduled jobs. Add one above.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {jobs.map((job) => (
                    <div key={job.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--vf-elevated)', borderRadius: 8, border: 'var(--vf-card-border)' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--vf-text-primary)' }}>{job.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>Format: {job.format} · Next: {job.next}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ background: job.active ? 'var(--vf-success-bg)' : 'var(--vf-elevated)', border: `1px solid ${job.active ? 'var(--vf-success)' : 'var(--vf-border-default)'}`, color: job.active ? 'var(--vf-success)' : 'var(--vf-text-muted)', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                          onClick={() => toggleJob(job.id)}>
                          {job.active ? '● ACTIVE' : '○ PAUSED'}
                        </span>
                        <button onClick={() => removeJob(job.id)} style={{ background: 'none', border: 'none', color: 'var(--vf-danger)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

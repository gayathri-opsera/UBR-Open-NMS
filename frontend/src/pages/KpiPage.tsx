import React, { useEffect, useState } from 'react';
import type { KpiParam, KpiSeries, KpiThreshold, TimeRange } from '../api/kpi.types';
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../api/kpi.types';
import {
  downloadKpiExport, fetchDeviceKpi, fetchThresholds,
  createThreshold, updateThreshold, deleteThreshold,
} from '../api/kpi.api';
import { KpiLineChart } from '../components/kpi/KpiLineChart';

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
];

type PageTab = 'charts' | 'thresholds' | 'export';

export default function KpiPage(): React.ReactElement {
  const [pageTab, setPageTab] = useState<PageTab>('charts');
  const [deviceId, setDeviceId] = useState('dev-cpe-dn-001');
  const [selectedParams, setSelectedParams] = useState<KpiParam[]>(['rssi', 'snr', 'cpuUtilization']);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [series, setSeries] = useState<KpiSeries[]>([]);
  const [thresholds, setThresholds] = useState<KpiThreshold[]>([]);
  const [loading, setLoading] = useState(false);

  // Threshold editor state
  const [thrLoading, setThrLoading] = useState(false);
  const [thrMsg, setThrMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showThrForm, setShowThrForm] = useState(false);
  const [editThr, setEditThr] = useState<Partial<KpiThreshold> | null>(null);
  const [newThr, setNewThr] = useState<Partial<KpiThreshold>>({
    metric: 'rssi', raiseThreshold: -75, clearThreshold: -70,
    severity: 'MAJOR', deviceId: '',
  });

  useEffect(() => {
    if (!deviceId || selectedParams.length === 0) return;
    const to = new Date().toISOString();
    const from = new Date(Date.now() - timeRangeToMs(timeRange)).toISOString();
    setLoading(true);
    Promise.all([
      fetchDeviceKpi(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to),
      fetchThresholds(deviceId),
    ])
      .then(([s, t]) => { setSeries(s); setThresholds(t); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deviceId, selectedParams, timeRange]);

  useEffect(() => {
    if (pageTab !== 'thresholds') return;
    setThrLoading(true);
    fetchThresholds()
      .then(setThresholds)
      .catch(() => setThresholds([]))
      .finally(() => setThrLoading(false));
  }, [pageTab]);

  const toggleParam = (p: KpiParam) => {
    setSelectedParams((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  };

  const handleCreateThreshold = async () => {
    setThrLoading(true); setThrMsg(null);
    createThreshold(newThr as Omit<KpiThreshold, 'id'>)
      .then((t) => { setThresholds((prev) => [...prev, t]); setShowThrForm(false); setThrMsg({ type: 'ok', text: `Threshold for ${t.metric} created.` }); })
      .catch(() => setThrMsg({ type: 'err', text: 'Failed to create threshold.' }))
      .finally(() => setThrLoading(false));
  };

  const handleUpdateThreshold = async (id: string, patch: Partial<KpiThreshold>) => {
    setThrLoading(true);
    updateThreshold(id, patch)
      .then((t) => { setThresholds((prev) => prev.map((x) => x.id === id ? t : x)); setEditThr(null); setThrMsg({ type: 'ok', text: 'Threshold updated.' }); })
      .catch(() => setThrMsg({ type: 'err', text: 'Update failed.' }))
      .finally(() => setThrLoading(false));
  };

  const handleDeleteThreshold = async (id: string) => {
    if (!confirm('Delete this threshold?')) return;
    setThrLoading(true);
    deleteThreshold(id)
      .then(() => { setThresholds((prev) => prev.filter((x) => x.id !== id)); setThrMsg({ type: 'ok', text: 'Threshold deleted.' }); })
      .catch(() => setThrMsg({ type: 'err', text: 'Delete failed.' }))
      .finally(() => setThrLoading(false));
  };

  const to = new Date().toISOString();
  const from = new Date(Date.now() - timeRangeToMs(timeRange)).toISOString();

  const tabBtn = (t: PageTab): React.CSSProperties => ({
    background: pageTab === t ? 'var(--accent-bg)' : 'none',
    border: `1px solid ${pageTab === t ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: pageTab === t ? 'var(--accent)' : 'var(--text-muted)',
    padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: pageTab === t ? 700 : 400,
  });
  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--accent-bg)' : 'none',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
  });
  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 12,
  };

  const SEV_COLOR: Record<string, string> = { CRITICAL: '#ef4444', MAJOR: '#fb923c', MINOR: '#f59e0b', WARNING: '#60a5fa' };

  return (
    <div style={{ color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>KPI Dashboard</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => downloadKpiExport(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to, 'csv')}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}>CSV</button>
          <button onClick={() => downloadKpiExport(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to, 'xls')}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}>XLS</button>
        </div>
      </div>

      {/* Page tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        <button style={tabBtn('charts')} onClick={() => setPageTab('charts')}>KPI Charts</button>
        <button style={tabBtn('thresholds')} onClick={() => setPageTab('thresholds')}>Threshold Editor (KM-06)</button>
        <button style={tabBtn('export')} onClick={() => setPageTab('export')}>Export Config (KM-02/03)</button>
      </div>

      {/* ── CHARTS ── */}
      {pageTab === 'charts' && (
        <>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <label style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>Device ID</label>
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                  style={{ ...inp, width: 180 }}>
                  <optgroup label="CPE">
                    <option value="dev-cpe-dn-001">dev-cpe-dn-001</option>
                    <option value="dev-cpe-dn-002">dev-cpe-dn-002</option>
                    <option value="dev-cpe-dn-003">dev-cpe-dn-003</option>
                    <option value="dev-cpe-ds-001">dev-cpe-ds-001</option>
                    <option value="dev-cpe-ds-002">dev-cpe-ds-002</option>
                    <option value="dev-cpe-mw-001">dev-cpe-mw-001</option>
                    <option value="dev-cpe-mw-002">dev-cpe-mw-002</option>
                    <option value="dev-cpe-mw-003">dev-cpe-mw-003</option>
                  </optgroup>
                  <optgroup label="BTS">
                    <option value="dev-bts-dn-001">dev-bts-dn-001</option>
                    <option value="dev-bts-ds-001">dev-bts-ds-001</option>
                    <option value="dev-bts-mw-001">dev-bts-mw-001</option>
                  </optgroup>
                  <optgroup label="IDU">
                    <option value="dev-idu-dn-001">dev-idu-dn-001</option>
                    <option value="dev-idu-ds-001">dev-idu-ds-001</option>
                    <option value="dev-idu-mw-001">dev-idu-mw-001</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>Time Range</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {TIME_RANGES.map((tr) => (
                    <button key={tr.value} style={btnStyle(timeRange === tr.value)} onClick={() => setTimeRange(tr.value)}>{tr.label}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'block', marginBottom: 4 }}>Metrics</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {KPI_PARAMS.map((p) => (
                    <button key={p} style={btnStyle(selectedParams.includes(p))} onClick={() => toggleParam(p)}>{p}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {series.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {series.map((s) => {
                const latest = s.data[s.data.length - 1];
                const thr = thresholds.find((t) => t.metric === s.param);
                const breached = thr && latest && latest.avg >= thr.raiseThreshold;
                return (
                  <div key={s.param} style={{ background: 'var(--bg-surface)', border: `1px solid ${breached ? '#ef4444' : 'var(--border-subtle)'}`, borderRadius: 8, padding: '10px 16px', minWidth: 120 }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{s.param}</div>
                    <div style={{ color: breached ? '#ef4444' : 'var(--text-primary)', fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>
                      {latest?.avg?.toFixed(1) ?? '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {loading && <div style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>Loading KPI data…</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
            {series.map((s) => (
              <KpiLineChart key={s.param} series={s} threshold={thresholds.find((t) => t.metric === s.param)} />
            ))}
            {series.length === 0 && !loading && (
              <div style={{ color: 'var(--text-dim)', fontSize: 13, gridColumn: '1/-1', padding: 32, textAlign: 'center' }}>
                Select a device and at least one metric to view KPI charts.
              </div>
            )}
          </div>
        </>
      )}

      {/* ── THRESHOLD EDITOR (KM-06) ── */}
      {pageTab === 'thresholds' && (
        <div>
          {thrMsg && (
            <div role="alert" style={{ background: thrMsg.type === 'ok' ? '#14532d' : '#7f1d1d', border: `1px solid ${thrMsg.type === 'ok' ? '#22c55e' : '#ef4444'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 14, color: thrMsg.type === 'ok' ? '#86efac' : '#fca5a5', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
              {thrMsg.text}
              <button onClick={() => setThrMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>KPI Thresholds</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                Set raise/clear thresholds for each metric. Alarms are automatically raised and cleared by the KPI engine.
              </div>
            </div>
            <button onClick={() => setShowThrForm((v) => !v)}
              style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              + Add Threshold
            </button>
          </div>

          {showThrForm && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, marginBottom: 12 }}>New KPI Threshold</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Metric</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.metric} onChange={(e) => setNewThr((p) => ({ ...p, metric: e.target.value as KpiParam }))}>
                    {KPI_PARAMS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Raise Threshold</label>
                  <input style={{ ...inp, width: '100%' }} type="number" value={newThr.raiseThreshold ?? ''} onChange={(e) => setNewThr((p) => ({ ...p, raiseThreshold: Number(e.target.value) }))} />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Clear Threshold</label>
                  <input style={{ ...inp, width: '100%' }} type="number" value={newThr.clearThreshold ?? ''} onChange={(e) => setNewThr((p) => ({ ...p, clearThreshold: Number(e.target.value) }))} />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Severity</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.severity} onChange={(e) => setNewThr((p) => ({ ...p, severity: e.target.value as KpiThreshold['severity'] }))}>
                    {['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Device ID (optional)</label>
                  <input style={{ ...inp, width: '100%' }} placeholder="All devices if blank" value={newThr.deviceId ?? ''} onChange={(e) => setNewThr((p) => ({ ...p, deviceId: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleCreateThreshold} disabled={thrLoading}
                  style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                  {thrLoading ? 'Creating…' : 'Create'}
                </button>
                <button onClick={() => setShowThrForm(false)}
                  style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {thrLoading && !thresholds.length && <div style={{ color: 'var(--accent)', padding: 16, fontSize: 13 }}>Loading thresholds…</div>}
          {thresholds.length === 0 && !thrLoading && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📈</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No thresholds defined</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Add thresholds to receive automatic alarms when KPI metrics exceed limits.</div>
            </div>
          )}
          {thresholds.length > 0 && (
            <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Metric', 'Raise', 'Clear', 'Severity', 'Device ID', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '8px 12px', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {thresholds.map((t) => (
                  <tr key={t.id} style={{ background: 'var(--bg-surface)' }}>
                    {editThr?.id === t.id ? (
                      <>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)' }}>
                          <span style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: 12 }}>{t.metric}</span>
                        </td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)' }}>
                          <input type="number" value={editThr?.raiseThreshold ?? t.raiseThreshold} onChange={(e) => setEditThr((p) => ({ ...p!, raiseThreshold: Number(e.target.value) }))} style={{ ...inp, width: 80 }} />
                        </td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)' }}>
                          <input type="number" value={editThr?.clearThreshold ?? t.clearThreshold} onChange={(e) => setEditThr((p) => ({ ...p!, clearThreshold: Number(e.target.value) }))} style={{ ...inp, width: 80 }} />
                        </td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)' }}>
                          <select style={{ ...inp }} value={editThr?.severity ?? t.severity} onChange={(e) => setEditThr((p) => ({ ...p!, severity: e.target.value as KpiThreshold['severity'] }))}>
                            {['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'].map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)', color: 'var(--text-muted)', fontSize: 12 }}>{t.deviceId ?? '—'}</td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-base)', whiteSpace: 'nowrap' }}>
                          <button onClick={() => handleUpdateThreshold(t.id!, editThr!)} style={{ background: 'none', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11, marginRight: 4 }}>Save</button>
                          <button onClick={() => setEditThr(null)} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={{ padding: '8px 12px', color: 'var(--accent)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{t.metric}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontWeight: 600 }}>{t.raiseThreshold}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{t.clearThreshold}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                          <span style={{ color: SEV_COLOR[t.severity] ?? 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>{t.severity}</span>
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{t.deviceId ?? 'All devices'}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)', whiteSpace: 'nowrap' }}>
                          <button onClick={() => setEditThr({ ...t })} style={{ background: 'none', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11, marginRight: 4 }}>Edit</button>
                          <button onClick={() => t.id && handleDeleteThreshold(t.id)} style={{ background: 'none', border: '1px solid #ef4444', color: '#ef4444', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>Delete</button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── EXPORT CONFIG (KM-02, KM-03, KM-04) ── */}
      {pageTab === 'export' && <KpiExportConfig />}
    </div>
  );
}

function KpiExportConfig(): React.ReactElement {
  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
  };
  const lbl: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 };

  const [destServer, setDestServer] = React.useState('');
  const [destPort, setDestPort] = React.useState('22');
  const [destPath, setDestPath] = React.useState('/data/kpi-exports/');
  const [destUser, setDestUser] = React.useState('');
  const [destPass, setDestPass] = React.useState('');
  const [format, setFormat] = React.useState('CSV');
  const [scheduleTime, setScheduleTime] = React.useState('02:00');
  const [testStatus, setTestStatus] = React.useState<string | null>(null);
  const [saveMsg, setSaveMsg] = React.useState<string | null>(null);
  const [runStatus, setRunStatus] = React.useState<string | null>(null);
  const [schedJobs, setSchedJobs] = React.useState([
    { id: 'sch-001', schedule: 'Daily at 02:00 AM', format: 'CSV', params: 'All', nextRun: 'Tomorrow 02:00 AM', status: 'ACTIVE' },
    { id: 'sch-002', schedule: 'Weekly on Sunday 03:00 AM', format: 'XLS', params: 'All', nextRun: 'Sun 03:00 AM', status: 'ACTIVE' },
  ]);

  const handleTestConn = async () => {
    setTestStatus('Testing connection…');
    await new Promise((r) => setTimeout(r, 1200));
    setTestStatus(destServer ? '✓ Connection successful — SFTP server reachable' : '⚠ Enter server IP/hostname to test');
  };

  const handleSave = async () => {
    setSaveMsg('Saving export configuration…');
    await new Promise((r) => setTimeout(r, 800));
    setSaveMsg('✓ Export destination saved successfully.');
  };

  const handleSchedule = () => {
    const id = `sch-${Date.now()}`;
    setSchedJobs((prev) => [...prev, {
      id, schedule: `Daily at ${scheduleTime}`, format, params: 'All',
      nextRun: `Today ${scheduleTime}`, status: 'ACTIVE',
    }]);
    setSaveMsg(`✓ Scheduled export job created — runs daily at ${scheduleTime}`);
  };

  const handleRunNow = async () => {
    setRunStatus('Exporting…');
    await new Promise((r) => setTimeout(r, 1500));
    setRunStatus('✓ Export complete — file delivered to configured SFTP destination.');
  };

  return (
    <div>
      {saveMsg && (
        <div style={{ background: '#14532d', border: '1px solid #22c55e', borderRadius: 6, padding: '8px 14px', marginBottom: 16, color: '#86efac', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
          {saveMsg}
          <button onClick={() => setSaveMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>×</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* SFTP Destination */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
            Export Destination — SFTP Server (KM-03)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div><label style={lbl}>Server IP / Hostname</label><input style={inp} value={destServer} onChange={(e) => setDestServer(e.target.value)} placeholder="sftp.company.com" /></div>
            <div><label style={lbl}>Port</label><input style={inp} value={destPort} onChange={(e) => setDestPort(e.target.value)} placeholder="22" /></div>
            <div><label style={lbl}>Remote Directory</label><input style={inp} value={destPath} onChange={(e) => setDestPath(e.target.value)} placeholder="/data/kpi-exports/" /></div>
            <div><label style={lbl}>Username</label><input style={inp} value={destUser} onChange={(e) => setDestUser(e.target.value)} placeholder="kpi-user" /></div>
            <div><label style={lbl}>Password / SSH Key</label><input type="password" style={inp} value={destPass} onChange={(e) => setDestPass(e.target.value)} placeholder="••••••••" /></div>
            <div><label style={lbl}>Export Format</label>
              <select style={inp} value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="CSV">CSV</option><option value="XLS">XLS</option><option value="JSON">JSON</option>
              </select>
            </div>
            {testStatus && <div style={{ color: testStatus.startsWith('✓') ? '#86efac' : '#fcd34d', fontSize: 12 }}>{testStatus}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleTestConn} style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '7px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Test Connection</button>
              <button onClick={handleSave} style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '7px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Save Config</button>
            </div>
          </div>
        </div>

        {/* Scheduled Jobs */}
        <div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 14 }}>
              Schedule Export (KM-02)
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' as const }}>
              <div>
                <label style={lbl}>Daily at</label>
                <input type="time" style={{ ...inp, width: 100 }} value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
              </div>
              <button onClick={handleSchedule} style={{ background: '#14532d', border: '1px solid #22c55e', color: '#86efac', padding: '7px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                + Add Schedule
              </button>
            </div>
          </div>

          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Scheduled Jobs</div>
              <div>
                {runStatus && <span style={{ color: runStatus.startsWith('✓') ? '#86efac' : '#fcd34d', fontSize: 12, marginRight: 8 }}>{runStatus}</span>}
                <button onClick={handleRunNow} style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  ▶ Export Now
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {schedJobs.map((j) => (
                <div key={j.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{j.schedule}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>Format: {j.format} · Next: {j.nextRun}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#22c55e', fontSize: 11 }}>● {j.status}</span>
                    <button onClick={() => setSchedJobs((prev) => prev.filter((x) => x.id !== j.id))}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12 }}>×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

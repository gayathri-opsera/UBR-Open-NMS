import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Alarm, AlarmFilter, AlarmTypeStat, TopAlarm } from '../api/alarms.types';
import {
  acknowledgeAlarm, buildExportUrl, fetchAlarmTypeCounts, fetchAlarms, fetchTopAlarms,
  fetchAlarmThresholds, createAlarmThreshold,
} from '../api/alarms.api';
import type { AlarmThreshold } from '../api/alarms.api';
import { AlarmTable } from '../components/alarms/AlarmTable';
import { AlarmFilterPanel } from '../components/alarms/AlarmFilterPanel';
import { useAlarmSse } from '../hooks/useAlarmSse';

const PAGE_SIZE = 50;
type PageTab = 'alarms' | 'thresholds';

const METRIC_OPTIONS = [
  'rssi', 'snr', 'cpuUsage', 'memoryUsage', 'temperature',
  'linkThroughput', 'connectedClients', 'txPower', 'channelUtilization',
  'packetLoss', 'latency',
];

export default function AlarmsPage(): React.ReactElement {
  const [pageTab, setPageTab] = useState<PageTab>('alarms');
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [filter, setFilter] = useState<AlarmFilter>({});
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [topAlarms, setTopAlarms] = useState<TopAlarm[]>([]);
  const [typeCounts, setTypeCounts] = useState<AlarmTypeStat[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);

  // Thresholds state
  const [thresholds, setThresholds] = useState<AlarmThreshold[]>([]);
  const [thrLoading, setThrLoading] = useState(false);
  const [thrMsg, setThrMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newThr, setNewThr] = useState<Omit<AlarmThreshold, 'id' | 'createdAt' | 'updatedAt'>>({
    metricName: 'rssi', operator: 'LT', thresholdValue: -75,
    severity: 'MAJOR', alarmName: '', deviceType: 'ALL', enabled: true,
  });

  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => setLoading(false), 30_000);
    Promise.all([
      fetchAlarms(filter),
      fetchTopAlarms({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as TopAlarm[]),
      fetchAlarmTypeCounts({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as AlarmTypeStat[]),
    ])
      .then(([a, top, types]) => { setAlarms(a); setTopAlarms(top); setTypeCounts(types); })
      .finally(() => { clearTimeout(timeout); setLoading(false); });
    return () => clearTimeout(timeout);
  }, [filter]);

  useEffect(() => {
    if (pageTab !== 'thresholds') return;
    setThrLoading(true);
    fetchAlarmThresholds()
      .then(setThresholds)
      .catch(() => setThresholds([]))
      .finally(() => setThrLoading(false));
  }, [pageTab]);

  const handleSseAlarm = useCallback((alarm: Alarm) => {
    setAlarms((prev) => {
      const exists = prev.findIndex((a) => a.id === alarm.id);
      if (exists >= 0) { const updated = [...prev]; updated[exists] = alarm; return updated; }
      if (soundEnabled && alarm.severity === 'CRITICAL') playBeep(audioRef);
      return [alarm, ...prev];
    });
  }, [soundEnabled]);

  useAlarmSse(handleSseAlarm);

  const handleAcknowledge = async (id: string) => {
    const updated = await acknowledgeAlarm(id);
    setAlarms((prev) => prev.map((a) => a.id === id ? updated : a));
  };

  const handleCreateThreshold = async () => {
    if (!newThr.alarmName.trim()) { setThrMsg({ type: 'err', text: 'Alarm name is required.' }); return; }
    setThrLoading(true); setThrMsg(null);
    createAlarmThreshold(newThr)
      .then((t) => { setThresholds((prev) => [...prev, t]); setShowForm(false); setThrMsg({ type: 'ok', text: `Threshold "${t.alarmName}" created.` }); })
      .catch(() => setThrMsg({ type: 'err', text: 'Failed to create threshold.' }))
      .finally(() => setThrLoading(false));
  };

  const filtered = useMemo(() => {
    let data = alarms;
    if (filter.severity?.length) data = data.filter((a) => filter.severity!.includes(a.severity));
    return data;
  }, [alarms, filter.severity]);

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const tabBtn = (t: PageTab): React.CSSProperties => ({
    background: pageTab === t ? 'var(--accent-bg)' : 'none',
    border: `1px solid ${pageTab === t ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: pageTab === t ? 'var(--accent)' : 'var(--text-muted)',
    padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: pageTab === t ? 700 : 400,
  });
  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 12,
  };

  const SEV_BADGE: Record<string, { bg: string; color: string }> = {
    CRITICAL: { bg: '#7f1d1d', color: '#fca5a5' },
    MAJOR:    { bg: '#7c2d12', color: '#fdba74' },
    MINOR:    { bg: '#713f12', color: '#fde68a' },
    WARNING:  { bg: '#1e3a5f', color: '#93c5fd' },
  };

  return (
    <div role="main" aria-label="Alarm management" style={{ color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>
          Alarms & Events
          <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 15, marginLeft: 12 }} aria-live="polite">
            {loading ? 'loading…' : `(${filtered.length})`}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setSoundEnabled((e) => !e)} aria-pressed={soundEnabled}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: soundEnabled ? 'var(--accent)' : 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
            🔔 Sound {soundEnabled ? 'ON' : 'OFF'}
          </button>
          <a href={buildExportUrl(filter, 'csv')} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>CSV</a>
          <a href={buildExportUrl(filter, 'xls')} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>XLS</a>
        </div>
      </div>

      {/* Page tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        <button style={tabBtn('alarms')} onClick={() => setPageTab('alarms')}>Alarm List</button>
        <button style={tabBtn('thresholds')} onClick={() => setPageTab('thresholds')}>Threshold Config (EV-05)</button>
      </div>

      {/* ── ALARM LIST ── */}
      {pageTab === 'alarms' && (
        <>
          <AlarmFilterPanel filter={filter} onChange={(f) => { setFilter(f); setPage(0); }} />
          <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            <WidgetPanel title={`Top Alarms (${topAlarms.length})`} style={{ flex: 1 }}>
              {topAlarms.slice(0, 10).map((t) => (
                <div key={t.alarmType} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: 'var(--text-primary)' }}>
                  <span>{t.alarmType}</span>
                  <span style={{ color: '#f87171', fontWeight: 600 }}>{t.count}</span>
                </div>
              ))}
              {topAlarms.length === 0 && <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>No data</span>}
            </WidgetPanel>
            <WidgetPanel title="Alarm Types" style={{ flex: 1 }}>
              {typeCounts.map((s) => (
                <div key={s.alarmType} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: 'var(--text-primary)' }}>
                  <span>{s.alarmType}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{s.count}</span>
                </div>
              ))}
              {typeCounts.length === 0 && <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>No data</span>}
            </WidgetPanel>
          </div>
          <AlarmTable alarms={paginated} onAcknowledge={handleAcknowledge} loading={loading} />
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>‹ Prev</button>
              <span style={{ color: 'var(--text-muted)', fontSize: 13, padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}
                style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>Next ›</button>
            </div>
          )}
        </>
      )}

      {/* ── THRESHOLD CONFIG (EV-05) ── */}
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
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>Alarm Thresholds</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                Define metric thresholds — NMS auto-raises and clears alarms when values cross these boundaries.
              </div>
            </div>
            <button onClick={() => setShowForm((v) => !v)}
              style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              + New Threshold
            </button>
          </div>

          {/* Create form */}
          {showForm && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 700, marginBottom: 12 }}>New Threshold Rule</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Alarm Name</label>
                  <input style={{ ...inp, width: '100%' }} placeholder="e.g. Low RSSI" value={newThr.alarmName} onChange={(e) => setNewThr((p) => ({ ...p, alarmName: e.target.value }))} />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Metric</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.metricName} onChange={(e) => setNewThr((p) => ({ ...p, metricName: e.target.value }))}>
                    {METRIC_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Operator</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.operator} onChange={(e) => setNewThr((p) => ({ ...p, operator: e.target.value as AlarmThreshold['operator'] }))}>
                    <option value="GT">GT (&gt;)</option>
                    <option value="GTE">GTE (&gt;=)</option>
                    <option value="LT">LT (&lt;)</option>
                    <option value="LTE">LTE (&lt;=)</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Threshold Value</label>
                  <input style={{ ...inp, width: '100%' }} type="number" value={newThr.thresholdValue} onChange={(e) => setNewThr((p) => ({ ...p, thresholdValue: Number(e.target.value) }))} />
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Severity</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.severity} onChange={(e) => setNewThr((p) => ({ ...p, severity: e.target.value as AlarmThreshold['severity'] }))}>
                    <option value="CRITICAL">CRITICAL</option>
                    <option value="MAJOR">MAJOR</option>
                    <option value="MINOR">MINOR</option>
                    <option value="WARNING">WARNING</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: 'var(--text-muted)', fontSize: 10, display: 'block', marginBottom: 3 }}>Device Type</label>
                  <select style={{ ...inp, width: '100%' }} value={newThr.deviceType} onChange={(e) => setNewThr((p) => ({ ...p, deviceType: e.target.value as AlarmThreshold['deviceType'] }))}>
                    <option value="ALL">ALL</option>
                    <option value="BTS">BTS</option>
                    <option value="CPE">CPE</option>
                    <option value="IDU">IDU</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleCreateThreshold} disabled={thrLoading}
                  style={{ background: 'var(--accent-bg)', border: 'none', color: 'var(--accent)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                  {thrLoading ? 'Creating…' : 'Create Threshold'}
                </button>
                <button onClick={() => setShowForm(false)}
                  style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Threshold table */}
          {thrLoading && !thresholds.length && <div style={{ color: 'var(--accent)', fontSize: 13, padding: 16 }}>Loading thresholds…</div>}
          {thresholds.length === 0 && !thrLoading && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>⚙</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No thresholds configured</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Create threshold rules to auto-raise alarms when KPI metrics exceed defined limits.</div>
            </div>
          )}
          {thresholds.length > 0 && (
            <table className="nms-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Alarm Name', 'Metric', 'Condition', 'Value', 'Severity', 'Device Type', 'Status'].map((h) => (
                    <th key={h} style={{ padding: '8px 12px', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {thresholds.map((t) => {
                  const sev = SEV_BADGE[t.severity] ?? { bg: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
                  return (
                    <tr key={t.id ?? t.metricName} style={{ background: 'var(--bg-surface)' }}>
                      <td style={{ padding: '8px 12px', color: 'var(--text-primary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontWeight: 600 }}>{t.alarmName}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--accent)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace' }}>{t.metricName}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{t.operator}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-primary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)', fontFamily: 'monospace', fontWeight: 600 }}>{t.thresholdValue}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                        <span style={{ background: sev.bg, color: sev.color, padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{t.severity}</span>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, borderBottom: '1px solid var(--bg-base)' }}>{t.deviceType ?? 'ALL'}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bg-base)' }}>
                        <span style={{ color: t.enabled ? '#22c55e' : '#64748b', fontSize: 11 }}>{t.enabled ? '● Active' : '○ Disabled'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function WidgetPanel({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, maxHeight: 220, overflowY: 'auto', ...style }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      {children}
    </div>
  );
}

function playBeep(ref: React.MutableRefObject<AudioContext | null>): void {
  try {
    if (!ref.current) ref.current = new AudioContext();
    const ctx = ref.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch { /* AudioContext unavailable */ }
}

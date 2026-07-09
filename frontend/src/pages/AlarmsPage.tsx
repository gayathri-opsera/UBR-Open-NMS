import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Alarm, AlarmFilter, AlarmTypeStat, TopAlarm } from '../api/alarms.types';
import {
  acknowledgeAlarm, downloadAlarmExport, fetchAlarmTypeCounts, fetchAlarms, fetchTopAlarms,
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
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setLoadError(null);
    const timeout = setTimeout(() => setLoading(false), 30_000);
    Promise.all([
      fetchAlarms(filter).catch(() => [] as Alarm[]),
      fetchTopAlarms({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as TopAlarm[]),
      fetchAlarmTypeCounts({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as AlarmTypeStat[]),
    ])
      .then(([a, top, types]) => { setAlarms(a); setTopAlarms(top); setTypeCounts(types); })
      .catch(() => setLoadError('Unable to load alarms. Please check that the alarm service is running.'))
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
    CRITICAL: { bg: '#dc2626', color: '#fff' },
    MAJOR:    { bg: '#ea580c', color: '#fff' },
    MINOR:    { bg: '#d97706', color: '#fff' },
    WARNING:  { bg: '#2563eb', color: '#fff' },
  };

  return (
    <div role="main" aria-label="Alarm management" style={{ color: 'var(--text-primary)' }}>
      {loadError && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: 6, padding: '10px 16px', marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>⚠️</span> {loadError}
          <button onClick={() => setLoadError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>
      )}
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
          <button onClick={() => downloadAlarmExport(filter, 'csv')} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}>CSV</button>
          <button onClick={() => downloadAlarmExport(filter, 'xls')} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}>XLS</button>
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
            {/* Top Reported Alarms — SVG bar chart */}
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, flex: 2 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                Top Reported Alarms — Last 7 Days
              </div>
              {topAlarms.length === 0 ? (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>No data</span>
              ) : (
                <TopAlarmsBarChart alarms={topAlarms.slice(0, 8)} />
              )}
            </div>

            {/* Alarm type counts */}
            <WidgetPanel title={`Alarm Type Counts (${typeCounts.length})`} style={{ flex: 1 }}>
              {typeCounts.map((s) => {
                const maxCount = Math.max(...typeCounts.map((x) => x.count), 1);
                const pct = (s.count / maxCount) * 100;
                return (
                  <div key={s.alarmType} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{s.alarmType}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>{s.count}</span>
                    </div>
                    <div style={{ background: 'var(--bg-base)', borderRadius: 2, height: 4 }}>
                      <div style={{ background: 'var(--accent)', height: '100%', width: `${pct}%`, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
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
            <div role="alert" style={{ background: thrMsg.type === 'ok' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${thrMsg.type === 'ok' ? '#16a34a' : '#dc2626'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 14, color: thrMsg.type === 'ok' ? '#15803d' : '#dc2626', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
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

function TopAlarmsBarChart({ alarms }: { alarms: { alarmType: string; count: number }[] }) {
  const max = Math.max(...alarms.map((a) => a.count), 1);
  const BAR_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#3b82f6', '#a855f7'];
  const barH = 16; const barGap = 8; const labelW = 180; const chartW = 280;
  const totalH = alarms.length * (barH + barGap);
  return (
    <svg width={labelW + chartW + 50} height={totalH} style={{ display: 'block', overflow: 'visible' }}>
      {alarms.map((a, i) => {
        const barWidth = Math.max((a.count / max) * chartW, 4);
        const y = i * (barH + barGap);
        const color = BAR_COLORS[i % BAR_COLORS.length];
        return (
          <g key={a.alarmType}>
            <text x={labelW - 6} y={y + barH / 2 + 4} textAnchor="end" fill="var(--text-secondary)" fontSize={11}
              style={{ fontFamily: 'system-ui, sans-serif' }}>
              {(a.alarmType ?? '').length > 22 ? (a.alarmType ?? '').slice(0, 22) + '…' : (a.alarmType ?? 'Unknown')}
            </text>
            <rect x={labelW} y={y} width={barWidth} height={barH} fill={color} rx={3} fillOpacity={0.85} />
            <text x={labelW + barWidth + 6} y={y + barH / 2 + 4} fill={color} fontSize={11} fontWeight={700}
              style={{ fontFamily: 'monospace' }}>
              {a.count}
            </text>
          </g>
        );
      })}
    </svg>
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Alarm, AlarmFilter, AlarmTypeStat, TopAlarm } from '../api/alarms.types';
import { acknowledgeAlarm, buildExportUrl, fetchAlarmTypeCounts, fetchAlarms, fetchTopAlarms } from '../api/alarms.api';
import { AlarmTable } from '../components/alarms/AlarmTable';
import { AlarmFilterPanel } from '../components/alarms/AlarmFilterPanel';
import { useAlarmSse } from '../hooks/useAlarmSse';

const PAGE_SIZE = 50;

export default function AlarmsPage(): React.ReactElement {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [filter, setFilter] = useState<AlarmFilter>({});
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [topAlarms, setTopAlarms] = useState<TopAlarm[]>([]);
  const [typeCounts, setTypeCounts] = useState<AlarmTypeStat[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);

  // Initial load with 30s timeout + retry
  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => {
      setLoading(false);
    }, 30_000);

    Promise.all([
      fetchAlarms(filter),
      fetchTopAlarms({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as TopAlarm[]),
      fetchAlarmTypeCounts({ organizationId: filter.organizationId, networkId: filter.networkId }).catch(() => [] as AlarmTypeStat[]),
    ])
      .then(([a, top, types]) => { setAlarms(a); setTopAlarms(top); setTypeCounts(types); })
      .finally(() => { clearTimeout(timeout); setLoading(false); });

    return () => clearTimeout(timeout);
  }, [filter]);

  // SSE real-time updates
  const handleSseAlarm = useCallback((alarm: Alarm) => {
    setAlarms((prev) => {
      const exists = prev.findIndex((a) => a.id === alarm.id);
      if (exists >= 0) {
        const updated = [...prev];
        updated[exists] = alarm;
        return updated;
      }
      // Play sound for critical
      if (soundEnabled && alarm.severity === 'CRITICAL') {
        playBeep(audioRef);
      }
      return [alarm, ...prev];
    });
  }, [soundEnabled]);

  useAlarmSse(handleSseAlarm);

  const handleAcknowledge = async (id: string) => {
    const updated = await acknowledgeAlarm(id);
    setAlarms((prev) => prev.map((a) => a.id === id ? updated : a));
  };

  // Paginated + filtered display
  const filtered = useMemo(() => {
    let data = alarms;
    if (filter.severity?.length) {
      data = data.filter((a) => filter.severity!.includes(a.severity));
    }
    return data;
  }, [alarms, filter.severity]);

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <div role="main" aria-label="Alarm management">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#e2e8f0', margin: 0 }}>
          Alarms
          <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 15, marginLeft: 12 }} aria-live="polite">
            {loading ? 'loading…' : `(${filtered.length} active)`}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8 }} role="toolbar" aria-label="Alarm actions">
          <button
            onClick={() => setSoundEnabled((e) => !e)}
            aria-pressed={soundEnabled}
            aria-label={`Sound alerts ${soundEnabled ? 'on' : 'off'}`}
            style={{
              background: 'none', border: '1px solid #374151',
              color: soundEnabled ? '#60a5fa' : '#94a3b8',
              padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >
            🔔 Sound {soundEnabled ? 'ON' : 'OFF'}
          </button>
          <a
            href={buildExportUrl(filter, 'csv')}
            aria-label="Export alarms as CSV"
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}
          >
            Export CSV
          </a>
          <a
            href={buildExportUrl(filter, 'xls')}
            aria-label="Export alarms as XLS"
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}
          >
            Export XLS
          </a>
        </div>
      </div>

      <AlarmFilterPanel filter={filter} onChange={(f) => { setFilter(f); setPage(0); }} />

      {/* Widgets row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <WidgetPanel title={`Top Alarms (${topAlarms.length})`} style={{ flex: 1 }}>
          {topAlarms.slice(0, 10).map((t) => (
            <div key={t.alarmType} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: '#cbd5e1' }}>
              <span>{t.alarmType}</span>
              <span style={{ color: '#f87171', fontWeight: 600 }}>{t.count}</span>
            </div>
          ))}
          {topAlarms.length === 0 && <span style={{ color: '#475569', fontSize: 13 }}>No data</span>}
        </WidgetPanel>
        <WidgetPanel title="Alarm Types" style={{ flex: 1 }}>
          {typeCounts.map((s) => (
            <div key={s.alarmType} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: '#cbd5e1' }}>
              <span>{s.alarmType}</span>
              <span style={{ color: '#94a3b8' }}>{s.count}</span>
            </div>
          ))}
          {typeCounts.length === 0 && <span style={{ color: '#475569', fontSize: 13 }}>No data</span>}
        </WidgetPanel>
      </div>

      <AlarmTable alarms={paginated} onAcknowledge={handleAcknowledge} loading={loading} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}
          >
            ‹ Prev
          </button>
          <span style={{ color: '#64748b', fontSize: 13, padding: '4px 8px' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

function WidgetPanel({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  return (
    <div style={{
      background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16,
      maxHeight: 220, overflowY: 'auto', ...style,
    }}>
      <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </div>
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
  } catch {
    // AudioContext unavailable — ignore
  }
}

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAlarms, acknowledgeAlarm, downloadAlarmExport, fetchAlarmThresholds } from '../../api/alarms.api';
import type { Alarm, AlarmFilter, AlarmState } from '../../api/alarms.types';
import type { AlarmThreshold } from '../../api/alarms.api';
import { useAlarmSse } from '../hooks/useAlarmSse';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Modal } from '../components/common/Modal';
import { EmptyState, LoadingState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { useActor } from '../utils/actor';
import { logger } from '../utils/logger';

const SEV_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'MAJOR', label: 'Major' },
  { value: 'MINOR', label: 'Minor' },
  { value: 'WARNING', label: 'Warning' },
];

const STATE_OPTIONS = [
  { value: '', label: 'All states' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'CLEARED', label: 'Cleared' },
];

const SEV_VARIANT: Record<string, 'critical' | 'major' | 'minor' | 'warning' | 'clear' | 'default'> = {
  CRITICAL: 'critical', MAJOR: 'major', MINOR: 'minor', WARNING: 'warning', CLEAR: 'clear',
};

function formatAge(ts: string | number | undefined): string {
  if (!ts) return '—';
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function V2AlarmsPage() {
  const [searchParams] = useSearchParams();
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  // Seed filter from URL params so dashboard drilldowns land filtered
  const [filter, setFilter] = useState<AlarmFilter>(() => {
    const init: AlarmFilter = { state: 'ACTIVE' };
    const severity = searchParams.get('severity') as Alarm['severity'] | null;
    const state = searchParams.get('state') as AlarmState | null;
    if (severity) init.severity = [severity];
    if (state) init.state = state;
    return init;
  });
  // Prefer explicit 'search' param, fall back to deviceId for alarm drilldown from dashboard
  const [search, setSearch] = useState(
    searchParams.get('search') ?? searchParams.get('deviceId') ?? ''
  );
  const [acking, setAcking] = useState<Set<string>>(new Set());
  const [thresholds, setThresholds] = useState<AlarmThreshold[]>([]);
  const [showThresholds, setShowThresholds] = useState(false);
  const { addToast } = useToast();
  const actor = useActor();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAlarms(filter);
      setAlarms(data);
    } catch (e) {
      logger.error('Failed to fetch alarms', e);
      addToast('Failed to load alarms', 'error');
    } finally {
      setLoading(false);
    }
  }, [filter, addToast]);

  useEffect(() => { load(); }, [load]);

  // SSE real-time updates
  useAlarmSse((alarm) => {
    setAlarms((prev) => {
      const idx = prev.findIndex((a) => a.id === alarm.id);
      if (idx >= 0) { const n = [...prev]; n[idx] = alarm; return n; }
      return [alarm, ...prev];
    });
  });

  const handleAck = async (id: string) => {
    setAcking((s) => new Set(s).add(id));
    try {
      const updated = await acknowledgeAlarm(id, actor);
      setAlarms((prev) => prev.map((a) => (a.id === id ? updated : a)));
      addToast('Alarm acknowledged', 'success');
    } catch (e) {
      logger.error('Ack failed', e);
      addToast('Failed to acknowledge alarm', 'error');
    } finally {
      setAcking((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const handleExport = async (fmt: 'csv' | 'xls') => {
    try {
      await downloadAlarmExport(filter, fmt);
    } catch {
      addToast('Export failed', 'error');
    }
  };

  const handleLoadThresholds = async () => {
    try {
      const data = await fetchAlarmThresholds();
      setThresholds(data);
      setShowThresholds(true);
    } catch {
      addToast('Failed to load thresholds', 'error');
    }
  };

  const visible = alarms.filter((a) => {
    if (filter.severity?.length && !filter.severity.includes(a.severity)) return false;
    if (filter.state && a.state !== filter.state) return false;
    if (search) {
      const q = search.toLowerCase();
      if (![a.deviceId, a.alarmType, a.alarmName, a.severity, a.state].some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">Alarms</h1>
        <div className="vf-page-actions">
          <Button variant="ghost" size="sm" onClick={handleLoadThresholds}>Thresholds</Button>
          <Button variant="ghost" size="sm" onClick={() => handleExport('csv')}>CSV</Button>
          <Button variant="ghost" size="sm" onClick={() => handleExport('xls')}>XLS</Button>
          <Button variant="primary" size="sm" onClick={load}>Refresh</Button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input
          placeholder="Search alarms…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        <Select
          options={SEV_OPTIONS}
          value={filter.severity?.[0] ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, severity: e.target.value ? [e.target.value as Alarm['severity']] : undefined }))}
          style={{ width: 160 }}
        />
        <Select
          options={STATE_OPTIONS}
          value={filter.state ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, state: (e.target.value as AlarmState) || undefined }))}
          style={{ width: 160 }}
        />
        <Button variant="ghost" size="sm" onClick={() => { setFilter({ state: 'ACTIVE' }); setSearch(''); }}>
          Clear
        </Button>
      </div>

      {/* Drilldown active-filter banner */}
      {filter.severity && filter.severity.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
          background: 'var(--vf-accent-subtle)', border: '1px solid var(--vf-accent)',
          borderRadius: 8, fontSize: 12,
        }}>
          <span style={{ color: 'var(--vf-accent)', fontWeight: 700 }}>Drilldown filter active:</span>
          <span style={{ background: 'var(--vf-elevated)', padding: '2px 8px', borderRadius: 4 }}>Severity: {filter.severity?.join(', ')}</span>
          <button onClick={() => setFilter({ state: 'ACTIVE' })} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-accent)', fontSize: 12, fontWeight: 600 }}>
            ✕ Clear
          </button>
        </div>
      )}

      {/* Stats row */}
      {!loading && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'] as const).map((sev) => {
            const count = alarms.filter((a) => a.severity === sev && a.state === 'ACTIVE').length;
            return count > 0 ? (
              <Badge key={sev} variant={SEV_VARIANT[sev]} dot>
                {count} {sev}
              </Badge>
            ) : null;
          })}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <LoadingState label="Loading alarms…" />
      ) : visible.length === 0 ? (
        <EmptyState title="No alarms" description="No alarms match the current filters." />
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--vf-font-sans)', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--vf-surface)' }}>
                {['Severity', 'Type', 'Name', 'Device', 'State', 'Time', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((alarm) => (
                <tr key={alarm.id} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={SEV_VARIANT[alarm.severity] ?? 'default'} dot>{alarm.severity}</Badge>
                  </td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-primary)', fontWeight: 500 }}>{alarm.alarmType}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alarm.alarmName}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{alarm.deviceId}</td>
                  <td style={{ padding: '9px 12px' }}>
                    <Badge variant={alarm.state === 'ACTIVE' ? 'danger' : alarm.state === 'ACKNOWLEDGED' ? 'warning' : 'success'}>
                      {alarm.state}
                    </Badge>
                  </td>
                  <td style={{ padding: '9px 12px', color: 'var(--vf-text-muted)', whiteSpace: 'nowrap', fontSize: 12 }}>{formatAge(alarm.timestamp)}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {alarm.state === 'ACTIVE' && (
                      <Button variant="secondary" size="sm" loading={acking.has(alarm.id)} onClick={() => handleAck(alarm.id)}>
                        Ack
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Threshold modal */}
      <Modal open={showThresholds} onClose={() => setShowThresholds(false)} title="Alarm Thresholds" size="lg">
        {thresholds.length === 0 ? (
          <EmptyState title="No thresholds configured" description="Add threshold rules to trigger alarms automatically." compact />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'var(--vf-font-sans)' }}>
            <thead>
              <tr>
                {['Metric', 'Operator', 'Value', 'Severity', 'Alarm Name', 'Enabled'].map((h) => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {thresholds.map((t, i) => (
                <tr key={t.id ?? i} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                  <td style={{ padding: '8px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{t.metricName}</td>
                  <td style={{ padding: '8px 10px' }}>{t.operator}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--vf-accent)' }}>{t.thresholdValue}</td>
                  <td style={{ padding: '8px 10px' }}><Badge variant={SEV_VARIANT[t.severity] ?? 'default'}>{t.severity}</Badge></td>
                  <td style={{ padding: '8px 10px' }}>{t.alarmName}</td>
                  <td style={{ padding: '8px 10px' }}><Badge variant={t.enabled ? 'success' : 'default'}>{t.enabled ? 'Yes' : 'No'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}

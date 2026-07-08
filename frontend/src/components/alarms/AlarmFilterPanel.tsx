import React from 'react';
import type { AlarmFilter, Severity } from '../../api/alarms.types';

const SEVERITIES: Severity[] = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'CLEAR'];

const CIRCLES = ['All Circles', 'Delhi', 'Mumbai', 'Chennai', 'Bangalore', 'Hyderabad', 'Kolkata', 'Pune'];
const DEVICE_TYPES = ['All Types', 'BTS', 'CPE', 'IDU'];
const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: '1h', hours: 1 }, { label: '6h', hours: 6 },
  { label: '24h', hours: 24 }, { label: '7d', hours: 168 },
];

interface Props {
  filter: AlarmFilter;
  onChange(filter: AlarmFilter): void;
}

export function AlarmFilterPanel({ filter, onChange }: Props): React.ReactElement {
  const toggleSeverity = (sev: Severity) => {
    const current = filter.severity ?? [];
    const next = current.includes(sev)
      ? current.filter((s) => s !== sev)
      : [...current, sev];
    onChange({ ...filter, severity: next.length > 0 ? next : undefined });
  };

  const applyTimePreset = (hours: number) => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    onChange({ ...filter, from, to });
  };

  const label: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 };
  const input: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '6px 10px', fontSize: 12, width: '100%', boxSizing: 'border-box' as const,
  };

  const SEV_ACTIVE: Record<string, { bg: string; border: string; color: string }> = {
    CRITICAL: { bg: '#dc2626', border: '#dc2626', color: '#fff' },
    MAJOR:    { bg: '#ea580c', border: '#ea580c', color: '#fff' },
    MINOR:    { bg: '#d97706', border: '#d97706', color: '#fff' },
    WARNING:  { bg: '#2563eb', border: '#2563eb', color: '#fff' },
    CLEAR:    { bg: '#16a34a', border: '#16a34a', color: '#fff' },
  };

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
      borderRadius: 8, padding: 14, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' as const, alignItems: 'flex-start' }}>
        {/* Severity multi-select */}
        <div>
          <span style={label}>Severity</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {SEVERITIES.map((sev) => {
              const active = filter.severity?.includes(sev);
              const ac = SEV_ACTIVE[sev];
              return (
                <button key={sev} onClick={() => toggleSeverity(sev)}
                  style={{ background: active ? ac.bg : 'none', border: `1px solid ${active ? ac.border : 'var(--border-strong)'}`, color: active ? ac.color : 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 400 }}>
                  {sev}
                </button>
              );
            })}
          </div>
        </div>

        {/* Circle filter */}
        <div style={{ flex: '0 0 140px' }}>
          <label style={label}>Circle</label>
          <select style={input}
            value={(filter as Record<string, unknown>).circle as string ?? 'All Circles'}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...filter } as Record<string, unknown>;
              if (v === 'All Circles') delete next.circle; else next.circle = v;
              onChange(next as AlarmFilter);
            }}>
            {CIRCLES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Device Type filter */}
        <div style={{ flex: '0 0 120px' }}>
          <label style={label}>Device Type</label>
          <select style={input}
            value={(filter as Record<string, unknown>).deviceType as string ?? 'All Types'}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...filter } as Record<string, unknown>;
              if (v === 'All Types') delete next.deviceType; else next.deviceType = v;
              onChange(next as AlarmFilter);
            }}>
            {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* Time presets */}
        <div>
          <span style={label}>Quick Range</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {TIME_PRESETS.map((p) => (
              <button key={p.label} onClick={() => applyTimePreset(p.hours)}
                style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* From / To */}
        <div style={{ flex: '0 0 180px' }}>
          <label style={label}>From</label>
          <input type="datetime-local" style={input}
            value={filter.from?.slice(0, 16) ?? ''}
            onChange={(e) => onChange({ ...filter, from: e.target.value || undefined })}
          />
        </div>
        <div style={{ flex: '0 0 180px' }}>
          <label style={label}>To</label>
          <input type="datetime-local" style={input}
            value={filter.to?.slice(0, 16) ?? ''}
            onChange={(e) => onChange({ ...filter, to: e.target.value || undefined })}
          />
        </div>

        {/* Clear */}
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button onClick={() => onChange({})}
            style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            ✕ Clear
          </button>
        </div>
      </div>
    </div>
  );
}

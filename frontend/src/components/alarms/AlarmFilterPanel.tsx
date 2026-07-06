import React from 'react';
import type { AlarmFilter, Severity } from '../../api/alarms.types';

const SEVERITIES: Severity[] = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'CLEAR'];

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

  const label: React.CSSProperties = { color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 };
  const input: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4,
    color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{
      background: '#0d1b2a', border: '1px solid #1e293b',
      borderRadius: 8, padding: 16, marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap' as const,
    }}>
      {/* Severity multi-select */}
      <div>
        <span style={label}>Severity</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {SEVERITIES.map((sev) => {
            const active = filter.severity?.includes(sev);
            return (
              <button
                key={sev}
                onClick={() => toggleSeverity(sev)}
                style={{
                  background: active ? '#1e3a5f' : 'none',
                  border: `1px solid ${active ? '#60a5fa' : '#374151'}`,
                  color: active ? '#60a5fa' : '#64748b',
                  padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                }}
              >
                {sev}
              </button>
            );
          })}
        </div>
      </div>

      {/* Network */}
      <div style={{ flex: '0 0 160px' }}>
        <label style={label}>Network ID</label>
        <input
          style={input}
          value={filter.networkId ?? ''}
          onChange={(e) => onChange({ ...filter, networkId: e.target.value || undefined })}
          placeholder="all"
        />
      </div>

      {/* From / To */}
      <div>
        <label style={label}>From</label>
        <input type="datetime-local" style={input}
          value={filter.from?.slice(0, 16) ?? ''}
          onChange={(e) => onChange({ ...filter, from: e.target.value || undefined })}
        />
      </div>
      <div>
        <label style={label}>To</label>
        <input type="datetime-local" style={input}
          value={filter.to?.slice(0, 16) ?? ''}
          onChange={(e) => onChange({ ...filter, to: e.target.value || undefined })}
        />
      </div>

      {/* Clear */}
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <button
          onClick={() => onChange({})}
          style={{
            background: 'none', border: '1px solid #374151', color: '#9ca3af',
            padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

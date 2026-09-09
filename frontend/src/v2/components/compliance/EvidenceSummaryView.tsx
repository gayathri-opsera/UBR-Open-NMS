/**
 * Evidence Summary View for WO-068 CTSO/TSOC Evidence Export
 * Displays alarm timeline, audit events, and affected devices with collapsible sections
 */

import React, { useState } from 'react';
import { Badge } from '../common/Badge';
import type { AlarmTimelineEntry, AuditEvent, AffectedDevice } from '../../../api/reports.types';

export interface EvidenceSummaryViewProps {
  alarmTimeline: AlarmTimelineEntry[];
  auditEvents: AuditEvent[];
  affectedDevices: AffectedDevice[];
}

export function EvidenceSummaryView({ alarmTimeline, auditEvents, affectedDevices }: EvidenceSummaryViewProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['alarms']));

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const alarmCount = alarmTimeline.filter((a) => !a.status).length;
  const auditCount = auditEvents.filter((e) => !e.status).length;
  const deviceCount = affectedDevices.filter((d) => d.deviceId).length;

  return (
    <div
      style={{
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--vf-shadow-low)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--vf-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--vf-text-primary)' }}>Evidence Summary</div>
        <button
          onClick={() => {
            if (expandedSections.size === 3) {
              setExpandedSections(new Set());
            } else {
              setExpandedSections(new Set(['alarms', 'audit', 'devices']));
            }
          }}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--vf-accent)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {expandedSections.size === 3 ? 'Collapse All' : 'Expand All'}
        </button>
      </div>

      {/* Alarm Timeline Section */}
      <CollapsibleSection
        title="Alarm Timeline"
        count={alarmCount}
        isExpanded={expandedSections.has('alarms')}
        onToggle={() => toggleSection('alarms')}
      >
        {alarmCount === 0 ? (
          <EmptyMessage>No alarm data available</EmptyMessage>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {alarmTimeline
              .filter((a) => !a.status)
              .map((alarm, idx) => (
                <AlarmTimelineItem key={idx} alarm={alarm} />
              ))}
          </div>
        )}
      </CollapsibleSection>

      {/* Audit Events Section */}
      <CollapsibleSection
        title="Audit Events"
        count={auditCount}
        isExpanded={expandedSections.has('audit')}
        onToggle={() => toggleSection('audit')}
      >
        {auditCount === 0 ? (
          <EmptyMessage>No audit events available</EmptyMessage>
        ) : (
          <AuditEventsTable events={auditEvents.filter((e) => !e.status)} />
        )}
      </CollapsibleSection>

      {/* Affected Devices Section */}
      <CollapsibleSection
        title="Affected Devices"
        count={deviceCount}
        isExpanded={expandedSections.has('devices')}
        onToggle={() => toggleSection('devices')}
      >
        {deviceCount === 0 ? (
          <EmptyMessage>No device inventory available</EmptyMessage>
        ) : (
          <AffectedDevicesTable devices={affectedDevices.filter((d) => d.deviceId)} />
        )}
      </CollapsibleSection>
    </div>
  );
}

// ── Collapsible Section ──────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  count,
  isExpanded,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '14px 20px',
          background: isExpanded ? 'var(--vf-elevated)' : 'transparent',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>{title}</span>
          <Badge variant="default" style={{ fontSize: 11 }}>
            {count}
          </Badge>
        </div>
        <span style={{ fontSize: 14, color: 'var(--vf-accent)' }}>{isExpanded ? '▲' : '▼'}</span>
      </button>
      {isExpanded && <div style={{ padding: '16px 20px' }}>{children}</div>}
    </div>
  );
}

// ── Alarm Timeline Item ──────────────────────────────────────────────────────

function AlarmTimelineItem({ alarm }: { alarm: AlarmTimelineEntry }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        background: 'var(--vf-elevated)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)' }}>
          {alarm.alarmId}
        </span>
        {alarm.severity && <Badge variant={alarm.severity === 'CRITICAL' ? 'critical' : 'major'}>{alarm.severity}</Badge>}
        {alarm.deviceId && (
          <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Device: {alarm.deviceId}</span>
        )}
      </div>
      {alarm.alarmType && (
        <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 8 }}>{alarm.alarmType}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, borderLeft: '2px solid var(--vf-accent)' }}>
        {(alarm.lifecycleEvents || []).map((event, idx) => (
          <div key={idx} style={{ fontSize: 12, color: 'var(--vf-text-secondary)', lineHeight: 1.6 }}>
            <span style={{ fontWeight: 600, color: 'var(--vf-accent)' }}>{event.state}</span>
            <span style={{ marginLeft: 8, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)' }}>
              {new Date(event.timestamp).toLocaleString()}
            </span>
            {event.acknowledgedBy && <span style={{ marginLeft: 8 }}>by {event.acknowledgedBy}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Audit Events Table ───────────────────────────────────────────────────────

function AuditEventsTable({ events }: { events: AuditEvent[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
            <th style={{ ...tableHeaderStyle }}>Timestamp</th>
            <th style={{ ...tableHeaderStyle }}>Actor</th>
            <th style={{ ...tableHeaderStyle }}>Action</th>
            <th style={{ ...tableHeaderStyle }}>Resource</th>
            <th style={{ ...tableHeaderStyle }}>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, idx) => (
            <tr key={idx} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
              <td style={tableCellStyle}>
                <span style={{ fontFamily: 'var(--vf-font-mono)' }}>
                  {new Date(event.timestamp).toLocaleString()}
                </span>
              </td>
              <td style={tableCellStyle}>{event.actor}</td>
              <td style={tableCellStyle}>
                <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>{event.action}</span>
              </td>
              <td style={tableCellStyle}>
                <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{event.resource}</span>
              </td>
              <td style={tableCellStyle}>
                <Badge variant={event.outcome === 'success' ? 'success' : 'danger'}>{event.outcome}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Affected Devices Table ───────────────────────────────────────────────────

function AffectedDevicesTable({ devices }: { devices: AffectedDevice[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {devices.map((device, idx) => (
        <div
          key={idx}
          style={{
            padding: '12px 16px',
            background: 'var(--vf-elevated)',
            border: '1px solid var(--vf-border-subtle)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)', marginBottom: 6 }}>
            {device.deviceId}
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', lineHeight: 1.6 }}>
            {device.deviceType && <div>Type: {device.deviceType}</div>}
            {device.model && <div>Model: {device.model}</div>}
            {device.networkId && <div>Network: {device.networkId}</div>}
            {device.status && (
              <div style={{ marginTop: 4 }}>
                <Badge variant={device.status === 'ONLINE' ? 'online' : 'offline'}>{device.status}</Badge>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: 24, color: 'var(--vf-text-muted)', fontSize: 13 }}>
      {children}
    </div>
  );
}

const tableHeaderStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--vf-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const tableCellStyle: React.CSSProperties = {
  padding: '10px 12px',
  color: 'var(--vf-text-secondary)',
};

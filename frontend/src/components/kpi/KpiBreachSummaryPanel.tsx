/**
 * KPI Breach Summary Panel — WO-046
 *
 * Lists active threshold violations per device with alarm context links.
 * Rendered below the KPI drilldown charts when breaches exist.
 * Respects both WARNING and CRITICAL severity levels.
 * A breach without an active alarm clearly states the alarm was cleared/suppressed.
 */
import React from 'react';
import type { KpiBreachAnnotation, KpiThresholdDefinition, ThresholdSeverity } from '../../api/kpi.types';
import { breachSeverityColor, breachSeverityVariant } from '../../api/kpi.types';
import { Badge } from '../../v2/components/common/Badge';

interface KpiBreachSummaryPanelProps {
  breaches: KpiBreachAnnotation[];
  thresholds: KpiThresholdDefinition[];
  onAlarmClick?: (alarmId: string) => void;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function alarmStateLabel(state: string | undefined): { label: string; variant: 'danger' | 'warning' | 'default' } {
  switch (state) {
    case 'ACTIVE':     return { label: 'Active',     variant: 'danger' };
    case 'CLEARED':    return { label: 'Cleared',    variant: 'default' };
    case 'SUPPRESSED': return { label: 'Suppressed', variant: 'warning' };
    default:           return { label: 'No alarm',   variant: 'default' };
  }
}

export function KpiBreachSummaryPanel({
  breaches,
  thresholds,
  onAlarmClick,
}: KpiBreachSummaryPanelProps): React.ReactElement | null {
  if (breaches.length === 0) return null;

  // Group breaches by severity for display ordering
  const critical = breaches.filter((b) => b.severity === 'CRITICAL');
  const warning  = breaches.filter((b) => b.severity === 'WARNING');
  const ordered  = [...critical, ...warning];

  return (
    <div
      role="region"
      aria-label="Active threshold breach summary"
      style={{
        background: 'var(--vf-surface)',
        border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: 10,
        padding: '14px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
          Threshold Breaches
        </span>
        <span
          style={{
            background: critical.length > 0 ? 'var(--vf-danger)' : 'var(--vf-warning)',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            borderRadius: 10,
            padding: '1px 7px',
          }}
          aria-label={`${breaches.length} breach${breaches.length > 1 ? 'es' : ''}`}
        >
          {breaches.length}
        </span>
        {critical.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--vf-danger)', fontWeight: 600 }}>
            {critical.length} critical
          </span>
        )}
        {warning.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--vf-warning)', fontWeight: 600 }}>
            {warning.length} warning
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
          aria-label="Breach details"
        >
          <thead>
            <tr style={{ background: 'rgba(30,41,59,0.5)' }}>
              {['Severity', 'Metric', 'Threshold', 'Measured', 'Time', 'Alarm Status', 'Action'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  style={{
                    padding: '7px 10px',
                    textAlign: 'left',
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--vf-text-muted)',
                    borderBottom: '1px solid var(--vf-border-subtle)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((breach, i) => {
              const def = thresholds.find((t) => t.thresholdId === breach.thresholdId);
              const alarmInfo = alarmStateLabel(breach.alarmState);
              const severityColor = breachSeverityColor(breach.severity as ThresholdSeverity);
              const severityVariant = breachSeverityVariant(breach.severity as ThresholdSeverity);

              return (
                <tr
                  key={`breach-${breach.thresholdId}-${i}`}
                  style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}
                >
                  <td style={{ padding: '7px 10px' }}>
                    <Badge variant={severityVariant}>
                      {breach.severity}
                    </Badge>
                  </td>
                  <td style={{ padding: '7px 10px', fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)', fontSize: 11 }}>
                    {def?.metricName ?? breach.thresholdId}
                  </td>
                  <td style={{ padding: '7px 10px', color: severityColor, fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                    {def ? `${def.operator === 'ABOVE' ? '>' : '<'}${def.value}${def.unit ? ` ${def.unit}` : ''}` : '—'}
                  </td>
                  <td style={{ padding: '7px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                    {breach.value.toFixed(2)}{def?.unit ? ` ${def.unit}` : ''}
                  </td>
                  <td style={{ padding: '7px 10px', color: 'var(--vf-text-muted)', fontSize: 11 }}>
                    {relTime(breach.timestamp)}
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Badge variant={alarmInfo.variant}>{alarmInfo.label}</Badge>
                      {!breach.relatedAlarmId && (
                        <span
                          style={{ fontSize: 10, color: 'var(--vf-text-dim)' }}
                          title="No alarm created for this breach, or alarm was cleared/suppressed before linking"
                        >
                          ⓘ
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    {breach.relatedAlarmId && breach.alarmState === 'ACTIVE' ? (
                      <button
                        onClick={() => onAlarmClick?.(breach.relatedAlarmId!)}
                        aria-label={`Go to alarm ${breach.alarmLabel ?? breach.relatedAlarmId}`}
                        style={{
                          background: 'rgba(239,68,68,0.15)',
                          border: '1px solid var(--vf-danger)',
                          color: 'var(--vf-danger)',
                          fontSize: 10,
                          fontWeight: 600,
                          borderRadius: 4,
                          padding: '2px 8px',
                          cursor: 'pointer',
                        }}
                      >
                        View Alarm
                      </button>
                    ) : (
                      <span style={{ fontSize: 10, color: 'var(--vf-text-dim)' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

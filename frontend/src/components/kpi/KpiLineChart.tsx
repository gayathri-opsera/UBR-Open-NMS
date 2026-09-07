/**
 * KPI Line Chart with threshold overlays and breach markers — WO-046
 *
 * Renders a metric sparkline with:
 *  - Threshold reference lines (WARNING amber, CRITICAL red) when provided
 *  - Breach dots at data points that crossed a threshold
 *  - Related alarm link badge when a breach has an associated alarm
 *  - Accessible severity indicators that do not rely on color alone
 */
import type { KpiSeries, KpiParam, KpiThreshold, KpiThresholdDefinition, KpiBreachAnnotation } from '../../api/kpi.types';
import { classifyBreach } from '../../api/kpi.types';
import React from 'react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Area, AreaChart, Dot,
} from 'recharts';

interface Props {
  series: KpiSeries;
  /** Legacy single-threshold support — still accepted for backwards compat. */
  threshold?: KpiThreshold;
  /** Multi-severity threshold definitions (WO-046). */
  thresholdDefinitions?: KpiThresholdDefinition[];
  /** Breach annotations for this series (WO-046). */
  breachAnnotations?: KpiBreachAnnotation[];
  /** Called when a breach marker or alarm link is clicked. */
  onBreachClick?: (annotation: KpiBreachAnnotation) => void;
}

const CHART_COLOR   = '#60a5fa';
const WARN_COLOR    = '#f59e0b';
const CRIT_COLOR    = '#ef4444';

const PARAM_LABEL: Record<KpiParam, string> = {
  rssi: 'RSSI (dBm)',
  snr: 'SNR (dB)',
  cpuUtilization: 'CPU (%)',
  memoryUtilization: 'Memory (%)',
  throughputUL: 'UL Throughput (Mbps)',
  throughputDL: 'DL Throughput (Mbps)',
  channelUtilization: 'Channel Util (%)',
  connectedClients: 'Connected Clients',
  txPower: 'Tx Power (dBm)',
  retryRate: 'Retry Rate (%)',
  temperature: 'Temperature (°C)',
};

function formatTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Custom dot renderer: highlights breach points with a distinct marker. */
function BreachDot(props: {
  cx?: number; cy?: number; payload?: { avg: number | null; time: string };
  thresholdDefs: KpiThresholdDefinition[];
  metricName: string;
}) {
  const { cx, cy, payload, thresholdDefs, metricName } = props;
  if (!cx || !cy || !payload) return null;
  const severity = classifyBreach(metricName, payload.avg, thresholdDefs);
  if (!severity) return null;
  const color = severity === 'CRITICAL' ? CRIT_COLOR : WARN_COLOR;
  return (
    <Dot
      cx={cx}
      cy={cy}
      r={4}
      fill={color}
      stroke="#fff"
      strokeWidth={1}
      aria-label={`${severity} breach at ${payload.time}: ${payload.avg}`}
    />
  );
}

export function KpiLineChart({ series, threshold, thresholdDefinitions = [], breachAnnotations = [], onBreachClick }: Props): React.ReactElement {
  // Build chart data — include breach info per point
  const data = series.data.map((d) => ({
    time:  formatTs(d.bucketStart),
    ts:    d.bucketStart,
    avg:   d.avg,
    min:   d.min,
    max:   d.max,
  }));

  // Merge legacy threshold into definition list for unified handling
  const allDefs: KpiThresholdDefinition[] = [...thresholdDefinitions];
  if (threshold && thresholdDefinitions.length === 0) {
    allDefs.push({
      thresholdId: threshold.id ?? 'legacy',
      metricName:  String(threshold.metric),
      severity:    (threshold.severity?.toUpperCase() as 'WARNING' | 'CRITICAL') || 'CRITICAL',
      operator:    threshold.direction ?? 'ABOVE',
      value:       threshold.raiseThreshold,
      unit:        '',
      label:       'Threshold',
    });
  }

  // Determine overall breach state for border highlight
  const hasBreaches  = data.some((d) => classifyBreach(series.param, d.avg, allDefs) !== null);
  const hasCritical  = data.some((d) => classifyBreach(series.param, d.avg, allDefs) === 'CRITICAL');
  const borderColor  = hasCritical ? CRIT_COLOR : hasBreaches ? WARN_COLOR : '#1e293b';

  // Deduplicate threshold lines by value + severity for rendering
  const thresholdLines = allDefs.filter(
    (t, i, arr) => arr.findIndex((x) => x.value === t.value && x.severity === t.severity) === i
  );

  // Count active alarm links in breach annotations
  const alarmLinks = breachAnnotations.filter((b) => b.relatedAlarmId && b.alarmState === 'ACTIVE');

  return (
    <div
      aria-label={`KPI chart for ${PARAM_LABEL[series.param] ?? series.param}`}
      style={{
        background: '#0d1b2a',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: '12px 16px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <span style={{
          color: hasCritical ? CRIT_COLOR : hasBreaches ? WARN_COLOR : '#94a3b8',
          fontSize: 13, fontWeight: 600,
        }}>
          {PARAM_LABEL[series.param] ?? series.param}
          {hasCritical  && <span aria-label="Critical breach" style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, background: CRIT_COLOR, color: '#fff', padding: '1px 5px', borderRadius: 3 }}>CRIT</span>}
          {!hasCritical && hasBreaches && <span aria-label="Warning breach" style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, background: WARN_COLOR, color: '#000', padding: '1px 5px', borderRadius: 3 }}>WARN</span>}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {alarmLinks.length > 0 && (
            <button
              onClick={() => alarmLinks[0] && onBreachClick?.(alarmLinks[0])}
              aria-label={`${alarmLinks.length} active alarm${alarmLinks.length > 1 ? 's' : ''} linked`}
              style={{
                background: 'rgba(239,68,68,0.15)',
                border: `1px solid ${CRIT_COLOR}`,
                color: CRIT_COLOR,
                fontSize: 10, fontWeight: 700,
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
              }}
            >
              🔔 {alarmLinks.length} alarm{alarmLinks.length > 1 ? 's' : ''}
            </button>
          )}
          <span style={{ color: '#475569', fontSize: 12 }}>{series.deviceId}</span>
        </div>
      </div>

      {/* Threshold legend */}
      {thresholdLines.length > 0 && (
        <div
          role="list"
          aria-label="Threshold legend"
          style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}
        >
          {thresholdLines.map((t) => (
            <span
              key={`${t.thresholdId}-${t.severity}`}
              role="listitem"
              style={{ fontSize: 10, color: t.severity === 'CRITICAL' ? CRIT_COLOR : WARN_COLOR, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <svg width="14" height="2" aria-hidden="true">
                <line x1="0" y1="1" x2="14" y2="1" stroke={t.severity === 'CRITICAL' ? CRIT_COLOR : WARN_COLOR} strokeWidth="2" strokeDasharray="3 2" />
              </svg>
              {t.label ?? t.severity} ({t.value}{t.unit ? ` ${t.unit}` : ''})
            </span>
          ))}
        </div>
      )}

      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`grad-${series.param}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={CHART_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#0f172a" />
          <XAxis dataKey="time" tick={{ fill: '#475569', fontSize: 10 }} />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} width={40} />
          <Tooltip
            contentStyle={{ background: '#0d1b2a', border: '1px solid #1e293b', fontSize: 12 }}
            formatter={(v: number) => [v?.toFixed(2), 'Avg']}
          />

          {/* Threshold reference lines — WARNING amber, CRITICAL red */}
          {thresholdLines.map((t) => (
            <ReferenceLine
              key={`ref-${t.thresholdId}-${t.severity}`}
              y={t.value}
              stroke={t.severity === 'CRITICAL' ? CRIT_COLOR : WARN_COLOR}
              strokeDasharray="4 2"
              strokeWidth={1.5}
              label={{
                value: `${t.label ?? t.severity} ${t.value}${t.unit ? ` ${t.unit}` : ''}`,
                fill: t.severity === 'CRITICAL' ? CRIT_COLOR : WARN_COLOR,
                fontSize: 9,
                position: 'insideTopRight',
              }}
            />
          ))}

          <Area
            type="monotone"
            dataKey="avg"
            stroke={CHART_COLOR}
            fill={`url(#grad-${series.param})`}
            dot={(dotProps) => (
              <BreachDot
                key={`dot-${dotProps.index}`}
                {...dotProps}
                thresholdDefs={allDefs}
                metricName={series.param}
              />
            )}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

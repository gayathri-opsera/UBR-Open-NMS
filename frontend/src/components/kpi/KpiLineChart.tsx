import type { KpiSeries, KpiParam, KpiThreshold } from '../../api/kpi.types';
import React from 'react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Area, AreaChart,
} from 'recharts';

interface Props {
  series: KpiSeries;
  threshold?: KpiThreshold;
}

const CHART_COLOR = '#60a5fa';
const BREACH_COLOR = '#ef4444';

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
};

function formatTs(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function KpiLineChart({ series, threshold }: Props): React.ReactElement {
  const data = series.data.map((d) => ({
    time: formatTs(d.bucketStart),
    avg: d.avg,
    min: d.min,
    max: d.max,
  }));

  const isBreached = threshold
    ? series.data.some((d) => {
        const above = threshold.direction !== 'BELOW';
        return above ? d.avg >= threshold.raiseThreshold : d.avg <= threshold.raiseThreshold;
      })
    : false;

  return (
    <div style={{
      background: '#0d1b2a', border: `1px solid ${isBreached ? BREACH_COLOR : '#1e293b'}`,
      borderRadius: 8, padding: '12px 16px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ color: isBreached ? BREACH_COLOR : '#94a3b8', fontSize: 13, fontWeight: 600 }}>
          {PARAM_LABEL[series.param] ?? series.param}
        </span>
        <span style={{ color: '#475569', fontSize: 12 }}>{series.deviceId}</span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`grad-${series.param}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={CHART_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#0f172a" />
          <XAxis dataKey="time" tick={{ fill: '#475569', fontSize: 10 }} />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} width={40} />
          <Tooltip contentStyle={{ background: '#0d1b2a', border: '1px solid #1e293b', fontSize: 12 }} />
          {threshold && (
            <ReferenceLine
              y={threshold.raiseThreshold}
              stroke={BREACH_COLOR}
              strokeDasharray="4 2"
              label={{ value: `Threshold`, fill: BREACH_COLOR, fontSize: 10 }}
            />
          )}
          <Area type="monotone" dataKey="avg" stroke={CHART_COLOR} fill={`url(#grad-${series.param})`}
            dot={false} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import type { KpiParam, KpiSeries, KpiThreshold, TimeRange } from '../api/kpi.types';
import { KPI_PARAMS, timeRangeToGranularity, timeRangeToMs } from '../api/kpi.types';
import { buildExportUrl, fetchDeviceKpi, fetchThresholds } from '../api/kpi.api';
import { KpiLineChart } from '../components/kpi/KpiLineChart';

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: '1 Hour', value: '1h' },
  { label: '6 Hours', value: '6h' },
  { label: '24 Hours', value: '24h' },
  { label: '1 Week', value: '7d' },
];

export default function KpiPage(): React.ReactElement {
  const [deviceId, setDeviceId] = useState('CPE-001');
  const [selectedParams, setSelectedParams] = useState<KpiParam[]>(['rssi', 'snr', 'cpuUtilization']);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [series, setSeries] = useState<KpiSeries[]>([]);
  const [thresholds, setThresholds] = useState<KpiThreshold[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!deviceId || selectedParams.length === 0) return;
    const to = new Date().toISOString();
    const from = new Date(Date.now() - timeRangeToMs(timeRange)).toISOString();
    setLoading(true);
    Promise.all([
      fetchDeviceKpi(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to),
      fetchThresholds(deviceId),
    ])
      .then(([s, t]) => { setSeries(s); setThresholds(t); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deviceId, selectedParams, timeRange]);

  const toggleParam = (p: KpiParam) => {
    setSelectedParams((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? '#1e3a5f' : 'none',
    border: `1px solid ${active ? '#60a5fa' : '#374151'}`,
    color: active ? '#60a5fa' : '#64748b',
    padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
  });

  const to = new Date().toISOString();
  const from = new Date(Date.now() - timeRangeToMs(timeRange)).toISOString();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#e2e8f0', margin: 0 }}>KPI Dashboard</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href={buildExportUrl(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to, 'csv')}
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>Export CSV</a>
          <a href={buildExportUrl(deviceId, selectedParams, timeRangeToGranularity(timeRange), from, to, 'xls')}
            style={{ background: 'none', border: '1px solid #374151', color: '#94a3b8', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', fontSize: 13 }}>Export XLS</a>
        </div>
      </div>

      {/* Controls */}
      <div style={{ background: '#0d1b2a', border: '1px solid #1e293b', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const, alignItems: 'flex-start' }}>
          {/* Device */}
          <div>
            <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>Device ID</label>
            <input
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 4, color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: 160 }}
            />
          </div>

          {/* Time range */}
          <div>
            <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>Time Range</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {TIME_RANGES.map((tr) => (
                <button key={tr.value} style={btnStyle(timeRange === tr.value)}
                  onClick={() => setTimeRange(tr.value)}>{tr.label}</button>
              ))}
            </div>
          </div>

          {/* Params */}
          <div style={{ flex: 1 }}>
            <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>Metrics</label>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
              {KPI_PARAMS.map((p) => (
                <button key={p} style={btnStyle(selectedParams.includes(p))} onClick={() => toggleParam(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Current values gauges */}
      {series.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const, marginBottom: 16 }}>
          {series.map((s) => {
            const latest = s.data[s.data.length - 1];
            const thr = thresholds.find((t) => t.metric === s.param);
            const breached = thr && latest && latest.avg >= thr.raiseThreshold;
            return (
              <div key={s.param} style={{
                background: '#0d1b2a', border: `1px solid ${breached ? '#ef4444' : '#1e293b'}`,
                borderRadius: 8, padding: '10px 16px', minWidth: 120,
              }}>
                <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>{s.param}</div>
                <div style={{ color: breached ? '#ef4444' : '#e2e8f0', fontSize: 22, fontWeight: 700, fontFamily: 'monospace' }}>
                  {latest?.avg?.toFixed(1) ?? '—'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loading && <div style={{ color: '#60a5fa', fontSize: 13, marginBottom: 12 }}>Loading KPI data…</div>}

      {/* Charts grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
        {series.map((s) => (
          <KpiLineChart
            key={s.param}
            series={s}
            threshold={thresholds.find((t) => t.metric === s.param)}
          />
        ))}
        {series.length === 0 && !loading && (
          <div style={{ color: '#475569', fontSize: 13, gridColumn: '1/-1', padding: 32, textAlign: 'center' }}>
            Select a device and at least one metric to view KPI charts
          </div>
        )}
      </div>
    </div>
  );
}

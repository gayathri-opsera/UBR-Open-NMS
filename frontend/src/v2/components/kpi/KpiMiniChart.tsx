import type { KpiSeries } from '../../../api/kpi.types';

interface KpiMiniChartProps {
  series: KpiSeries;
  height?: number;
}

export function KpiMiniChart({ series, height = 60 }: KpiMiniChartProps) {
  const points = series.data;
  if (points.length < 2) {
    return (
      <div style={{ padding: '8px 12px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vf-text-muted)', marginBottom: 4 }}>{series.param}</div>
        <span style={{ fontSize: 12, color: 'var(--vf-text-dim)' }}>Insufficient data</span>
      </div>
    );
  }

  const values = points.map((p) => p.avg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const padX = 4;
  const padY = 4;

  const pts = points.map((p, i) => {
    const x = padX + (i / (points.length - 1)) * (w - 2 * padX);
    const y = padY + ((max - p.avg) / range) * (h - 2 * padY);
    return `${x},${y}`;
  });

  const polyline = pts.join(' ');
  const area = [`${padX},${h}`, ...pts, `${w - padX},${h}`].join(' ');
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  const trend = prev ? ((last - prev) / prev) * 100 : 0;
  const trendColor = trend >= 0 ? 'var(--vf-success)' : 'var(--vf-danger)';

  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vf-text-muted)' }}>{series.param}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>{last.toFixed(1)}</span>
          {Math.abs(trend) > 0.1 && (
            <span style={{ fontSize: 10, color: trendColor }}>{trend > 0 ? '↑' : '↓'}{Math.abs(trend).toFixed(1)}%</span>
          )}
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: 'visible', display: 'block' }}>
        <defs>
          <linearGradient id={`grad-${series.param}-${series.deviceId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--vf-accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--vf-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#grad-${series.param}-${series.deviceId})`} />
        <polyline points={polyline} fill="none" stroke="var(--vf-accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="3" fill="var(--vf-accent)" />
      </svg>
    </div>
  );
}

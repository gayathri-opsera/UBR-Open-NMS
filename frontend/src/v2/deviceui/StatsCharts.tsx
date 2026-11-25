/**
 * Monitor > Graphs — the history charts of a radio, drawn like the SkyPoint node view: one card per chart, each with its own range
 * (1 Hour, 1 Day, 1 Week, 1 Month, 3 / 6 Months, Custom). The data is what the NMS collected (5-minute samples, hourly averages
 * for older ranges); a chart with no samples yet says so instead of drawing an empty frame.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { UiChartDef, UiChartsConfig } from '../../api/uiBuilder.api';
import type { HistoryData } from '../../api/nodeView.api';
import { RANGE_OPTIONS, bucketLabel, chartLines, chartRows, formatValue, tickLabel } from './statsChartsModel';

export type HistoryFetcher = (q: { group: string; range?: string; from?: string; to?: string; params?: string[] }) => Promise<HistoryData | null>;

const COLORS = ['#1b6ec2', '#e07b00', '#2e9d57', '#c0392b', '#7d4cc7', '#00897b', '#8d6e63', '#546e7a'];
const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

function ChartCard({ chart, group, fetcher }: { chart: UiChartDef; group: string; fetcher?: HistoryFetcher }) {
  const [range, setRange] = useState('1d');
  const [custom, setCustom] = useState({ from: toLocalInput(Date.now() - 86400_000), to: toLocalInput(Date.now()) });
  const [data, setData] = useState<HistoryData | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const params = useMemo(() => [...new Set(chart.series.map((s) => s.param))], [chart]);

  const load = (r: string, c = custom) => {
    if (!fetcher) return;
    const my = ++seq.current;
    setState('loading');
    const q = r === 'custom' ? { group, from: new Date(c.from).toISOString(), to: new Date(c.to).toISOString(), params } : { group, range: r, params };
    fetcher(q).then((d) => { if (my === seq.current) { setData(d); setState('idle'); } }).catch(() => { if (my === seq.current) setState('error'); });
  };
  useEffect(() => {
    if (range === 'custom') return;
    load(range);
    // a chart that ends "now" keeps up with the collector (a sample every 5 minutes)
    const t = range === '1h' || range === '1d' ? setInterval(() => load(range), 60_000) : null;
    return () => { if (t) clearInterval(t); seq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, group, fetcher]);

  const lines = useMemo(() => chartLines(chart, data), [chart, data]);
  const rows = useMemo(() => chartRows(lines, data), [lines, data]);
  const decimals = chart.decimals ?? 2;
  const span = data ? data.to - data.from : 86400_000;
  const empty = rows.length === 0;

  return (
    <section className="dv-chart" data-chart={chart.id}>
      <header className="dv-chart-head">
        <h4>{chart.title}{chart.unit ? <small> ({chart.unit})</small> : null}</h4>
        <div className="dv-chart-ranges" role="group" aria-label={`${chart.title} range`}>
          {RANGE_OPTIONS.map((o) => (
            <button key={o.id} type="button" className={range === o.id ? 'on' : ''} aria-pressed={range === o.id} onClick={() => setRange(o.id)}>{o.label}</button>
          ))}
          <button type="button" className={range === 'custom' ? 'on' : ''} aria-pressed={range === 'custom'} onClick={() => { setRange('custom'); load('custom'); }}>Custom</button>
        </div>
      </header>
      {range === 'custom' && (
        <div className="dv-chart-custom">
          <label>From <input type="datetime-local" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label>To <input type="datetime-local" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          <button type="button" onClick={() => load('custom', custom)} disabled={!custom.from || !custom.to || custom.from >= custom.to}>Apply</button>
        </div>
      )}
      <div className="dv-chart-body">
        {!fetcher ? <div className="dv-chart-empty">Chart preview — history is drawn on a device’s Node View.</div>
          : state === 'error' ? <div className="dv-chart-empty">The history could not be loaded.</div>
          : empty ? <div className="dv-chart-empty">{state === 'loading' ? 'Loading…' : 'No history for this period yet — a sample is stored every 5 minutes.'}</div>
          : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rows} margin={{ top: 6, right: 14, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e3e6ea" />
                <XAxis dataKey="t" type="number" scale="time" domain={[data?.from ?? 'dataMin', data?.to ?? 'dataMax']} tickFormatter={(v: number) => tickLabel(v, span)} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => formatValue(v, decimals > 1 ? 1 : decimals)} />
                <Tooltip labelFormatter={(v) => new Date(Number(v)).toLocaleString()} formatter={(v) => (typeof v === 'number' ? `${formatValue(v, decimals)}${chart.unit ? ` ${chart.unit}` : ''}` : String(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {lines.map((l, i) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.6} connectNulls isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>
      {data && !empty && <footer className="dv-chart-foot">Average per {bucketLabel(data.bucketSeconds)} · {data.source === 'raw' ? '5-minute samples' : 'hourly averages'}</footer>}
    </section>
  );
}

export default function StatsCharts({ config, group, fetcher }: { config?: UiChartsConfig; group: string; fetcher?: HistoryFetcher }) {
  if (!config || !config.charts?.length) return <div className="dv-note" style={{ opacity: .6 }}>No charts are defined for this section.</div>;
  return <div className="dv-charts">{config.charts.map((c) => <ChartCard key={c.id} chart={c} group={group} fetcher={fetcher} />)}</div>;
}

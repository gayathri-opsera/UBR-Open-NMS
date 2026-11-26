/**
 * Monitor > Graphs — the history charts of a radio, drawn like the SkyPoint node view: one card per chart, each with its own range
 * (1 Hour, 1 Day, 1 Week, 1 Month, 3 / 6 Months, Custom). The data is what the NMS collected (5-minute samples, hourly averages
 * for older ranges); a chart with no samples yet says so instead of drawing an empty frame.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { UiChartDef, UiChartsConfig } from '../../api/uiBuilder.api';
import type { HistoryData, LiveStatsSample } from '../../api/nodeView.api';
import { RANGE_OPTIONS, bucketLabel, chartLines, chartRows, formatValue, tickLabel } from './statsChartsModel';

export type LiveFetcher = (row: string) => Promise<LiveStatsSample | null>;
export type HistoryFetcher = (q: { group: string; range?: string; from?: string; to?: string; params?: string[] }) => Promise<HistoryData | null>;

/** Live stream: frequencies on offer (seconds), the one every chart starts with, and how many points a chart keeps (a rolling window). */
export const LIVE_FREQUENCIES = [3, 5, 10];
export const DEFAULT_LIVE_FREQ = 5;
export const LIVE_MAX_POINTS = 61;   // like SkyPoint's live graphs (about 3 minutes at 3 s)
export const SMOOTH_POINTS = 3;      // live values are plotted as a moving average of the last 3 readings
const freqLabel = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`);
/** moving average of each point with the (up to) n-1 readings before it */
export function smooth(points: [number, number][], n = SMOOTH_POINTS): [number, number][] {
  return points.map(([t], i) => { const w = points.slice(Math.max(0, i - n + 1), i + 1); return [t, w.reduce((a, [, v]) => a + v, 0) / w.length] as [number, number]; });
}
type LiveBuffer = Record<string, [number, number][]>;   // `param~instance` → points

const COLORS = ['#1b6ec2', '#e07b00', '#2e9d57', '#c0392b', '#7d4cc7', '#00897b', '#8d6e63', '#546e7a'];
const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

interface LiveProps {
  buffer: LiveBuffer | undefined;
  freq: number;            // the universal frequency
  error: boolean;
}

function ChartCard({ chart, group, row, fetcher, range, setRange, live }: { chart: UiChartDef; group: string; row: string; fetcher?: HistoryFetcher; range: string; setRange: (r: string) => void; live?: LiveProps }) {
  const [custom, setCustom] = useState({ from: toLocalInput(Date.now() - 86400_000), to: toLocalInput(Date.now()) });
  const [data, setData] = useState<HistoryData | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const params = useMemo(() => [...new Set(chart.series.map((s) => s.param))], [chart]);

  const isLive = range === 'live' && !!live;
  const load = (r: string, c = custom) => {
    if (!fetcher || r === 'live') return;
    const my = ++seq.current;
    setState('loading');
    const q = r === 'custom' ? { group, from: new Date(c.from).toISOString(), to: new Date(c.to).toISOString(), params } : { group, range: r, params };
    fetcher(q).then((d) => { if (my === seq.current) { setData(d); setState('idle'); } }).catch(() => { if (my === seq.current) setState('error'); });
  };
  useEffect(() => {
    if (range === 'custom' || range === 'live') return;
    load(range);
    // a chart that ends "now" keeps up with the collector (a sample every 5 minutes)
    const t = range === '1h' || range === '1d' ? setInterval(() => load(range), 60_000) : null;
    return () => { if (t) clearInterval(t); seq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, group, fetcher]);

  // live: the rolling buffer is shaped like a history answer so the same lines / rows / axes are used
  const liveData = useMemo<HistoryData | null>(() => {
    if (!isLive) return null;
    const series = Object.entries(live!.buffer ?? {}).filter(([k]) => chart.series.some((s) => s.param === k.slice(0, k.lastIndexOf('~'))))
      .map(([k, points]) => { const i = k.lastIndexOf('~'); return { param: k.slice(0, i), instance: k.slice(i + 1).replace(/-/g, '.'), points: smooth(points) }; });
    const to = series.reduce((m, x) => Math.max(m, x.points[x.points.length - 1]?.[0] ?? 0), 0) || Date.now();
    const first = series.reduce((m, x) => Math.min(m, x.points[0]?.[0] ?? to), to);
    return { from: Math.max(first, to - LIVE_MAX_POINTS * live!.freq * 1000), to, bucketSeconds: live!.freq, source: 'live', samples: series.length, series };
  }, [isLive, live, chart]);
  const shown = isLive ? liveData : data;
  const lines = useMemo(() => chartLines(chart, shown, row), [chart, shown, row]);
  const rows = useMemo(() => chartRows(lines, shown), [lines, shown]);
  const decimals = chart.decimals ?? 2;
  const span = shown ? shown.to - shown.from : 86400_000;
  const empty = rows.length === 0;

  return (
    <section className="dv-chart" data-chart={chart.id}>
      <header className="dv-chart-head">
        <h4>{chart.title}{chart.unit ? <small> ({chart.unit})</small> : null}</h4>
        <div className="dv-chart-ranges" role="group" aria-label={`${chart.title} range`}>
          {live && <button type="button" className={range === 'live' ? 'on' : ''} aria-pressed={range === 'live'} onClick={() => setRange('live')}>Live</button>}
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
        {!fetcher && !live ? <div className="dv-chart-empty">Chart preview — history is drawn on a device’s Node View.</div>
          : isLive && live!.error && empty ? <div className="dv-chart-empty">The live reading failed — retrying every {freqLabel(live!.freq)}.</div>
          : isLive && empty ? <div className="dv-chart-empty">Waiting for the first readings — a counter needs two readings to give a rate.</div>
          : state === 'error' ? <div className="dv-chart-empty">The history could not be loaded.</div>
          : empty ? <div className="dv-chart-empty">{state === 'loading' ? 'Loading…' : 'No history for this period yet — a sample is stored every 5 minutes.'}</div>
          : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={rows} margin={{ top: 6, right: 14, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e3e6ea" />
                <XAxis dataKey="t" type="number" scale="time" domain={[shown?.from ?? 'dataMin', shown?.to ?? 'dataMax']} tickFormatter={(v: number) => tickLabel(v, span)} tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 'auto']} tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => formatValue(v, decimals > 1 ? 1 : decimals)} />
                <Tooltip labelFormatter={(v) => new Date(Number(v)).toLocaleString()} formatter={(v) => (typeof v === 'number' ? `${formatValue(v, decimals)}${chart.unit ? ` ${chart.unit}` : ''}` : String(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {lines.map((l, i) => <Area key={l.key} type="linear" dataKey={l.key} name={l.label} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.25} dot={false} strokeWidth={1.6} connectNulls isAnimationActive={false} />)}
              </AreaChart>
            </ResponsiveContainer>
          )}
      </div>
      {shown && !empty && <footer className="dv-chart-foot">{shown.source === 'live' ? `Live · a reading every ${freqLabel(shown.bucketSeconds)} · average of the last ${SMOOTH_POINTS} readings` : `Average per ${bucketLabel(shown.bucketSeconds)} · ${shown.source === 'raw' ? '5-minute samples' : 'hourly averages'}`}</footer>}
    </section>
  );
}

export default function StatsCharts({ config, group, fetcher, liveFetcher }: { config?: UiChartsConfig; group: string; fetcher?: HistoryFetcher; liveFetcher?: LiveFetcher }) {
  const charts = config?.charts ?? [];
  const row = config?.row ?? '';
  const [ranges, setRanges] = useState<Record<string, string>>({});
  // the universal choice: 'live-5' / 'live-10' (live stream at that frequency) or a history range ('1h' … '6m'); a chart's own buttons override it
  const [universal, setUniversal] = useState(`live-${DEFAULT_LIVE_FREQ}`);
  // the last live frequency chosen: a graph switched to Live while the universal choice is a history range still uses it
  const [liveFreq, setLiveFreq] = useState(DEFAULT_LIVE_FREQ);
  const globalFreq = liveFreq;
  const universalRange = universal.startsWith('live-') ? 'live' : universal;
  const [buffers, setBuffers] = useState<Record<string, LiveBuffer>>({});
  const [liveError, setLiveError] = useState(false);
  const rangeOf = (id: string) => ranges[id] ?? (liveFetcher ? universalRange : '1d');
  const freqOf = (_id: string) => globalFreq;
  const lastAt = useRef<Record<string, number>>({});

  // one poller for the whole tab at the fastest frequency a live chart asks for; each chart keeps a reading only when its own frequency has passed
  const liveIds = charts.filter((c) => rangeOf(c.id) === 'live').map((c) => c.id);
  const minFreq = liveFetcher && liveIds.length ? Math.min(...liveIds.map(freqOf)) : 0;
  const latest = useRef({ charts, liveIds, freqOf });
  latest.current = { charts, liveIds, freqOf };
  useEffect(() => {
    if (!liveFetcher || !minFreq) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const s = await liveFetcher(row);
          if (stop) return;
          setLiveError(false);
          if (s) {
            const { charts: cs, liveIds: ids, freqOf: f } = latest.current;
            setBuffers((prev) => {
              const next = { ...prev };
              for (const c of cs) {
                if (!ids.includes(c.id)) continue;
                const last = lastAt.current[c.id] ?? 0;
                if (s.ts - last < f(c.id) * 1000 - 500) continue;
                const params = new Set(c.series.map((x) => x.param));
                const buf: LiveBuffer = { ...(next[c.id] ?? {}) };
                let any = false;
                for (const [k, v] of Object.entries(s.values)) {
                  if (!params.has(k.slice(0, k.lastIndexOf('~')))) continue;
                  buf[k] = [...(buf[k] ?? []), [s.ts, v] as [number, number]].slice(-LIVE_MAX_POINTS);
                  any = true;
                }
                if (any) { next[c.id] = buf; lastAt.current[c.id] = s.ts; }
              }
              return next;
            });
          }
        } catch { if (!stop) setLiveError(true); }
      }
      if (!stop) timer = setTimeout(tick, minFreq * 1000);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [liveFetcher, row, minFreq]);

  if (!config || !charts.length) return <div className="dv-note" style={{ opacity: .6 }}>No charts are defined for this section.</div>;
  return (
    <div>
      {liveFetcher && (
        <div className="dv-charts-bar">
          <label>View (all graphs){' '}
            <select aria-label="Universal live frequency" value={universal} onChange={(e) => { setUniversal(e.target.value); if (e.target.value.startsWith('live-')) setLiveFreq(Number(e.target.value.slice(5))); setRanges({}); }}>
              {LIVE_FREQUENCIES.map((f) => <option key={f} value={`live-${f}`}>Live · {freqLabel(f)}</option>)}
              {RANGE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <small>Applies to every graph on this tab; a graph's own buttons override it.</small>
        </div>
      )}
      <div className="dv-charts">
        {charts.map((c) => (
          <ChartCard key={c.id} chart={c} group={group} row={row} fetcher={fetcher}
            range={rangeOf(c.id)} setRange={(r) => setRanges((p) => ({ ...p, [c.id]: r }))}
            live={liveFetcher ? { buffer: buffers[c.id], freq: globalFreq, error: liveError } : undefined} />
        ))}
      </div>
    </div>
  );
}

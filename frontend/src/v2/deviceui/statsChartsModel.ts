/**
 * Data shaping for the Monitor > Graphs charts (pure, tested): the range choices, the lines of a chart from the history answer,
 * and the table recharts draws.
 */
import type { UiChartDef } from '../../api/uiBuilder.api';
import type { HistoryData } from '../../api/nodeView.api';

/** SkyPoint's ranges (1 Hour … 1 Month, Custom) plus the 3 and 6 months this NMS keeps. */
export const RANGE_OPTIONS: { id: string; label: string; ms: number }[] = [
  { id: '1h', label: '1 Hour', ms: 3600_000 },
  { id: '1d', label: '1 Day', ms: 86400_000 },
  { id: '1w', label: '1 Week', ms: 7 * 86400_000 },
  { id: '1m', label: '1 Month', ms: 30 * 86400_000 },
  { id: '3m', label: '3 Months', ms: 90 * 86400_000 },
  { id: '6m', label: '6 Months', ms: 183 * 86400_000 },
];

export interface ChartLine { key: string; label: string }

/** Table row `instance` belongs to the radio `row`: '2' matches '2' and the link rows '2.1', '2.2'. An empty row matches all. */
export const instanceInRow = (instance: string, row: string): boolean => !row || instance === row || instance.startsWith(`${row}.`);

/** The lines of one chart: a series per configured field; a per-link series becomes one line per link the history holds. */
export function chartLines(chart: UiChartDef, data: HistoryData | null, row = ''): ChartLine[] {
  const out: ChartLine[] = [];
  for (const s of chart.series) {
    // the history holds every statistics row (1 = 2.4 GHz, 2 = Radio 1, 3 = Radio 2): draw only the radio this section is about
    const found = (data?.series ?? []).filter((x) => x.param === s.param && instanceInRow(x.instance, row));
    if (s.perLink) {
      for (const x of found) out.push({ key: `${s.param}~${x.instance}`, label: `${s.label} · link ${x.instance.split('.')[1] ?? x.instance}` });
    } else if (found.length) {
      out.push({ key: `${s.param}~${found[0].instance}`, label: s.label });
    } else {
      out.push({ key: `${s.param}~`, label: s.label });   // no data yet: the legend still names the series
    }
  }
  return out;
}

/** One row per timestamp with a column per line — what a line chart draws. */
export function chartRows(lines: ChartLine[], data: HistoryData | null): Record<string, number>[] {
  const rows = new Map<number, Record<string, number>>();
  for (const x of data?.series ?? []) {
    const key = `${x.param}~${x.instance}`;
    if (!lines.some((l) => l.key === key)) continue;
    for (const [t, v] of x.points) {
      const row = rows.get(t) ?? { t };
      row[key] = v;
      rows.set(t, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

/** "5 min", "2 h", "1 day" — the width of one point. */
export function bucketLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 60)} min`;
}

/** Axis tick text: clock time inside a day, date beyond. */
export function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  if (spanMs <= 2 * 86400_000) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.toLocaleString('en-GB', { month: 'short' })} ${d.getDate()}`;
}

export const formatValue = (v: number, decimals = 2): string => (Number.isInteger(v) && decimals === 0 ? String(v) : v.toFixed(decimals));

import { describe, expect, it } from 'vitest';
import type { HistoryData } from '../../api/nodeView.api';
import type { UiChartDef } from '../../api/uiBuilder.api';
import { RANGE_OPTIONS, bucketLabel, chartLines, chartRows, tickLabel } from './statsChartsModel';

const data = (series: HistoryData['series']): HistoryData => ({ from: 0, to: 1, bucketSeconds: 300, source: 'raw', samples: 3, series });
const THROUGHPUT: UiChartDef = { id: 'tp', title: 'Throughput', series: [{ param: 'tx', label: 'Tx' }, { param: 'rx', label: 'Rx' }] };
const SNR: UiChartDef = { id: 'snr', title: 'Link SNR', series: [{ param: 'snr', label: 'Local A1', perLink: true }] };

describe('ranges', () => {
  it('offers SkyPoint’s ranges and the 3 and 6 months this NMS keeps', () => {
    expect(RANGE_OPTIONS.map((r) => r.label)).toEqual(['1 Hour', '1 Day', '1 Week', '1 Month', '3 Months', '6 Months']);
    expect(RANGE_OPTIONS.map((r) => r.id)).toEqual(['1h', '1d', '1w', '1m', '3m', '6m']);
  });
});

describe('chart lines and rows', () => {
  it('one line per configured series, named after it; the legend names a series with no data yet', () => {
    expect(chartLines(THROUGHPUT, data([{ param: 'tx', instance: '2', points: [[1, 5]] }])).map((l) => l.label)).toEqual(['Tx', 'Rx']);
  });
  it('a per-link series gets a line per link', () => {
    const d = data([{ param: 'snr', instance: '2.1', points: [[1, 60]] }, { param: 'snr', instance: '2.2', points: [[1, 55]] }]);
    expect(chartLines(SNR, d).map((l) => l.label)).toEqual(['Local A1 · link 1', 'Local A1 · link 2']);
  });
  it('merges the points by time, one column per line, ignoring series the chart does not draw', () => {
    const d = data([
      { param: 'tx', instance: '2', points: [[1000, 5], [2000, 6]] },
      { param: 'rx', instance: '2', points: [[2000, 7]] },
      { param: 'other', instance: '2', points: [[1000, 99]] },
    ]);
    expect(chartRows(chartLines(THROUGHPUT, d), d)).toEqual([{ t: 1000, 'tx~2': 5 }, { t: 2000, 'tx~2': 6, 'rx~2': 7 }]);
  });
  it('draws only the radio’s own statistics row, not row 1 (2.4 GHz) that sorts first', () => {
    const d = data([
      { param: 'tx', instance: '1', points: [[1000, 0]] },
      { param: 'tx', instance: '2', points: [[1000, 102.9]] },
      { param: 'tx', instance: '3', points: [[1000, 0]] },
    ]);
    const lines = chartLines(THROUGHPUT, d, '2');
    expect(lines[0].key).toBe('tx~2');
    expect(chartRows(lines, d)).toEqual([{ t: 1000, 'tx~2': 102.9 }]);
  });
  it('per-link lines are limited to the radio’s links', () => {
    const d = data([{ param: 'snr', instance: '2.1', points: [[1, 60]] }, { param: 'snr', instance: '3.1', points: [[1, 50]] }]);
    expect(chartLines(SNR, d, '2').map((l) => l.key)).toEqual(['snr~2.1']);
  });
  it('no history → no rows', () => { expect(chartRows(chartLines(THROUGHPUT, null), null)).toEqual([]); });
});

describe('labels', () => {
  it('names the width of a point', () => {
    expect(bucketLabel(300)).toBe('5 min');
    expect(bucketLabel(7200)).toBe('2 h');
    expect(bucketLabel(86400)).toBe('1 day');
  });
  it('clock time within two days, a date beyond', () => {
    const t = new Date(2026, 10, 25, 14, 5).getTime();
    expect(tickLabel(t, 3600_000)).toBe('14:05');
    expect(tickLabel(t, 30 * 86400_000)).toBe('Nov 25');
  });
});

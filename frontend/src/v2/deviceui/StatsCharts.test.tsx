import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StatsCharts from './StatsCharts';
import type { UiChartsConfig } from '../../api/uiBuilder.api';

const CONFIG: UiChartsConfig = { row: '2', charts: [
  { id: 'tp', title: 'Throughput', unit: 'Mbps', series: [{ param: 'tx', label: 'Tx' }, { param: 'rx', label: 'Rx' }] },
  { id: 'rtx', title: 'RTX', unit: '%', series: [{ param: 'rtx', label: 'RTX %' }] },
] };
const EMPTY = { from: 0, to: 1, bucketSeconds: 300, source: 'raw' as const, samples: 0, series: [] };

describe('Monitor > Graphs', () => {
  it('draws a card per chart, each with the SkyPoint ranges plus Custom', async () => {
    const fetcher = vi.fn().mockResolvedValue(EMPTY);
    render(<StatsCharts config={CONFIG} group="g1" fetcher={fetcher} />);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Throughput (Mbps)', 'RTX (%)']);
    const group = screen.getByRole('group', { name: 'Throughput range' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['1 Hour', '1 Day', '1 Week', '1 Month', '3 Months', '6 Months', 'Custom']);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
  });
  it('asks for one day first, only the parameters of that chart', async () => {
    const fetcher = vi.fn().mockResolvedValue(EMPTY);
    render(<StatsCharts config={CONFIG} group="g1" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledWith({ group: 'g1', range: '1d', params: ['tx', 'rx'] });
    expect(fetcher).toHaveBeenCalledWith({ group: 'g1', range: '1d', params: ['rtx'] });
  });
  it('a chart changes its own range and nobody else’s (6 months reads the hourly history)', async () => {
    const fetcher = vi.fn().mockResolvedValue(EMPTY);
    render(<StatsCharts config={CONFIG} group="g1" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fetcher.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('group', { name: 'Throughput range' }).querySelectorAll('button')[5]); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledWith({ group: 'g1', range: '6m', params: ['tx', 'rx'] });
    expect(screen.getByRole('group', { name: 'Throughput range' }).querySelector('.on')?.textContent).toBe('6 Months');
    expect(screen.getByRole('group', { name: 'RTX range' }).querySelector('.on')?.textContent).toBe('1 Day');
  });
  it('Custom asks for the dates chosen', async () => {
    const fetcher = vi.fn().mockResolvedValue(EMPTY);
    render(<StatsCharts config={CONFIG} group="g1" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fetcher.mockClear();
    await act(async () => { fireEvent.click(screen.getAllByText('Custom')[0]); });
    const from = screen.getByLabelText(/From/) as HTMLInputElement;
    await act(async () => { fireEvent.change(from, { target: { value: '2026-06-01T08:00' } }); });
    await act(async () => { fireEvent.click(screen.getByText('Apply')); });
    const last = fetcher.mock.calls[fetcher.mock.calls.length - 1][0];
    expect(last.group).toBe('g1');
    expect(last.from).toBe(new Date('2026-06-01T08:00').toISOString());
    expect(last.range).toBeUndefined();
  });
  it('says there is no history yet instead of drawing an empty frame', async () => {
    render(<StatsCharts config={CONFIG} group="g1" fetcher={vi.fn().mockResolvedValue(EMPTY)} />);
    expect((await screen.findAllByText(/No history for this period yet/)).length).toBe(2);
  });
  it('a failed read says so', async () => {
    render(<StatsCharts config={CONFIG} group="g1" fetcher={vi.fn().mockRejectedValue(new Error('x'))} />);
    expect((await screen.findAllByText(/could not be loaded/)).length).toBe(2);
  });
  it('without a device (builder preview) it shows a preview note, not a request', () => {
    render(<StatsCharts config={CONFIG} group="g1" />);
    expect(screen.getAllByText(/Chart preview/).length).toBe(2);
  });

  describe('live stream', () => {
    const sample = (ts: number) => ({ ts, values: { 'tx~2': 1, 'rx~2': 2, 'rtx~2': 3 } });
    it('starts live at 5 s for every chart and follows the universal frequency', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let t = Date.now();
      const live = vi.fn().mockImplementation(async () => sample((t += 5000)));
      render(<StatsCharts config={CONFIG} group="g1" fetcher={vi.fn().mockResolvedValue(EMPTY)} liveFetcher={live} />);
      expect(screen.getByRole('group', { name: 'Throughput range' }).querySelector('.on')?.textContent).toBe('Live');
      expect((screen.getByLabelText('Universal live frequency') as HTMLSelectElement).value).toBe('live-5');
      expect(screen.queryByLabelText('Throughput frequency')).toBeNull();   // one universal selector only
      await waitFor(() => expect(live).toHaveBeenCalledWith('2'));
      await act(async () => { fireEvent.change(screen.getByLabelText('Universal live frequency'), { target: { value: 'live-10' } }); });
      expect((screen.getByLabelText('Universal live frequency') as HTMLSelectElement).value).toBe('live-10');
      vi.useRealTimers();
    });
    it('picking a history range stops the live reading for that chart', async () => {
      render(<StatsCharts config={CONFIG} group="g1" fetcher={vi.fn().mockResolvedValue(EMPTY)} liveFetcher={vi.fn().mockResolvedValue(null)} />);
      await act(async () => { fireEvent.click(screen.getByRole('group', { name: 'Throughput range' }).querySelectorAll('button')[2]); });
      expect(screen.getByRole('group', { name: 'Throughput range' }).querySelector('.on')?.textContent).toBe('1 Day');
      expect(screen.getByRole('group', { name: 'RTX range' }).querySelector('.on')?.textContent).toBe('Live');
    });
    it('the universal selector offers Live 5 s / 10 s and every history range, and sets every graph', async () => {
      const fetcher = vi.fn().mockResolvedValue(EMPTY);
      render(<StatsCharts config={CONFIG} group="g1" fetcher={fetcher} liveFetcher={vi.fn().mockResolvedValue(null)} />);
      const sel = screen.getByLabelText('Universal live frequency') as HTMLSelectElement;
      expect([...sel.options].map((o) => o.textContent)).toEqual(['Live · 5 s', 'Live · 10 s', '1 Hour', '1 Day', '1 Week', '1 Month', '3 Months', '6 Months']);
      await act(async () => { fireEvent.change(sel, { target: { value: '1w' } }); });
      await waitFor(() => expect(fetcher).toHaveBeenCalledWith({ group: 'g1', range: '1w', params: ['tx', 'rx'] }));
      expect(fetcher).toHaveBeenCalledWith({ group: 'g1', range: '1w', params: ['rtx'] });
      expect(screen.getByRole('group', { name: 'RTX range' }).querySelector('.on')?.textContent).toBe('1 Week');
      await act(async () => { fireEvent.change(sel, { target: { value: 'live-5' } }); });
      expect(screen.getByRole('group', { name: 'RTX range' }).querySelector('.on')?.textContent).toBe('Live');
    })
    it('a graph switched to Live after a history range keeps polling, at the last live frequency, and draws on its own live axis', async () => {
      const calls: number[] = [];
      let t = Date.now();
      const live = vi.fn().mockImplementation(async () => { calls.push(Date.now()); return { ts: (t += 10000), values: { 'tx~2': 1, 'rx~2': 2 } }; });
      render(<StatsCharts config={CONFIG} group="g1" fetcher={vi.fn().mockResolvedValue(EMPTY)} liveFetcher={live} />);
      const sel = screen.getByLabelText('Universal live frequency') as HTMLSelectElement;
      await act(async () => { fireEvent.change(sel, { target: { value: 'live-10' } }); });
      await act(async () => { fireEvent.change(sel, { target: { value: '1h' } }); });
      live.mockClear();
      await act(async () => { fireEvent.click(screen.getByRole('group', { name: 'Throughput range' }).querySelectorAll('button')[0]); });
      expect(screen.getByRole('group', { name: 'Throughput range' }).querySelector('.on')?.textContent).toBe('Live');
      expect(screen.getByRole('group', { name: 'RTX range' }).querySelector('.on')?.textContent).toBe('1 Hour');
      await waitFor(() => expect(live).toHaveBeenCalledWith('2'));
      expect(await screen.findByText(/Live · a reading every 10 s/)).toBeTruthy();
    });
  });
});

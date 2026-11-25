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
});

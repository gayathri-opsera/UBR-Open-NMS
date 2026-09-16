import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../api/discovery.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/discovery.api')>();
  return {
    ...actual,
    listDiscoverySchedules: vi.fn(),
    listDiscoveryRuns: vi.fn(),
    createSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    triggerSchedule: vi.fn(),
  };
});

vi.mock('../common/Toast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  listDiscoverySchedules,
  listDiscoveryRuns,
  createSchedule,
} from '../../../api/discovery.api';
import { DiscoverySchedules, isValidCron, ScheduleForm } from './DiscoverySchedules';
import { mockDiscoverySchedule } from '../../../api/mocks/discovery.mocks';

const mockedListSchedules = vi.mocked(listDiscoverySchedules);
const mockedListRuns = vi.mocked(listDiscoveryRuns);
const mockedCreate = vi.mocked(createSchedule);

beforeEach(() => vi.clearAllMocks());

describe('isValidCron', () => {
  it('accepts five-field cron expressions', () => {
    expect(isValidCron('0 2 * * *')).toBe(true);
  });

  it('rejects malformed cron expressions', () => {
    expect(isValidCron('daily')).toBe(false);
  });
});

describe('DiscoverySchedules', () => {
  it('renders schedule list from API', async () => {
    mockedListSchedules.mockResolvedValue([mockDiscoverySchedule]);
    mockedListRuns.mockResolvedValue({ data: [], pagination: { total: 0, page: 1, limit: 50 } });

    render(<DiscoverySchedules />);

    await waitFor(() => {
      expect(screen.getByText(mockDiscoverySchedule.name)).toBeInTheDocument();
    });
    expect(screen.getByText('0 2 * * *')).toBeInTheDocument();
  });

  it('shows empty state when no schedules exist', async () => {
    mockedListSchedules.mockResolvedValue([]);
    mockedListRuns.mockResolvedValue({ data: [], pagination: { total: 0, page: 1, limit: 50 } });

    render(<DiscoverySchedules />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules configured/i)).toBeInTheDocument();
    });
  });
});

describe('ScheduleForm', () => {
  it('validates cron before submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ScheduleForm
        baselineRuns={[{ runId: 'run-1', status: 'COMPLETED', createdAt: '2026-01-01', scopeSummary: '10.0.0.0/24' }]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        submitting={false}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText(/baseline scope run/i), 'run-1');
    await userEvent.clear(screen.getByLabelText(/custom cron expression/i));
    await userEvent.type(screen.getByLabelText(/custom cron expression/i), 'invalid');
    await userEvent.click(screen.getByRole('button', { name: /save schedule/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('submits valid schedule payload', async () => {
    mockedCreate.mockResolvedValueOnce(mockDiscoverySchedule);
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ScheduleForm
        baselineRuns={[{ runId: 'run-1', status: 'COMPLETED', createdAt: '2026-01-01', scopeSummary: '10.0.0.0/24' }]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        submitting={false}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText(/nightly core/i), 'Weekly scan');
    await userEvent.selectOptions(screen.getByLabelText(/baseline scope run/i), 'run-1');
    await userEvent.click(screen.getByRole('button', { name: /save schedule/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeRunId: 'run-1',
          cronExpression: '0 2 * * *',
          name: 'Weekly scan',
        }),
      );
    });
  });
});

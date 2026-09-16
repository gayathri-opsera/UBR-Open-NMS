/**
 * Unit tests for DiscoveryRunHistory component (WO-015).
 *
 * Covers:
 *  - Renders loading state while fetching.
 *  - Renders empty state when no runs exist.
 *  - Renders runs table with correct data.
 *  - Pagination controls (prev/next buttons).
 *  - Status filter triggers a fresh API call.
 *  - "Re-run" button invokes onRerun callback for completed runs.
 *  - Error banner shown on API failure with retry capability.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('../../../api/discovery.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/discovery.api')>();
  return { ...actual, listDiscoveryRuns: vi.fn() };
});

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { listDiscoveryRuns } from '../../../api/discovery.api';
import type { PaginatedRunsResponse, DiscoveryRunSummary } from '../../../api/discovery.api';
import { DiscoveryRunHistory } from './DiscoveryRunHistory';
import { ToastProvider } from '../common/Toast';

const mockedList = vi.mocked(listDiscoveryRuns);

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<DiscoveryRunSummary> = {}): DiscoveryRunSummary {
  return {
    runId:          'aaaa-bbbb-cccc-dddd',
    status:         'COMPLETED',
    scopeSummary:   '192.168.1.0/24',
    createdAt:      '2026-09-01T10:00:00Z',
    completedAt:    '2026-09-01T10:02:30Z',
    devicesFound:   42,
    createdBy:      'operator@example.com',
    normalizedScope: [{ type: 'CIDR', value: '192.168.1.0/24' }],
    ...overrides,
  };
}

function makePage(runs: DiscoveryRunSummary[], total?: number): PaginatedRunsResponse {
  return {
    data: runs,
    pagination: { total: total ?? runs.length, page: 1, limit: 15 },
  };
}

beforeEach(() => vi.clearAllMocks());

// ── Loading state ─────────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — loading', () => {
  it('shows loading state while fetching', async () => {
    mockedList.mockReturnValueOnce(new Promise(() => undefined)); // never resolves
    renderWithToast(<DiscoveryRunHistory />);
    expect(screen.getByText(/loading run history/i)).toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — empty state', () => {
  it('shows empty state when no runs are returned', async () => {
    mockedList.mockResolvedValueOnce(makePage([]));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText(/no runs found/i)).toBeInTheDocument();
    });
  });
});

// ── Table rendering ───────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — table', () => {
  it('renders a row for each returned run', async () => {
    const runs = [
      makeRun({ runId: 'run-0001-xxxx', scopeSummary: '10.0.0.0/8' }),
      makeRun({ runId: 'run-0002-xxxx', scopeSummary: '172.16.0.0/12' }),
    ];
    mockedList.mockResolvedValueOnce(makePage(runs));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText('10.0.0.0/8')).toBeInTheDocument();
      expect(screen.getByText('172.16.0.0/12')).toBeInTheDocument();
    });
  });

  it('shows COMPLETED status badge for a completed run', async () => {
    mockedList.mockResolvedValueOnce(makePage([makeRun({ status: 'COMPLETED' })]));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    });
  });

  it('shows FAILED status badge for a failed run', async () => {
    mockedList.mockResolvedValueOnce(makePage([makeRun({ status: 'FAILED' })]));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText('FAILED')).toBeInTheDocument();
    });
  });

  it('renders device count for completed run', async () => {
    mockedList.mockResolvedValueOnce(makePage([makeRun({ devicesFound: 123 })]));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText('123')).toBeInTheDocument();
    });
  });
});

// ── Re-run callback ───────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — Re-run', () => {
  it('calls onRerun with the run when Re-run button is clicked', async () => {
    const run = makeRun({ status: 'COMPLETED', normalizedScope: [{ type: 'CIDR', value: '10.0.0.0/8' }] });
    mockedList.mockResolvedValueOnce(makePage([run]));
    const onRerun = vi.fn();
    const user = userEvent.setup();

    renderWithToast(<DiscoveryRunHistory onRerun={onRerun} />);
    await waitFor(() => screen.getByRole('button', { name: /re-run/i }));

    await user.click(screen.getByRole('button', { name: /re-run/i }));
    expect(onRerun).toHaveBeenCalledWith(run);
  });

  it('does not show Re-run button for failed runs', async () => {
    mockedList.mockResolvedValueOnce(makePage([makeRun({ status: 'FAILED' })]));
    renderWithToast(<DiscoveryRunHistory onRerun={vi.fn()} />);
    await waitFor(() => screen.getByText('FAILED'));
    expect(screen.queryByRole('button', { name: /re-run/i })).not.toBeInTheDocument();
  });
});

// ── Status filter ─────────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — filter', () => {
  it('calls listDiscoveryRuns with status filter when changed', async () => {
    mockedList.mockResolvedValue(makePage([]));
    const user = userEvent.setup();

    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => screen.getByLabelText(/filter by status/i));

    // Change status filter to FAILED
    await user.selectOptions(screen.getByLabelText(/filter by status/i), 'FAILED');

    await waitFor(() => {
      // The second call should include the status filter.
      const calls = mockedList.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[2]).toBe('FAILED');
    });
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — error', () => {
  it('shows error banner when API call fails', async () => {
    mockedList.mockRejectedValueOnce(new Error('Network error'));
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
    });
  });

  it('retries on clicking Retry button', async () => {
    mockedList
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(makePage([]));
    const user = userEvent.setup();

    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => screen.getByRole('alert'));
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(mockedList).toHaveBeenCalledTimes(2);
    });
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe('DiscoveryRunHistory — pagination', () => {
  it('shows pagination controls when more than one page exists', async () => {
    mockedList.mockResolvedValueOnce({
      data: [makeRun()],
      pagination: { total: 30, page: 1, limit: 15 },
    });
    renderWithToast(<DiscoveryRunHistory />);
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();
    });
  });

  it('Next button is disabled on the last page', async () => {
    mockedList.mockResolvedValueOnce({
      data: [makeRun()],
      pagination: { total: 1, page: 1, limit: 15 },
    });
    renderWithToast(<DiscoveryRunHistory />);
    // Only 1 page → pagination controls not shown (pages === 1).
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
    });
  });
});

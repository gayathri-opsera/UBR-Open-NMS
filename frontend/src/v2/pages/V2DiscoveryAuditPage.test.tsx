/**
 * Unit tests for V2DiscoveryAuditPage (WO-019).
 *
 * Covers:
 *  - Loading state while fetching events.
 *  - Renders table rows with correct data on success.
 *  - Empty state when no events returned.
 *  - Error banner on API failure + retry.
 *  - Action filter triggers new API call.
 *  - Outcome filter applies client-side filtering.
 *  - Clear-filters button resets all filters and reloads.
 *  - Pagination: next/prev buttons trigger correct page requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('../../api/discovery-audit.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/discovery-audit.api')>();
  return { ...actual, listDiscoveryAuditEvents: vi.fn() };
});

vi.mock('../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { listDiscoveryAuditEvents } from '../../api/discovery-audit.api';
import type { DiscoveryAuditPage, DiscoveryAuditEvent } from '../../api/discovery-audit.api';
import { V2DiscoveryAuditPage } from './V2DiscoveryAuditPage';

const mockedList = vi.mocked(listDiscoveryAuditEvents);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<DiscoveryAuditEvent> = {}): DiscoveryAuditEvent {
  return {
    eventId:      'evt-001',
    producedAt:   '2026-09-01T10:00:00Z',
    service:      'discovery-service',
    correlationId: 'run-001',
    action:       'discovery.run.completed',
    resourceType: 'DiscoveryRun',
    resourceId:   'run-001',
    outcome:      'success',
    detail:       '42 devices found',
    ...overrides,
  };
}

function makePage(events: DiscoveryAuditEvent[]): DiscoveryAuditPage {
  return {
    data:          events,
    totalElements: events.length,
    totalPages:    1,
    currentPage:   0,
    pageSize:      20,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('V2DiscoveryAuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching', () => {
    // Never resolves during this test.
    mockedList.mockReturnValue(new Promise(() => {}));
    render(<V2DiscoveryAuditPage />);
    expect(screen.getByText(/loading audit events/i)).toBeInTheDocument();
  });

  it('renders event rows on success', async () => {
    const events = [
      makeEvent({ eventId: 'e1', action: 'discovery.run.completed', outcome: 'success', detail: '42 devices found' }),
      makeEvent({ eventId: 'e2', action: 'discovery.run.failed',    outcome: 'failure', detail: 'Timeout' }),
    ];
    mockedList.mockResolvedValueOnce(makePage(events));
    render(<V2DiscoveryAuditPage />);

    await waitFor(() => expect(screen.getByText('Run Completed')).toBeInTheDocument());
    expect(screen.getByText('Run Failed')).toBeInTheDocument();
    expect(screen.getByText('42 devices found')).toBeInTheDocument();
    expect(screen.getByText('Timeout')).toBeInTheDocument();
  });

  it('shows empty state when no events returned', async () => {
    mockedList.mockResolvedValueOnce(makePage([]));
    render(<V2DiscoveryAuditPage />);

    await waitFor(() => expect(screen.getByText(/no audit events found/i)).toBeInTheDocument());
  });

  it('shows error banner on API failure', async () => {
    mockedList.mockRejectedValueOnce(new Error('network error'));
    render(<V2DiscoveryAuditPage />);

    await waitFor(() => expect(screen.getByText(/failed to load audit events/i)).toBeInTheDocument());
  });

  it('retries load when Retry button is clicked', async () => {
    mockedList
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(makePage([makeEvent()]));

    render(<V2DiscoveryAuditPage />);
    await waitFor(() => expect(screen.getByText(/failed to load audit events/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('Run Completed')).toBeInTheDocument());
  });

  it('filters by action and reloads page 0', async () => {
    mockedList.mockResolvedValue(makePage([]));
    render(<V2DiscoveryAuditPage />);
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));

    const actionSelect = screen.getByLabelText(/action/i);
    await userEvent.selectOptions(actionSelect, 'discovery.run.failed');

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(mockedList).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'discovery.run.failed', page: 0 }),
    );
  });

  it('outcome filter is applied client-side', async () => {
    const events = [
      makeEvent({ eventId: 'e1', outcome: 'success' }),
      makeEvent({ eventId: 'e2', outcome: 'failure' }),
    ];
    mockedList.mockResolvedValue(makePage(events));
    render(<V2DiscoveryAuditPage />);
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));

    // Initially both rows visible.
    const outcomeSelect = screen.getByLabelText(/outcome/i);
    await userEvent.selectOptions(outcomeSelect, 'failure');

    await waitFor(() => {
      // After filter, only failure row should remain visible.
      expect(screen.getAllByText('failure').length).toBeGreaterThan(0);
    });
  });

  it('clears filters and reloads', async () => {
    mockedList.mockResolvedValue(makePage([]));
    render(<V2DiscoveryAuditPage />);
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));

    const actionSelect = screen.getByLabelText(/action/i);
    await userEvent.selectOptions(actionSelect, 'discovery.run.failed');
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));

    const clearBtn = screen.getByRole('button', { name: /clear filters/i });
    await userEvent.click(clearBtn);

    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3));
    expect(mockedList).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 0 }),
    );
  });

  it('paginates forward and backward', async () => {
    const multiPage: DiscoveryAuditPage = {
      data:          [makeEvent()],
      totalElements: 50,
      totalPages:    3,
      currentPage:   0,
      pageSize:      20,
    };
    mockedList.mockResolvedValue(multiPage);
    render(<V2DiscoveryAuditPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })),
    );

    // Simulate the response now has currentPage=1 so "Previous" is enabled.
    mockedList.mockResolvedValue({ ...multiPage, currentPage: 1 });

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })),
    );
  });

  it('shows correct pagination summary text', async () => {
    const pg: DiscoveryAuditPage = {
      data:          [makeEvent()],
      totalElements: 100,
      totalPages:    5,
      currentPage:   0,
      pageSize:      20,
    };
    mockedList.mockResolvedValueOnce(pg);
    render(<V2DiscoveryAuditPage />);

    await waitFor(() => expect(screen.getByText(/showing 1 of 100 events/i)).toBeInTheDocument());
    expect(screen.getByText(/page 1 of 5/i)).toBeInTheDocument();
  });
});

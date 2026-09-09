/**
 * Tests for DiscoveryRunStatusView.
 *
 * Polling tests use vi.useFakeTimers() + vi.advanceTimersByTimeAsync() so we
 * can precisely control the 2s poll interval without waiting real time.
 *
 * IMPORTANT: Never use vi.runAllTimersAsync() here — the component uses
 * setInterval which repeats indefinitely, causing an "infinite loop" abort.
 * Use vi.advanceTimersByTimeAsync(N) to advance by a specific duration instead.
 *
 * The initial poll() is called directly (not via a timer) in useEffect, so
 * advancing by a small amount (e.g. 100ms) flushes those microtasks without
 * triggering the 2000ms interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../api/discovery.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/discovery.api')>();
  return { ...actual, getDiscoveryRun: vi.fn() };
});

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getDiscoveryRun } from '../../../api/discovery.api';
import { DiscoveryRunStatusView } from './DiscoveryRunStatusView';
import {
  mockDiscoveryRunRunning,
  mockDiscoveryRunCompleted,
  mockDiscoveryRunFailed,
} from '../../../api/mocks/discovery.mocks';

const mockedGet = vi.mocked(getDiscoveryRun);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  // Clear (not run) timers to prevent infinite interval loops during teardown.
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── Initial loading ───────────────────────────────────────────────────────────

describe('DiscoveryRunStatusView — initial load', () => {
  it('renders loading state before first poll resolves', () => {
    // Never-resolving promise keeps component in loading state.
    mockedGet.mockReturnValue(new Promise(() => {}));

    render(<DiscoveryRunStatusView runId="run-x" onComplete={vi.fn()} />);

    // Loading is the *initial* render state (loading=true in useState).
    // No waitFor needed — it is synchronously present on first render.
    // LoadingState renders role="status" aria-label="Fetching discovery run status…"
    expect(screen.getByRole('status', { name: /fetching/i })).toBeInTheDocument();
  });

  it('shows run ID and status after first successful poll', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunRunning);

    render(<DiscoveryRunStatusView runId="run-test-002" onComplete={vi.fn()} />);

    // Advance 100ms: flushes the microtasks from the direct poll() call
    // without triggering the 2000ms setInterval.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // The span renders "Run run-test-002" — use regex to find partial text across nodes
    expect(screen.getByText(/run-test-002/)).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });
});

// ── Progress display ──────────────────────────────────────────────────────────

describe('DiscoveryRunStatusView — progress display', () => {
  it('shows metric counters from sweep data', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunRunning);
    render(<DiscoveryRunStatusView runId="run-test-002" onComplete={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // From mockDiscoveryRunRunning: totalHosts=254, hostsScanned=120, reachableHosts=18
    expect(screen.getByText('254')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('renders progress bar with progressbar role', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunRunning);
    render(<DiscoveryRunStatusView runId="run-test-002" onComplete={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('progressbar', { name: /icmp sweep/i })).toBeInTheDocument();
  });
});

// ── Polling lifecycle ─────────────────────────────────────────────────────────

describe('DiscoveryRunStatusView — polling lifecycle', () => {
  it('polls the API multiple times over 2s intervals', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunRunning);
    render(<DiscoveryRunStatusView runId="run-x" onComplete={vi.fn()} />);

    // Initial poll fires immediately in useEffect (direct call, not via timer)
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(mockedGet).toHaveBeenCalledTimes(1);

    // Advance 2s → second poll via setInterval
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockedGet).toHaveBeenCalledTimes(2);

    // Advance another 2s → third poll
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('stops polling and calls onComplete when status becomes COMPLETED', async () => {
    mockedGet
      .mockResolvedValueOnce(mockDiscoveryRunRunning)
      .mockResolvedValue(mockDiscoveryRunCompleted);

    const onComplete = vi.fn();
    render(<DiscoveryRunStatusView runId="run-x" onComplete={onComplete} />);

    // Poll 1: RUNNING (initial direct call)
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    // Poll 2: COMPLETED → stops interval + queues 800ms delay
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockedGet).toHaveBeenCalledTimes(2);

    // Advance through the 800ms onComplete delay
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(onComplete).toHaveBeenCalledOnce();

    // Confirm no further polls after stop
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('stops polling and shows failure message when FAILED', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunFailed);
    render(<DiscoveryRunStatusView runId="run-x" onComplete={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('alert')).toHaveTextContent(/run failed/i);

    // Confirm interval stopped — no more calls after 6s
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    mockedGet.mockResolvedValue(mockDiscoveryRunRunning);
    const onComplete = vi.fn();

    const { unmount } = render(<DiscoveryRunStatusView runId="run-x" onComplete={onComplete} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const callCount = mockedGet.mock.calls.length;

    unmount();

    // No more polls after unmount
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mockedGet).toHaveBeenCalledTimes(callCount);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('DiscoveryRunStatusView — error handling', () => {
  it('shows sticky error and stops polling after 3 consecutive errors', async () => {
    mockedGet.mockRejectedValue({ response: { status: 500 } });

    render(<DiscoveryRunStatusView runId="run-x" onComplete={vi.fn()} />);

    // Error 1: initial direct poll
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    // Error 2: first interval tick
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    // Error 3: second interval tick → MAX_CONSECUTIVE_ERRORS reached → stop
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // State is synchronously updated after 3 errors — no waitFor needed with fake timers
    expect(screen.getByRole('alert')).toHaveTextContent(/lost connection/i);

    const callsAfterStop = mockedGet.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockedGet).toHaveBeenCalledTimes(callsAfterStop); // no more polls
  });

  it('shows 404 message and stops immediately on not-found error', async () => {
    mockedGet.mockRejectedValue({ response: { status: 404 } });

    render(<DiscoveryRunStatusView runId="missing" onComplete={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('renders Back button and calls onBack on click', async () => {
    mockedGet.mockRejectedValue({ response: { status: 404 } });

    const onBack = vi.fn();
    render(<DiscoveryRunStatusView runId="missing" onComplete={vi.fn()} onBack={onBack} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();

    // Switch to real timers for userEvent interaction
    vi.useRealTimers();
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

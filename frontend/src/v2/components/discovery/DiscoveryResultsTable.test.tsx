import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../api/discovery.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/discovery.api')>();
  return { ...actual, getDiscoveryRunResults: vi.fn() };
});

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getDiscoveryRunResults } from '../../../api/discovery.api';
import { DiscoveryResultsTable } from './DiscoveryResultsTable';
import {
  mockDiscoveryResults,
  mockResultCiscoSwitch,
  mockResultSnmpAuthFailed,
} from '../../../api/mocks/discovery.mocks';

const mockedGetResults = vi.mocked(getDiscoveryRunResults);

beforeEach(() => vi.clearAllMocks());

// ── Loading state ─────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — loading', () => {
  it('shows loading state while fetching', () => {
    mockedGetResults.mockImplementation(() => new Promise(() => {}));
    render(<DiscoveryResultsTable runId="run-x" />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});

// ── Data rendering ────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — data rendering', () => {
  it('renders a row for each discovery result', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    render(<DiscoveryResultsTable runId="run-test-003" />);

    await waitFor(() => {
      expect(screen.getByText('192.168.1.10')).toBeInTheDocument();
    });

    expect(screen.getByText('192.168.1.11')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.20')).toBeInTheDocument();
  });

  it('shows device count in toolbar', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    render(<DiscoveryResultsTable runId="run-test-003" />);

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`${mockDiscoveryResults.length} device`, 'i')),
      ).toBeInTheDocument();
    });
  });

  it('renders status badges for ICMP and SNMP status', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    render(<DiscoveryResultsTable runId="run-test-003" />);

    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
      expect(screen.getByText('Success')).toBeInTheDocument();
    });
  });

  it('renders vendor and model columns', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    render(<DiscoveryResultsTable runId="run-test-003" />);

    await waitFor(() => {
      expect(screen.getAllByText('Cisco').length).toBeGreaterThan(0);
      expect(screen.getByText('Catalyst')).toBeInTheDocument();
    });
  });

  it('renders N/A for missing vendor/model fields', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultSnmpAuthFailed]);
    render(<DiscoveryResultsTable runId="run-test-003" />);

    await waitFor(() => {
      expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    });
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — empty state', () => {
  it('shows empty state when API returns empty array', async () => {
    mockedGetResults.mockResolvedValueOnce([]);
    render(<DiscoveryResultsTable runId="run-empty" />);

    await waitFor(() => {
      expect(screen.getByText(/no devices found/i)).toBeInTheDocument();
    });
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — error state', () => {
  it('shows error message on API failure', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 500 } });
    render(<DiscoveryResultsTable runId="run-fail" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
    });
  });

  it('shows 404 message when run not found', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 404 } });
    render(<DiscoveryResultsTable runId="missing-run" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
    });
  });

  it('shows 403 message when user lacks permission', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 403 } });
    render(<DiscoveryResultsTable runId="forbidden-run" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/permission/i);
    });
  });
});

// ── Selection logic ───────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — selection', () => {
  it('enables Add to Inventory button when a row is selected', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onAdd = vi.fn();
    const user = userEvent.setup();

    render(<DiscoveryResultsTable runId="run-x" onAddToInventory={onAdd} />);

    await waitFor(() => screen.getByText('192.168.1.10'));

    // Select the row
    const checkbox = screen.getByRole('checkbox', { name: /select 192\.168\.1\.10/i });
    await user.click(checkbox);

    const btn = screen.getByRole('button', { name: /add to inventory/i });
    expect(btn).not.toBeDisabled();
  });

  it('Add to Inventory button is disabled when no rows selected', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    render(<DiscoveryResultsTable runId="run-x" onAddToInventory={vi.fn()} />);

    await waitFor(() => screen.getByText('192.168.1.10'));

    const btn = screen.getByRole('button', { name: /add to inventory/i });
    expect(btn).toBeDisabled();
  });

  it('calls onAddToInventory with selected results', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onAdd = vi.fn();
    const user = userEvent.setup();

    render(<DiscoveryResultsTable runId="run-x" onAddToInventory={onAdd} />);

    await waitFor(() => screen.getByText('192.168.1.10'));

    await user.click(screen.getByRole('checkbox', { name: /select 192\.168\.1\.10/i }));
    await user.click(screen.getByRole('button', { name: /add to inventory/i }));

    expect(onAdd).toHaveBeenCalledWith([mockResultCiscoSwitch]);
  });

  it('select all checkbox selects all rows', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    const user = userEvent.setup();

    render(<DiscoveryResultsTable runId="run-x" onAddToInventory={vi.fn()} />);
    await waitFor(() => screen.getByText('192.168.1.10'));

    await user.click(screen.getByRole('checkbox', { name: /select all/i }));

    expect(
      screen.getByText(new RegExp(`${mockDiscoveryResults.length} selected`, 'i')),
    ).toBeInTheDocument();
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — filtering', () => {
  it('filter input is rendered', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    render(<DiscoveryResultsTable runId="run-x" />);

    await waitFor(() => screen.getByText('192.168.1.10'));

    expect(screen.getByRole('textbox', { name: /filter/i })).toBeInTheDocument();
  });
});

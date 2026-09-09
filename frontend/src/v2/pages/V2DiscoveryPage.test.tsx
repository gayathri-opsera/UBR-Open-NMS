/**
 * Tests for V2DiscoveryPage — WO-025
 *
 * Covers: SNMP Discovery tab presence, workflow view transitions
 * (form → status → results → form), and edge cases.
 *
 * All child components (DiscoveryTriggerForm, DiscoveryRunStatusView,
 * DiscoveryResultsTable) are mocked so this test focuses solely on the
 * page-level integration and state machine, not the child components themselves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mock all child discovery components ───────────────────────────────────────
vi.mock('../components/discovery/DiscoveryTriggerForm', () => ({
  DiscoveryTriggerForm: ({ onRunCreated }: { onRunCreated: (r: { runId: string }) => void }) => (
    <div data-testid="trigger-form">
      <button onClick={() => onRunCreated({ runId: 'run-test-001' })}>
        Submit Form
      </button>
    </div>
  ),
}));

vi.mock('../components/discovery/DiscoveryRunStatusView', () => ({
  DiscoveryRunStatusView: ({
    runId,
    onComplete,
    onBack,
  }: {
    runId: string;
    onComplete: () => void;
    onBack: () => void;
  }) => (
    <div data-testid="status-view">
      <span>Monitoring run: {runId}</span>
      <button onClick={onComplete}>Mark Complete</button>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('../components/discovery/DiscoveryResultsTable', () => ({
  DiscoveryResultsTable: ({ runId }: { runId: string }) => (
    <div data-testid="results-table">Results for run: {runId}</div>
  ),
}));

// ── Mock APIs that V2DiscoveryPage fetches on mount ───────────────────────────
vi.mock('../../api/devices.api', () => ({
  fetchDevices: vi.fn().mockResolvedValue([]),
  updateDevice: vi.fn(),
  deleteDevice: vi.fn(),
}));

vi.mock('../../api/alarms.api', () => ({
  fetchAlarms: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: {} }), put: vi.fn() },
}));

vi.mock('../components/common/Toast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
import V2DiscoveryPage from './V2DiscoveryPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <V2DiscoveryPage />
    </MemoryRouter>,
  );
}

/** Click the SNMP Discovery tab button */
async function openSnmpTab() {
  const snmpTab = await screen.findByRole('button', { name: /snmp discovery/i });
  fireEvent.click(snmpTab);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('V2DiscoveryPage — SNMP Discovery tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any session storage from previous tests
    sessionStorage.removeItem('vf_snmp_active_run_id');
  });

  it('renders the SNMP Discovery tab button', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /snmp discovery/i })).toBeInTheDocument();
  });

  it('shows the DiscoveryTriggerForm by default on the SNMP Discovery tab', async () => {
    renderPage();
    await openSnmpTab();
    expect(screen.getByTestId('trigger-form')).toBeInTheDocument();
  });

  it('transitions to status view after a run is created', async () => {
    renderPage();
    await openSnmpTab();

    // Submit the trigger form (mock calls onRunCreated with runId='run-test-001')
    fireEvent.click(screen.getByRole('button', { name: /submit form/i }));

    // Form should unmount, status view should appear
    expect(screen.queryByTestId('trigger-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-view')).toBeInTheDocument();
    expect(screen.getByText('Monitoring run: run-test-001')).toBeInTheDocument();
  });

  it('transitions to results view when run completes', async () => {
    renderPage();
    await openSnmpTab();

    // form → status
    fireEvent.click(screen.getByRole('button', { name: /submit form/i }));
    expect(screen.getByTestId('status-view')).toBeInTheDocument();

    // status → results
    fireEvent.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(screen.queryByTestId('status-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('results-table')).toBeInTheDocument();
    expect(screen.getByText('Results for run: run-test-001')).toBeInTheDocument();
  });

  it('shows Start New Discovery button in results view that resets to form', async () => {
    renderPage();
    await openSnmpTab();

    // Drive through the full workflow: form → status → results
    fireEvent.click(screen.getByRole('button', { name: /submit form/i }));
    fireEvent.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(screen.getByTestId('results-table')).toBeInTheDocument();

    // Click "Start New Discovery"
    fireEvent.click(screen.getByRole('button', { name: /start new discovery/i }));
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('trigger-form')).toBeInTheDocument();
  });

  it('shows form when Back is clicked from status view', async () => {
    renderPage();
    await openSnmpTab();

    // form → status
    fireEvent.click(screen.getByRole('button', { name: /submit form/i }));
    expect(screen.getByTestId('status-view')).toBeInTheDocument();

    // Click Back in status view
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.queryByTestId('status-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('trigger-form')).toBeInTheDocument();
  });

  it('restores status view from sessionStorage on mount if a run was in progress', async () => {
    // Simulate a page refresh with a run already in progress
    sessionStorage.setItem('vf_snmp_active_run_id', 'run-restored-999');

    renderPage();
    await openSnmpTab();

    // Should immediately show status view for the restored run
    expect(screen.getByTestId('status-view')).toBeInTheDocument();
    expect(screen.getByText('Monitoring run: run-restored-999')).toBeInTheDocument();
  });

  it('clears sessionStorage when run completes', async () => {
    sessionStorage.setItem('vf_snmp_active_run_id', 'run-test-001');
    renderPage();
    await openSnmpTab();

    // Mark run as complete
    fireEvent.click(screen.getByRole('button', { name: /mark complete/i }));

    expect(sessionStorage.getItem('vf_snmp_active_run_id')).toBeNull();
  });

  it('persists runId to sessionStorage when a new run is created', async () => {
    renderPage();
    await openSnmpTab();

    fireEvent.click(screen.getByRole('button', { name: /submit form/i }));

    expect(sessionStorage.getItem('vf_snmp_active_run_id')).toBe('run-test-001');
  });
});

describe('V2DiscoveryPage — existing tabs still render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.removeItem('vf_snmp_active_run_id');
  });

  it('renders Provisioning Queue tab by default', async () => {
    renderPage();
    // The provisioning tab is active by default
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /provisioning queue/i })).toBeInTheDocument();
    });
  });

  it('all five tab buttons are present', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /provisioning queue/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /auth failures/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /all discovered/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /snmp discovery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mode admin/i })).toBeInTheDocument();
  });
});

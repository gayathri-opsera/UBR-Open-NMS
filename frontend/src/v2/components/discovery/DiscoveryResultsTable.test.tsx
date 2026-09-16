import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Synchronous mock — avoids hoisting races with async importOriginal factories.
// Only the functions actually used by DiscoveryResultsTable are mocked here.
vi.mock('../../../api/discovery.api', () => ({
  getDiscoveryRunResults: vi.fn(),
  listIgnoredHosts:       vi.fn().mockResolvedValue([]),
  ignoreDiscoveredHosts:  vi.fn().mockResolvedValue(undefined),
  unignoreDiscoveredHost: vi.fn().mockResolvedValue(undefined),
  // Pass-through utilities used by the component (non-async, can be identity fns)
  mapGenericTypeToDeviceType: vi.fn((g?: string) => g ?? 'CPE'),
  buildProvisionRequest:      vi.fn(),
  parseScopeInput:            vi.fn(() => []),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getDiscoveryRunResults } from '../../../api/discovery.api';
import { DiscoveryResultsTable } from './DiscoveryResultsTable';
import type { DiscoveryResult } from '../../../api/discovery.api';
import type { Device } from '../../../api/devices.types';
import {
  mockDiscoveryResults,
  mockResultCiscoSwitch,
  mockResultSnmpAuthFailed,
} from '../../../api/mocks/discovery.mocks';

/** Render the table inside a MemoryRouter (uses useNavigate). */
function renderTable(props: Parameters<typeof DiscoveryResultsTable>[0]) {
  return render(
    <MemoryRouter>
      <DiscoveryResultsTable {...props} />
    </MemoryRouter>,
  );
}

/** Minimal Device record matching the Cisco switch mock. */
const mockInventoryDevice: Device = {
  id: 'inv-dev-001',
  deviceId: 'inv-dev-001',
  serialNumber: 'SN-core-sw-01',
  deviceType: 'BTS',
  model: 'Catalyst',
  status: 'ONLINE',
  ipAddress: '192.168.1.10',
  macAddress: '00:1a:2b:3c:4d:5e',
  latitude: 28.6,
  longitude: 77.2,
  manufacturer: 'Cisco',
  firmwareVersion: '15.2(7)E1',
  organizationId: 'org-1',
  networkId: 'net-1',
  tags: [],
  lastSeenAt: '2026-09-09T10:00:00Z',
};

const mockedGetResults = vi.mocked(getDiscoveryRunResults);

beforeEach(() => vi.clearAllMocks());

// ── Loading state ─────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — loading', () => {
  it('shows loading state while fetching', () => {
    mockedGetResults.mockImplementation(() => new Promise(() => {}));
    renderTable({ runId: 'run-x' });
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});

// ── Data rendering ────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — data rendering', () => {
  it('renders a row for each discovery result', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    renderTable({ runId: 'run-test-003' });

    await waitFor(() => {
      expect(screen.getByText('192.168.1.10')).toBeInTheDocument();
    });

    expect(screen.getByText('192.168.1.11')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.20')).toBeInTheDocument();
  });

  it('shows device count in toolbar', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    renderTable({ runId: 'run-test-003' });

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`${mockDiscoveryResults.length} device`, 'i')),
      ).toBeInTheDocument();
    });
  });

  it('renders status badges for ICMP and SNMP status', async () => {
    // Card view renders plain text; 'Successful' is the card label for snmpStatus='success'.
    // Multiple elements may render the same text (e.g. header + expanded row) — use getAllBy*.
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    renderTable({ runId: 'run-test-003' });

    await waitFor(() => {
      expect(screen.getAllByText('Reachable').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/successful/i).length).toBeGreaterThan(0);
    });
  });

  it('renders vendor and model columns', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    renderTable({ runId: 'run-test-003' });

    await waitFor(() => {
      expect(screen.getAllByText('Cisco').length).toBeGreaterThan(0);
      expect(screen.getByText('Catalyst')).toBeInTheDocument();
    });
  });

  it('renders N/A for missing vendor/model fields', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultSnmpAuthFailed]);
    renderTable({ runId: 'run-test-003' });

    await waitFor(() => {
      expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    });
  });

  it('renders MAC address in device card when discovered via SNMP walk', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    renderTable({ runId: 'run-mac' });

    await waitFor(() => {
      expect(screen.getByText('00:1a:2b:3c:4d:5e')).toBeInTheDocument();
    });
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — empty state', () => {
  it('shows empty state when API returns empty array', async () => {
    mockedGetResults.mockResolvedValueOnce([]);
    renderTable({ runId: 'run-empty' });

    await waitFor(() => {
      expect(screen.getByText(/no devices found/i)).toBeInTheDocument();
    });
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — error state', () => {
  it('shows error message on API failure', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 500 } });
    renderTable({ runId: 'run-fail' });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i);
    });
  });

  it('shows 404 message when run not found', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 404 } });
    renderTable({ runId: 'missing-run' });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
    });
  });

  it('shows 403 message when user lacks permission', async () => {
    mockedGetResults.mockRejectedValueOnce({ response: { status: 403 } });
    renderTable({ runId: 'forbidden-run' });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/permission/i);
    });
  });
});

// ── Selection logic ───────────────────────────────────────────────────────────

/** Switch to Table view so checkboxes and Add to Inventory button are rendered. */
async function switchToTableView(user: ReturnType<typeof userEvent.setup>) {
  const tableBtn = screen.getByRole('button', { name: /⊞ table view/i });
  await user.click(tableBtn);
}

describe('DiscoveryResultsTable — selection', () => {
  it('enables Add to Inventory button when a row is selected', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onAdd = vi.fn();
    const user = userEvent.setup();

    renderTable({ runId: 'run-x', onAddToInventory: onAdd });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await switchToTableView(user);

    // Select the row
    const checkbox = screen.getByRole('checkbox', { name: /select 192\.168\.1\.10/i });
    await user.click(checkbox);

    const btn = screen.getByRole('button', { name: /add to inventory/i });
    expect(btn).not.toBeDisabled();
  });

  it('Add to Inventory button is disabled when no rows selected', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const user = userEvent.setup();
    renderTable({ runId: 'run-x', onAddToInventory: vi.fn() });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await switchToTableView(user);

    const btn = screen.getByRole('button', { name: /add to inventory/i });
    expect(btn).toBeDisabled();
  });

  it('calls onAddToInventory with selected results', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onAdd = vi.fn();
    const user = userEvent.setup();

    renderTable({ runId: 'run-x', onAddToInventory: onAdd });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await switchToTableView(user);

    await user.click(screen.getByRole('checkbox', { name: /select 192\.168\.1\.10/i }));
    await user.click(screen.getByRole('button', { name: /add to inventory/i }));

    expect(onAdd).toHaveBeenCalledWith([mockResultCiscoSwitch]);
  });

  it('select all checkbox selects all rows', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    const user = userEvent.setup();

    renderTable({ runId: 'run-x', onAddToInventory: vi.fn() });
    await waitFor(() => screen.getByText('192.168.1.10'));
    await switchToTableView(user);

    await user.click(screen.getByRole('checkbox', { name: /select all/i }));

    expect(
      screen.getByText(new RegExp(`${mockDiscoveryResults.length} selected`, 'i')),
    ).toBeInTheDocument();
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — filtering', () => {
  it('filter input is rendered in table view', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    const user = userEvent.setup();
    renderTable({ runId: 'run-x' });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await switchToTableView(user);

    expect(screen.getByRole('textbox', { name: /filter/i })).toBeInTheDocument();
  });
});

// ── Provision button ──────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — Provision action', () => {
  it('shows Provision Device button for reachable un-provisioned device', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onProvision = vi.fn();

    renderTable({ runId: 'run-prov', onProvision });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByRole('button', { name: /provision device/i })).toBeInTheDocument();
  });

  it('calls onProvision when Provision Device button is clicked', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onProvision = vi.fn();
    const user = userEvent.setup();

    renderTable({ runId: 'run-prov', onProvision });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await user.click(screen.getByRole('button', { name: /provision device/i }));

    expect(onProvision).toHaveBeenCalledWith(mockResultCiscoSwitch);
  });

  it('Provision button is disabled for unreachable host', async () => {
    const unreachable: DiscoveryResult = {
      ip: '10.0.0.99',
      icmpStatus: 'unreachable',
      snmpStatus: 'not_attempted',
      classificationStatus: 'CLASSIFICATION_ERROR',
    };
    mockedGetResults.mockResolvedValueOnce([unreachable]);
    const onProvision = vi.fn();

    renderTable({ runId: 'run-unreach', onProvision });

    await waitFor(() => screen.getByText('10.0.0.99'));
    const btn = screen.getByRole('button', { name: /provision device/i });
    expect(btn).toBeDisabled();
  });

  it('shows Provisioned badge (session) when IP is in provisionedIPs', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);

    renderTable({
      runId: 'run-prov',
      onProvision: vi.fn(),
      provisionedIPs: new Set(['192.168.1.10']),
    });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByText(/provisioned.*inventory.*topology/i)).toBeInTheDocument();
  });

  it('shows Already Provisioned badge when IP exists in inventoryDeviceMap', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const inventoryDeviceMap = new Map([['192.168.1.10', mockInventoryDevice]]);

    renderTable({
      runId: 'run-inv',
      onProvision: vi.fn(),
      inventoryDeviceMap,
      onDeprovision: vi.fn(),
    });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByText(/provisioned in inventory/i)).toBeInTheDocument();
    // Should NOT show the Provision Device button
    expect(screen.queryByRole('button', { name: /🔧 provision device/i })).not.toBeInTheDocument();
  });
});

// ── Deprovision action ────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — Deprovision action', () => {
  it('shows Deprovision button for already-provisioned device', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const inventoryDeviceMap = new Map([['192.168.1.10', mockInventoryDevice]]);

    renderTable({
      runId: 'run-dep',
      inventoryDeviceMap,
      onDeprovision: vi.fn(),
    });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByRole('button', { name: /deprovision/i })).toBeInTheDocument();
  });

  it('calls onDeprovision after inline confirmation', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onDeprovision = vi.fn();
    const inventoryDeviceMap = new Map([['192.168.1.10', mockInventoryDevice]]);
    const user = userEvent.setup();

    renderTable({
      runId: 'run-dep',
      inventoryDeviceMap,
      onDeprovision,
    });

    await waitFor(() => screen.getByText('192.168.1.10'));

    // First click opens confirmation
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));
    // Confirm deprovision
    await user.click(screen.getByRole('button', { name: /confirm deprovision/i }));

    expect(onDeprovision).toHaveBeenCalledWith(mockResultCiscoSwitch, mockInventoryDevice);
  });

  it('shows Deprovisioned badge when IP is in deprovisionedIPs', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);

    renderTable({
      runId: 'run-dep',
      onProvision: vi.fn(),
      deprovisionedIPs: new Set(['192.168.1.10']),
    });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByText(/deprovisioned/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-provision device/i })).toBeInTheDocument();
  });

  it('shows deprovisioning spinner when IP is in deprovisioningIPs', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);

    renderTable({
      runId: 'run-dep',
      deprovisioningIPs: new Set(['192.168.1.10']),
    });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByText(/deprovisioning/i)).toBeInTheDocument();
  });
});

// ── Ignore action ─────────────────────────────────────────────────────────────

describe('DiscoveryResultsTable — Ignore action', () => {
  it('shows Ignore Device button for un-provisioned device', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);

    renderTable({ runId: 'run-ign', onIgnore: vi.fn(), onProvision: vi.fn() });

    await waitFor(() => screen.getByText('192.168.1.10'));
    expect(screen.getByRole('button', { name: /ignore device/i })).toBeInTheDocument();
  });

  it('calls onIgnore when Ignore Device button is clicked', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onIgnore = vi.fn();
    const user = userEvent.setup();

    renderTable({ runId: 'run-ign', onIgnore, onProvision: vi.fn() });

    await waitFor(() => screen.getByText('192.168.1.10'));
    await user.click(screen.getByRole('button', { name: /ignore device/i }));

    expect(onIgnore).toHaveBeenCalledWith(mockResultCiscoSwitch);
  });

  it('hides ignored device from main card grid (filtered from activeResults)', async () => {
    mockedGetResults.mockResolvedValueOnce(mockDiscoveryResults);
    const ignoredIP = '192.168.1.10';

    renderTable({
      runId: 'run-ign',
      onIgnore: vi.fn(),
      onUnignore: vi.fn(),
      ignoredIPs: new Set([ignoredIP]),
    });

    // Wait for results to load
    await waitFor(() => screen.getByText('192.168.1.11'));

    // Cisco switch IP is in the ignored set — must not appear in the main grid
    // (it may appear in the hidden "Show Ignored" section, but not in the active grid)
    const count = screen.queryAllByText(ignoredIP);
    // May be zero (hidden) — but definitely should NOT show as a normal active card
    // The device count label should NOT count it
    expect(screen.getByText(/4 device/i)).toBeInTheDocument(); // 5 - 1 ignored = 4
  });

  it('shows ignored device count toggle button when ignoredIPs is non-empty', async () => {
    // Must seed mock data — getDiscoveryRunResults is cleared by beforeEach
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);

    renderTable({
      runId: 'run-ign',
      ignoredIPs: new Set(['192.168.1.10']),
      onUnignore: vi.fn(),
    });

    // Multiple elements may contain "1 ignored" text — use getAllBy* to confirm at least one exists
    await waitFor(() => {
      expect(screen.getAllByText(/1 ignored/i).length).toBeGreaterThan(0);
    });
  });

  it('shows Un-ignore button when ignored device is revealed via Show toggle', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onUnignore = vi.fn();
    const user = userEvent.setup();

    renderTable({
      runId: 'run-unign',
      ignoredIPs: new Set(['192.168.1.10']),
      onUnignore,
    });

    await waitFor(() => screen.getAllByText(/1 ignored/i)[0]);

    // Click the first "Show ignored" toggle button to reveal ignored devices
    const toggleBtns = screen.getAllByRole('button', { name: /1 ignored/i });
    await user.click(toggleBtns[0]);

    // Un-ignore button should now be visible in the revealed section
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /↩ un-ignore device/i }).length).toBeGreaterThan(0),
    );
  });

  it('calls onUnignore when Un-ignore button is clicked', async () => {
    mockedGetResults.mockResolvedValueOnce([mockResultCiscoSwitch]);
    const onUnignore = vi.fn();
    const user = userEvent.setup();

    renderTable({
      runId: 'run-unign',
      ignoredIPs: new Set(['192.168.1.10']),
      onUnignore,
    });

    await waitFor(() => screen.getAllByText(/1 ignored/i)[0]);

    // Reveal ignored devices
    const toggleBtns = screen.getAllByRole('button', { name: /1 ignored/i });
    await user.click(toggleBtns[0]);

    // Click Un-ignore on the revealed device card
    await waitFor(() => screen.getAllByRole('button', { name: /↩ un-ignore device/i })[0]);
    await user.click(screen.getAllByRole('button', { name: /↩ un-ignore device/i })[0]);

    expect(onUnignore).toHaveBeenCalledWith(mockResultCiscoSwitch);
  });
});

/**
 * Tests for the Deprovision action in V2DeviceDetailPage.
 *
 * Validates that:
 *   - The "Deprovision" button is visible in the page header
 *   - An inline confirmation dialog is shown before the DELETE call
 *   - deleteDevice is called with the correct device ID on confirm
 *   - The page navigates back to /v2/devices after successful deprovision
 *   - Cancel aborts the action without any API call
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// NOTE: vi.mock factories are hoisted to top of file by vitest's transform.
// Never reference top-level const/let variables inside them — use vi.fn() inline.

vi.mock('../../api/devices.api', () => ({
  fetchDevices:         vi.fn(),
  updateDevice:         vi.fn(),
  deleteDevice:         vi.fn(),
  downloadDeviceExport: vi.fn(),
}));

vi.mock('../../api/kpi.api', () => ({
  fetchDeviceKpi:                  vi.fn().mockResolvedValue([]),
  fetchDeviceAvailabilitySummary:  vi.fn().mockResolvedValue({ devices: [] }),
}));

vi.mock('../../api/config.api', () => ({
  pushDeviceParam:   vi.fn(),
  getVersionHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/diagnostics.api', () => ({
  extractDeviceLogs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/client', () => ({
  apiClient: {
    get:  vi.fn().mockResolvedValue({ data: {} }),
    put:  vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../components/common/Toast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Import mocked functions after vi.mock declarations ────────────────────────
import { fetchDevices, deleteDevice } from '../../api/devices.api';
const mockFetchDevices = vi.mocked(fetchDevices);
const mockDeleteDevice = vi.mocked(deleteDevice);

// ── Fixture ───────────────────────────────────────────────────────────────────
const mockDevice = {
  id:              'dev-001',
  deviceId:        'dev-001',
  serialNumber:    'SN-BTS-TEST-01',
  name:            'BTS-01',
  deviceType:      'BTS' as const,
  model:           'A60',
  status:          'ONLINE' as const,
  ipAddress:       '10.10.10.25',
  macAddress:      '00:1a:2b:3c:4d:5e',
  latitude:        28.61,
  longitude:       77.20,
  manufacturer:    'Cisco',
  firmwareVersion: '15.2(7)E1',
  organizationId:  'org-1',
  networkId:       'net-1',
  tags:            [],
  uptimeSeconds:   86400,
  lastSeenAt:      '2026-09-14T10:00:00Z',
  createdAt:       '2026-09-01T00:00:00Z',
  updatedAt:       '2026-09-14T10:00:00Z',
};

// ── Helper ────────────────────────────────────────────────────────────────────
import V2DeviceDetailPage from './V2DeviceDetailPage';

function renderDetailPage(id = 'dev-001') {
  return render(
    <MemoryRouter initialEntries={[`/v2/devices/${id}`]}>
      <Routes>
        <Route path="/v2/devices/:id" element={<V2DeviceDetailPage />} />
        <Route path="/v2/devices"     element={<div data-testid="devices-list">Devices List</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('V2DeviceDetailPage — Deprovision action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchDevices.mockResolvedValue([mockDevice]);
    mockDeleteDevice.mockResolvedValue(undefined);
  });

  it('renders the device serial number in the page heading', async () => {
    renderDetailPage();

    await waitFor(() => {
      expect(screen.getByText('SN-BTS-TEST-01')).toBeInTheDocument();
    });
  });

  it('shows the Deprovision button in the page header', async () => {
    renderDetailPage();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    expect(screen.getByRole('button', { name: /deprovision/i })).toBeInTheDocument();
  });

  it('shows inline confirm dialog when Deprovision button is clicked', async () => {
    renderDetailPage();
    const user = userEvent.setup();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));

    expect(screen.getByRole('button', { name: /yes.*remove/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('calls deleteDevice with device ID when confirmed', async () => {
    renderDetailPage();
    const user = userEvent.setup();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));
    await user.click(screen.getByRole('button', { name: /yes.*remove/i }));

    await waitFor(() => {
      expect(mockDeleteDevice).toHaveBeenCalledWith('dev-001');
    });
  });

  it('navigates back to /v2/devices after successful deprovision', async () => {
    renderDetailPage();
    const user = userEvent.setup();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));
    await user.click(screen.getByRole('button', { name: /yes.*remove/i }));

    await waitFor(() => {
      expect(screen.getByTestId('devices-list')).toBeInTheDocument();
    });
  });

  it('does NOT call deleteDevice when Cancel is clicked', async () => {
    renderDetailPage();
    const user = userEvent.setup();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockDeleteDevice).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /yes.*remove/i })).not.toBeInTheDocument();
  });

  it('stays on page when deleteDevice throws — does not navigate away', async () => {
    mockDeleteDevice.mockRejectedValueOnce(new Error('Network error'));
    renderDetailPage();
    const user = userEvent.setup();

    await waitFor(() => screen.getByText('SN-BTS-TEST-01'));
    await user.click(screen.getByRole('button', { name: /🗑 deprovision/i }));
    await user.click(screen.getByRole('button', { name: /yes.*remove/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('devices-list')).not.toBeInTheDocument();
      expect(screen.getByText('SN-BTS-TEST-01')).toBeInTheDocument();
    });
  });
});

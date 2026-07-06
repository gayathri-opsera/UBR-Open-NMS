import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeviceTable } from '../../components/devices/DeviceTable';
import { MOCK_DEVICES } from '../../mocks/devices.mock';

describe('DeviceTable', () => {
  const onSelect = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it('renders device rows', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    expect(screen.getByText('SN-001-ABC')).toBeInTheDocument();
    expect(screen.getByText('SN-002-XYZ')).toBeInTheDocument();
  });

  it('shows empty state when no devices', () => {
    render(<DeviceTable devices={[]} onSelect={onSelect} />);
    expect(screen.getByText(/no devices found/i)).toBeInTheDocument();
  });

  it('shows online/offline status badges', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    expect(screen.getAllByText('ONLINE').length).toBe(2);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('shows pending command badge for device with pending > 0', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    expect(screen.getByText('2')).toBeInTheDocument(); // d1 has 2 pending
  });

  it('does not show pending badge when 0', () => {
    const noPending = MOCK_DEVICES.map((d) => ({ ...d, pendingCommandCount: 0 }));
    render(<DeviceTable devices={noPending} onSelect={onSelect} />);
    // No badge text should exist for pending
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('calls onSelect when row clicked', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('SN-001-ABC'));
    expect(onSelect).toHaveBeenCalledWith(MOCK_DEVICES[0]);
  });

  it('displays GPS coordinates when available', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    expect(screen.getByText(/23\.8103/)).toBeInTheDocument();
  });

  it('shows dash for devices without GPS', () => {
    render(<DeviceTable devices={MOCK_DEVICES} onSelect={onSelect} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

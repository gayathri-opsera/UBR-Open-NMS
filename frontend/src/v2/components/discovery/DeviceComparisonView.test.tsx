import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DeviceComparisonView, propertyDiffers, COMPARISON_PROPERTIES } from './DeviceComparisonView';
import { mockComparisonDevices } from '../../../api/mocks/discovery.mocks';

describe('propertyDiffers', () => {
  it('detects differing model values', () => {
    const modelProp = COMPARISON_PROPERTIES.find((p) => p.key === 'model')!;
    expect(propertyDiffers(mockComparisonDevices, modelProp)).toBe(true);
  });

  it('detects matching vendor values', () => {
    const vendorProp = COMPARISON_PROPERTIES.find((p) => p.key === 'vendor')!;
    expect(propertyDiffers(mockComparisonDevices, vendorProp)).toBe(false);
  });
});

describe('DeviceComparisonView', () => {
  it('renders side-by-side property rows for selected devices', () => {
    render(
      <DeviceComparisonView
        open
        devices={mockComparisonDevices}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Compare 2 devices')).toBeInTheDocument();
    expect(screen.getAllByText('192.168.1.10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('192.168.1.12').length).toBeGreaterThan(0);
    expect(screen.getByText('Catalyst')).toBeInTheDocument();
    expect(screen.getByText('Catalyst-3850')).toBeInTheDocument();
  });

  it('calls onClose when Close is clicked', async () => {
    const onClose = vi.fn();
    render(
      <DeviceComparisonView
        open
        devices={mockComparisonDevices}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('invokes onAddToInventory with selected devices', async () => {
    const onAdd = vi.fn();
    render(
      <DeviceComparisonView
        open
        devices={mockComparisonDevices}
        onClose={vi.fn()}
        onAddToInventory={onAdd}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /add selected to inventory/i }));
    expect(onAdd).toHaveBeenCalledWith(mockComparisonDevices);
  });
});

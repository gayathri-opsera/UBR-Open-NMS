import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DeviceComparisonView, propertyDiffers, COMPARISON_PROPERTIES } from './DeviceComparisonView';
import {
  mockComparisonDevices,
  mockResultUnreachableWithGuidedFailure,
  mockResultSnmpAuthFailedWithGuidedFailure,
  mockResultSnmpTimeout,
  mockResultUnknownFingerprint,
  mockResultConflictFingerprint,
  mockResultRegistryUnavailable,
  mockAllFailureResults,
} from '../../../api/mocks/discovery.mocks';

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

// ── WO-011: Guided failure fixtures shape validation ──────────────────────────

describe('WO-011 guided failure fixtures', () => {
  it('each failure fixture has required guidedFailure fields', () => {
    for (const result of mockAllFailureResults) {
      expect(result.guidedFailure).toBeDefined();
      const gf = result.guidedFailure!;
      expect(gf.category).toBeTruthy();
      expect(gf.code).toBeTruthy();
      expect(gf.explicitReason).toBeTruthy();
      expect(typeof gf.retryable).toBe('boolean');
      expect(gf.recommendedNextAction).toBeTruthy();
      expect(gf.correlationId).toBeTruthy();
    }
  });

  it('REACHABILITY_FAILURE fixture has no lastSuccessfulProtocol', () => {
    const gf = mockResultUnreachableWithGuidedFailure.guidedFailure!;
    expect(gf.category).toBe('REACHABILITY_FAILURE');
    expect(gf.lastSuccessfulProtocolAttempt).toBeFalsy();
    expect(gf.lastAttemptedProtocol).toBe('ICMP');
    expect(gf.retryable).toBe(true);
  });

  it('CREDENTIAL_FAILURE fixture has lastSuccessful=ICMP', () => {
    const gf = mockResultSnmpAuthFailedWithGuidedFailure.guidedFailure!;
    expect(gf.category).toBe('CREDENTIAL_FAILURE');
    expect(gf.lastSuccessfulProtocolAttempt).toBe('ICMP');
    expect(gf.retryable).toBe(true);
  });

  it('PROTOCOL_TIMEOUT fixture is retryable', () => {
    const gf = mockResultSnmpTimeout.guidedFailure!;
    expect(gf.category).toBe('PROTOCOL_TIMEOUT');
    expect(gf.retryable).toBe(true);
  });

  it('UNKNOWN_FINGERPRINT fixture is not retryable', () => {
    const gf = mockResultUnknownFingerprint.guidedFailure!;
    expect(gf.category).toBe('UNKNOWN_FINGERPRINT');
    expect(gf.retryable).toBe(false);
  });

  it('CONFLICTING_FINGERPRINT fixture is not retryable', () => {
    const gf = mockResultConflictFingerprint.guidedFailure!;
    expect(gf.category).toBe('CONFLICTING_FINGERPRINT');
    expect(gf.retryable).toBe(false);
  });

  it('REGISTRY_UNAVAILABLE fixture is retryable', () => {
    const gf = mockResultRegistryUnavailable.guidedFailure!;
    expect(gf.category).toBe('REGISTRY_UNAVAILABLE');
    expect(gf.retryable).toBe(true);
  });

  it('no fixture contains credential-like strings in explicitReason', () => {
    const forbidden = ['password', 'secret', 'token', 'community', 'apikey', 'api_key', 'private_key'];
    for (const result of mockAllFailureResults) {
      const gf = result.guidedFailure!;
      const lower = gf.explicitReason.toLowerCase();
      for (const kw of forbidden) {
        expect(lower, `"${kw}" found in explicitReason for ${gf.category}`).not.toContain(kw);
      }
    }
  });

  it('no fixture contains credential-like strings in recommendedNextAction', () => {
    const forbidden = ['password', 'secret', 'api_key', 'apikey', 'private_key'];
    for (const result of mockAllFailureResults) {
      const gf = result.guidedFailure!;
      const lower = gf.recommendedNextAction.toLowerCase();
      for (const kw of forbidden) {
        expect(lower, `"${kw}" found in recommendedNextAction for ${gf.category}`).not.toContain(kw);
      }
    }
  });
});

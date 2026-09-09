import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the discovery API client before importing the component.
vi.mock('../../../api/discovery.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/discovery.api')>();
  return {
    ...actual,
    createDiscoveryRun: vi.fn(),
  };
});

// Mock credentials API — return empty list so the community-string fallback is shown.
// Tests that specifically need stored credentials can override listCredentials per-case.
vi.mock('../../../api/credentials.api', () => ({
  listCredentials: vi.fn().mockResolvedValue([]),
}));

// Mock the logger to suppress noise in test output.
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { createDiscoveryRun } from '../../../api/discovery.api';
import { DiscoveryTriggerForm } from './DiscoveryTriggerForm';
import { mockDiscoveryRunResponse } from '../../../api/mocks/discovery.mocks';

// ── Toast provider wrapper ────────────────────────────────────────────────────

import { ToastProvider } from '../common/Toast';
import React from 'react';

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

const mockedCreateRun = vi.mocked(createDiscoveryRun);

beforeEach(() => vi.clearAllMocks());

// ── Render ────────────────────────────────────────────────────────────────────

describe('DiscoveryTriggerForm — rendering', () => {
  it('renders all required form fields', async () => {
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    expect(screen.getByLabelText(/discovery scope/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/snmp protocol/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/community string/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/timeout/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/retries/i)).toBeInTheDocument();
  });

  it('renders Start Discovery button', () => {
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /start discovery/i })).toBeInTheDocument();
  });

  it('Start Discovery button is disabled when form is empty/invalid', () => {
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    const button = screen.getByRole('button', { name: /start discovery/i });
    expect(button).toBeDisabled();
  });

  it('community string input is masked (type="password")', async () => {
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    const communityInput = await screen.findByLabelText(/community string/i) as HTMLInputElement;
    expect(communityInput.type).toBe('password');
  });
});

// ── Scope validation ──────────────────────────────────────────────────────────

describe('DiscoveryTriggerForm — scope validation', () => {
  it('enables Submit button when a valid CIDR is entered', async () => {
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    const scopeInput = screen.getByLabelText(/discovery scope/i);
    await user.type(scopeInput, '192.168.1.0/24');
    await user.tab(); // trigger blur to show validation

    const button = screen.getByRole('button', { name: /start discovery/i });
    expect(button).not.toBeDisabled();
  });

  it('shows validation error for invalid IP entered in scope', async () => {
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    const scopeInput = screen.getByLabelText(/discovery scope/i);
    await user.type(scopeInput, '192.168.1.256'); // invalid octet
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent(/not a valid/i);
  });

  it('shows error for invalid IP range (start > end)', async () => {
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    const scopeInput = screen.getByLabelText(/discovery scope/i);
    await user.type(scopeInput, '10.0.0.50-10.0.0.1'); // inverted range
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent(/start ip must be before/i);
  });

  it('keeps button disabled when scope is invalid', async () => {
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    const scopeInput = screen.getByLabelText(/discovery scope/i);
    await user.type(scopeInput, 'not-valid!!!');
    await user.tab();

    expect(screen.getByRole('button', { name: /start discovery/i })).toBeDisabled();
  });
});

// ── Submission success ────────────────────────────────────────────────────────

describe('DiscoveryTriggerForm — successful submission', () => {
  it('calls createDiscoveryRun with correct parameters and invokes onRunCreated', async () => {
    mockedCreateRun.mockResolvedValueOnce(mockDiscoveryRunResponse);
    const onRunCreated = vi.fn();
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={onRunCreated} />);

    // Fill in valid scope
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();

    // Submit
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(mockedCreateRun).toHaveBeenCalledOnce();
      const callArg = mockedCreateRun.mock.calls[0][0];
      expect(callArg.scope).toHaveLength(1);
      expect(callArg.scope[0]).toMatchObject({ type: 'CIDR', value: '10.0.0.0/24' });
      expect((callArg as { protocol?: string }).protocol).toBe('SNMP_V2C');
    });

    await waitFor(() => {
      // onRunCreated now receives the full DiscoveryRunResponse (WO-027).
      expect(onRunCreated).toHaveBeenCalledWith(mockDiscoveryRunResponse);
    });
  });

  it('shows loading state on the button during submission', async () => {
    // Delay the response to observe loading state
    mockedCreateRun.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(mockDiscoveryRunResponse), 200)),
    );
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    // During loading the button text changes and becomes disabled
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /starting/i });
      expect(btn).toBeDisabled();
    });

    // After resolution it goes back
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start discovery/i })).toBeInTheDocument();
    });
  });
});

// ── Submission failure ────────────────────────────────────────────────────────

describe('DiscoveryTriggerForm — submission failure', () => {
  it('shows a toast error on HTTP 400 (scope validation failure)', async () => {
    mockedCreateRun.mockRejectedValueOnce({ response: { status: 400 } });
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(screen.getByText(/scope validation failed/i)).toBeInTheDocument();
    });
  });

  it('shows a permissions error toast on HTTP 403', async () => {
    mockedCreateRun.mockRejectedValueOnce({ response: { status: 403 } });
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(screen.getByText(/permission/i)).toBeInTheDocument();
    });
  });

  it('shows a generic error toast on 5xx server error', async () => {
    mockedCreateRun.mockRejectedValueOnce({ response: { status: 500 } });
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to start discovery/i)).toBeInTheDocument();
    });
  });

  it('re-enables the submit button after an error', async () => {
    mockedCreateRun.mockRejectedValueOnce({ response: { status: 500 } });
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start discovery/i })).not.toBeDisabled();
    });
  });

  it('does not invoke onRunCreated when the API call fails', async () => {
    mockedCreateRun.mockRejectedValueOnce({ response: { status: 500 } });
    const onRunCreated = vi.fn();
    const user = userEvent.setup();

    renderWithToast(<DiscoveryTriggerForm onRunCreated={onRunCreated} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /start discovery/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to start discovery/i)).toBeInTheDocument();
    });

    expect(onRunCreated).not.toHaveBeenCalled();
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('DiscoveryTriggerForm — edge cases', () => {
  it('does not submit when scope is empty', async () => {
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    // Do not fill scope, directly try to submit
    const button = screen.getByRole('button', { name: /start discovery/i });
    expect(button).toBeDisabled();
    // Button is disabled so click has no effect
    await user.click(button);
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  it('validates community string is not empty', async () => {
    // wait for credentials load so fallback community field is visible
    const user = userEvent.setup();
    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);

    // Enter valid scope
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.0/24');
    await user.tab();

    // Clear the community string
    const communityInput = await screen.findByLabelText(/community string/i);
    await user.clear(communityInput);
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent(/community string is required/i);
    expect(screen.getByRole('button', { name: /start discovery/i })).toBeDisabled();
  });

  it('accepts IP range format in scope', async () => {
    const user = userEvent.setup();
    mockedCreateRun.mockResolvedValueOnce(mockDiscoveryRunResponse);

    renderWithToast(<DiscoveryTriggerForm onRunCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/discovery scope/i), '10.0.0.1-10.0.0.50');
    await user.tab();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start discovery/i })).not.toBeDisabled();
  });
});

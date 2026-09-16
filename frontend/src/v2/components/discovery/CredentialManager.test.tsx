/**
 * Unit tests for CredentialManager component (WO-023).
 *
 * Covers:
 *  - Renders loading state while fetching.
 *  - Renders empty state when no credentials exist.
 *  - Renders credential rows (name, version, timestamps).
 *  - Add credential: opens modal, fills form, calls createCredential.
 *  - Edit credential: opens pre-populated modal, calls updateCredential.
 *  - Delete credential: confirms inline, calls deleteCredential.
 *  - Error states: API failure banner, 403 admin toast.
 *  - Security: sensitive fields not rendered in the table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('../../../api/credentials.api', () => ({
  listCredentials:   vi.fn(),
  createCredential:  vi.fn(),
  updateCredential:  vi.fn(),
  deleteCredential:  vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
} from '../../../api/credentials.api';
import type { CredentialSummary } from '../../../api/credentials.api';
import { CredentialManager } from './CredentialManager';
import { ToastProvider } from '../common/Toast';

const mockedList   = vi.mocked(listCredentials);
const mockedCreate = vi.mocked(createCredential);
const mockedUpdate = vi.mocked(updateCredential);
const mockedDelete = vi.mocked(deleteCredential);

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCredential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id:          'cred-0001',
    name:        'Prod-v2c-Default',
    description: 'Production community string',
    version:     'V2C',
    createdAt:   '2026-01-01T00:00:00Z',
    updatedAt:   '2026-06-01T00:00:00Z',
    createdBy:   'admin@example.com',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

// ── Loading ───────────────────────────────────────────────────────────────────

describe('CredentialManager — loading', () => {
  it('shows loading state while fetching credentials', () => {
    mockedList.mockReturnValueOnce(new Promise(() => undefined));
    renderWithToast(<CredentialManager />);
    expect(screen.getByText(/loading credentials/i)).toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('CredentialManager — empty state', () => {
  it('shows empty state when no credentials exist', async () => {
    mockedList.mockResolvedValueOnce([]);
    renderWithToast(<CredentialManager />);
    await waitFor(() => {
      expect(screen.getByText(/no credentials configured/i)).toBeInTheDocument();
    });
  });
});

// ── Table rendering ───────────────────────────────────────────────────────────

describe('CredentialManager — table', () => {
  it('renders credential name and version in table', async () => {
    mockedList.mockResolvedValueOnce([makeCredential()]);
    renderWithToast(<CredentialManager />);
    await waitFor(() => {
      expect(screen.getByText('Prod-v2c-Default')).toBeInTheDocument();
      expect(screen.getByText('SNMPV2C')).toBeInTheDocument();
    });
  });

  it('renders SNMPv3 credential with security level', async () => {
    mockedList.mockResolvedValueOnce([
      makeCredential({
        id: 'cred-v3',
        name: 'Core-v3-AuthPriv',
        version: 'V3',
        securityLevel: 'AUTH_PRIV',
        authProtocol: 'SHA',
      }),
    ]);
    renderWithToast(<CredentialManager />);
    await waitFor(() => {
      expect(screen.getByText('Core-v3-AuthPriv')).toBeInTheDocument();
      expect(screen.getByText('SNMPV3')).toBeInTheDocument();
      expect(screen.getByText('AUTH_PRIV')).toBeInTheDocument();
    });
  });

  it('does not render community string or auth keys in the table', async () => {
    mockedList.mockResolvedValueOnce([makeCredential({ communityMasked: '***' })]);
    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByText('Prod-v2c-Default'));
    // Sensitive fields must never appear in plaintext.
    expect(screen.queryByText(/public/)).not.toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
  });
});

// ── Create credential ─────────────────────────────────────────────────────────

describe('CredentialManager — create', () => {
  it('opens modal when Add Credential is clicked', async () => {
    mockedList.mockResolvedValueOnce([]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByText(/no credentials configured/i));

    await user.click(screen.getByRole('button', { name: /add credential/i }));
    expect(screen.getByRole('dialog', { name: /add snmp credential/i })).toBeInTheDocument();
  });

  it('calls createCredential with correct payload on form submit', async () => {
    mockedList
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeCredential()]);
    mockedCreate.mockResolvedValueOnce(makeCredential());
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /add credential/i }));
    await user.click(screen.getByRole('button', { name: /add credential/i }));

    // Fill in credential name
    await user.type(screen.getByLabelText(/credential name/i), 'Test-Cred');

    // Fill community string (v2c selected by default)
    await user.type(screen.getByLabelText(/community string/i), 'private');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name:      'Test-Cred',
          version:   'V2C',
          community: 'private',
        }),
      );
    });
  });

  it('shows validation error when name is empty', async () => {
    mockedList.mockResolvedValueOnce([]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /add credential/i }));
    await user.click(screen.getByRole('button', { name: /add credential/i }));

    // Try to submit without filling required fields
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('shows toast on 409 duplicate name error', async () => {
    mockedList.mockResolvedValueOnce([]);
    mockedCreate.mockRejectedValueOnce({ response: { status: 409 } });
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /add credential/i }));
    await user.click(screen.getByRole('button', { name: /add credential/i }));

    await user.type(screen.getByLabelText(/credential name/i), 'Dup');
    await user.type(screen.getByLabelText(/community string/i), 'public');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    });
  });

  it('shows admin role toast on 403 error', async () => {
    mockedList.mockResolvedValueOnce([]);
    mockedCreate.mockRejectedValueOnce({ response: { status: 403 } });
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /add credential/i }));
    await user.click(screen.getByRole('button', { name: /add credential/i }));

    await user.type(screen.getByLabelText(/credential name/i), 'AdminTest');
    await user.type(screen.getByLabelText(/community string/i), 'public');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/admin role required/i).length).toBeGreaterThan(0);
    });
  });
});

// ── Edit credential ───────────────────────────────────────────────────────────

describe('CredentialManager — edit', () => {
  it('opens edit modal pre-populated with credential data', async () => {
    const cred = makeCredential({ name: 'Edit-Me', description: 'My desc' });
    mockedList.mockResolvedValueOnce([cred]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByText('Edit-Me'));

    await user.click(screen.getByRole('button', { name: /edit edit-me/i }));
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/edit-me/i);
    });
    // Name should be pre-filled
    expect(screen.getByLabelText(/credential name/i)).toHaveValue('Edit-Me');
  });

  it('calls updateCredential on save', async () => {
    const cred = makeCredential();
    mockedList
      .mockResolvedValueOnce([cred])
      .mockResolvedValueOnce([{ ...cred, name: 'Updated-Name' }]);
    mockedUpdate.mockResolvedValueOnce({ ...cred, name: 'Updated-Name' });
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByText('Prod-v2c-Default'));

    await user.click(screen.getByRole('button', { name: /edit prod-v2c-default/i }));
    await waitFor(() => screen.getByLabelText(/credential name/i));

    // Change name (re-enter community — edit form requires it for v2c rotation)
    await user.clear(screen.getByLabelText(/credential name/i));
    await user.type(screen.getByLabelText(/credential name/i), 'Updated-Name');
    await user.type(screen.getByLabelText(/community string/i), 'public');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(mockedUpdate).toHaveBeenCalledWith(
        cred.id,
        expect.objectContaining({ name: 'Updated-Name' }),
      );
    });
  });
});

// ── Delete credential ─────────────────────────────────────────────────────────

describe('CredentialManager — delete', () => {
  it('shows inline confirmation before deleting', async () => {
    mockedList.mockResolvedValue([makeCredential()]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /delete prod-v2c-default/i }));

    await user.click(screen.getByRole('button', { name: /delete prod-v2c-default/i }));
    expect(screen.getByText(/delete\?/i)).toBeInTheDocument();
  });

  it('calls deleteCredential when confirmed', async () => {
    const cred = makeCredential();
    mockedList
      .mockResolvedValueOnce([cred])
      .mockResolvedValueOnce([]);
    mockedDelete.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /delete prod-v2c-default/i }));

    await user.click(screen.getByRole('button', { name: /delete prod-v2c-default/i }));
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith(cred.id);
    });
  });

  it('does not delete when Cancel is clicked', async () => {
    mockedList.mockResolvedValue([makeCredential()]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('button', { name: /delete prod-v2c-default/i }));

    await user.click(screen.getByRole('button', { name: /delete prod-v2c-default/i }));
    await user.click(screen.getByRole('button', { name: /cancel delete/i }));

    expect(mockedDelete).not.toHaveBeenCalled();
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('CredentialManager — error state', () => {
  it('shows error banner when listCredentials fails', async () => {
    mockedList.mockRejectedValue(new Error('Network error'));
    renderWithToast(<CredentialManager />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load credentials/i);
    });
  });

  it('retries on clicking Retry button', async () => {
    mockedList
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce([]);
    const user = userEvent.setup();

    renderWithToast(<CredentialManager />);
    await waitFor(() => screen.getByRole('alert'));
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(mockedList).toHaveBeenCalledTimes(2);
    });
  });
});

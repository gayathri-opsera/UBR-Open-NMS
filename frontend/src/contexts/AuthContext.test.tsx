import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// Mock the API module
vi.mock('../api/auth.api', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  getMe: vi.fn(),
}));

// Mock react-router-dom navigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { AuthProvider, useAuth } from '../contexts/AuthContext';
import * as authApi from '../api/auth.api';
import { clearTokens } from '../auth/tokens';

function TestConsumer(): React.ReactElement {
  const { user, isAuthenticated, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="auth-status">{isAuthenticated ? 'logged-in' : 'logged-out'}</span>
      <span data-testid="username">{user?.username ?? 'none'}</span>
      <button onClick={() => { login('alice', 'pass').catch(() => {}); }}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function wrap(ui: React.ReactElement): React.ReactElement {
  return <MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    clearTokens();
    vi.clearAllMocks();
  });

  it('starts unauthenticated', () => {
    render(wrap(<TestConsumer />));
    expect(screen.getByTestId('auth-status').textContent).toBe('logged-out');
  });

  it('authenticates after successful login', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 900_000 },
      user: { id: '1', username: 'alice', email: 'alice@x.com', role: 'Operator', fullName: 'Alice' },
    });

    render(wrap(<TestConsumer />));
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('auth-status').textContent).toBe('logged-in'));
    expect(screen.getByTestId('username').textContent).toBe('alice');
  });

  it('stays logged-out on login failure', async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error('401'));
    render(wrap(<TestConsumer />));
    // userEvent click triggers login; AuthContext propagates rejection;
    // wrap the interaction so the unhandled promise does not bubble as test error
    try {
      await userEvent.click(screen.getByText('login'));
    } catch {
      // expected rejection
    }
    // auth status must remain logged-out
    await waitFor(() => expect(screen.getByTestId('auth-status').textContent).toBe('logged-out'));
  });

  it('clears user on logout', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 900_000 },
      user: { id: '1', username: 'alice', email: 'alice@x.com', role: 'Operator', fullName: 'Alice' },
    });
    vi.mocked(authApi.logout).mockResolvedValue(undefined);

    render(wrap(<TestConsumer />));
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('auth-status').textContent).toBe('logged-in'));
    await userEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(screen.getByTestId('auth-status').textContent).toBe('logged-out'));
  });
});

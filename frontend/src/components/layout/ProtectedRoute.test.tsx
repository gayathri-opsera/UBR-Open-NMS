import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ProtectedRoute } from './ProtectedRoute';
import * as authCtx from '../../contexts/AuthContext';

describe('ProtectedRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(isAuthenticated: boolean, role: string) {
    vi.mocked(authCtx.useAuth).mockReturnValue({
      isAuthenticated,
      isLoading: false,
      user: isAuthenticated ? { id: '1', username: 'u', email: 'e', role: role as never, fullName: 'F' } : null,
      mfaChallenge: null,
      login: vi.fn(),
      completeMfaChallenge: vi.fn(),
      cancelMfaChallenge: vi.fn(),
      logout: vi.fn(),
    });
  }

  it('redirects unauthenticated user to /login', () => {
    setup(false, '');
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route
            path="/dashboard"
            element={<ProtectedRoute><div>Dashboard</div></ProtectedRoute>}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders children for authenticated user', () => {
    setup(true, 'Operator');
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={<ProtectedRoute><div>Dashboard</div></ProtectedRoute>}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('redirects User role to /dashboard when Admin-only route accessed', () => {
    setup(true, 'User');
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/dashboard" element={<div>Dashboard</div>} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute allowedRoles={['Admin']}>
                <div>Admin</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('allows Admin to access admin-only route', () => {
    setup(true, 'Admin');
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/dashboard" element={<div>Dashboard</div>} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute allowedRoles={['Admin']}>
                <div>Admin Panel</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Admin Panel')).toBeInTheDocument();
  });
});

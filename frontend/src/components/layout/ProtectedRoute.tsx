import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { Role } from '../../auth/tokens';

interface Props {
  children: React.ReactNode;
  allowedRoles?: Role[];
}

export function ProtectedRoute({ children, allowedRoles }: Props): React.ReactElement {
  const { isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--bg-base)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--accent)', fontSize: 14,
      }}>
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Case-insensitive role check so 'admin' matches 'Admin' etc.
  if (allowedRoles && user) {
    const userRoleLower = user.role.toLowerCase();
    const allowed = allowedRoles.some((r) => r.toLowerCase() === userRoleLower);
    if (!allowed) return <Navigate to="/v2/dashboard" replace />;
  }

  return <>{children}</>;
}

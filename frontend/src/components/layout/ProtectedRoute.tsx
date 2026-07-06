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

  // While rehydrating auth from localStorage, show nothing (avoids flash-redirect to /login)
  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a1628',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#60a5fa', fontSize: 14,
      }}>
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

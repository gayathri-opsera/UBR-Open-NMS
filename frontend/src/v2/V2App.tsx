import React, { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { V2AppShell } from './components/layout/V2AppShell';
import { LoadingState } from './components/common/States';
import { ErrorBoundary } from './components/common/States';
import { ToastProvider } from './components/common/Toast';
import type { Role } from '../auth/tokens';

import './styles/v2-theme.css';
import './styles/v2-animations.css';
import './styles/v2-responsive.css';
import './styles/v2-premium.css';

// ── Lazy-loaded V2 pages ──────────────────────────────────────────────────────

const V2CustomDashboardPage = lazy(() => import('./pages/V2CustomDashboardPage'));
const V2DashboardPage     = lazy(() => import('./pages/V2DashboardPage'));
const V2DevicesPage       = lazy(() => import('./pages/V2DevicesPage'));
const V2DeviceDetailPage  = lazy(() => import('./pages/V2DeviceDetailPage'));
const V2AlarmsPage        = lazy(() => import('./pages/V2AlarmsPage'));
const V2TopologyPage      = lazy(() => import('./pages/V2TopologyPage'));
const V2KpiPage           = lazy(() => import('./pages/V2KpiPage'));
const V2ConfigPage        = lazy(() => import('./pages/V2ConfigPage'));
const V2HierarchyPage     = lazy(() => import('./pages/V2HierarchyPage'));
const V2TroubleshootPage  = lazy(() => import('./pages/V2TroubleshootPage'));
const V2ReportsPage       = lazy(() => import('./pages/V2ReportsPage'));
const V2NotificationsPage = lazy(() => import('./pages/V2NotificationsPage'));
const V2AdminPage         = lazy(() => import('./pages/V2AdminPage'));
const V2GroupsPage        = lazy(() => import('./pages/V2GroupsPage'));
const V2ProfilePage       = lazy(() => import('./pages/V2ProfilePage'));
const V2NotFoundPage      = lazy(() => import('./pages/V2NotFoundPage'));

// ── Auth guard ────────────────────────────────────────────────────────────────

interface V2ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: Role[];
}

function V2ProtectedRoute({ children, allowedRoles }: V2ProtectedRouteProps) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) return <LoadingState fullPage label="Authenticating…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (allowedRoles && user) {
    const normalize = (r: string) => r.charAt(0).toUpperCase() + r.slice(1).toLowerCase();
    const userRole = normalize(String(user.role));
    const permitted = allowedRoles.some((r) => r === user.role || normalize(r) === userRole);
    if (!permitted) return <Navigate to="/v2/dashboard" replace />;
  }

  return <>{children}</>;
}

function V2Fallback() {
  return <LoadingState label="Loading page…" />;
}

// ── V2 Route Configuration ────────────────────────────────────────────────────

export function V2App() {
  return (
    <ToastProvider>
      <V2ProtectedRoute>
        <V2AppShell>
          <ErrorBoundary>
            <Suspense fallback={<V2Fallback />}>
              <Routes>
                <Route index element={<Navigate to="/v2/dashboard" replace />} />
                <Route path="dashboard"       element={<V2DashboardPage />} />
                <Route path="dashboards"      element={<V2CustomDashboardPage />} />
                <Route path="devices"         element={<V2DevicesPage />} />
                <Route path="devices/:id"     element={<V2DeviceDetailPage />} />
                <Route path="alarms"          element={<V2AlarmsPage />} />
                <Route path="topology"        element={<V2TopologyPage />} />
                <Route path="kpi"             element={<V2KpiPage />} />
                <Route
                  path="config"
                  element={
                    <V2ProtectedRoute allowedRoles={['Admin', 'Operator']}>
                      <V2ConfigPage />
                    </V2ProtectedRoute>
                  }
                />
                <Route
                  path="hierarchy"
                  element={
                    <V2ProtectedRoute allowedRoles={['Admin', 'Operator']}>
                      <V2HierarchyPage />
                    </V2ProtectedRoute>
                  }
                />
                <Route
                  path="troubleshoot"
                  element={
                    <V2ProtectedRoute allowedRoles={['Admin', 'Operator']}>
                      <V2TroubleshootPage />
                    </V2ProtectedRoute>
                  }
                />
                <Route path="reports"       element={<V2ReportsPage />} />
                <Route path="groups"        element={<V2GroupsPage />} />
                <Route
                  path="notifications"
                  element={
                    <V2ProtectedRoute allowedRoles={['Admin']}>
                      <V2NotificationsPage />
                    </V2ProtectedRoute>
                  }
                />
                <Route
                  path="admin"
                  element={
                    <V2ProtectedRoute allowedRoles={['Admin']}>
                      <V2AdminPage />
                    </V2ProtectedRoute>
                  }
                />
                <Route path="profile" element={<V2ProfilePage />} />
                <Route path="*" element={<V2NotFoundPage />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </V2AppShell>
      </V2ProtectedRoute>
    </ToastProvider>
  );
}

import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { V2App } from './v2/V2App';

const DashboardPage          = lazy(() => import('./pages/DashboardPage'));
const DevicesPage            = lazy(() => import('./pages/DevicesPage'));
const DeviceDetailPage       = lazy(() => import('./pages/DeviceDetailPage'));
const AlarmsPage             = lazy(() => import('./pages/AlarmsPage'));
const TopologyPage           = lazy(() => import('./pages/TopologyPage'));
const KpiPage                = lazy(() => import('./pages/KpiPage'));
const ConfigPage             = lazy(() => import('./pages/ConfigPage'));
const ReportsPage            = lazy(() => import('./pages/ReportsPage'));
const AdminPage              = lazy(() => import('./pages/AdminPage'));
const DiscoveryPage          = lazy(() => import('./pages/DiscoveryPage'));
const TroubleshootingPage    = lazy(() => import('./pages/TroubleshootingPage'));
const NotificationRulesPage  = lazy(() => import('./pages/NotificationRulesPage'));
const CustomDashboardPage    = lazy(() => import('./pages/CustomDashboardPage'));
const NotFoundPage           = lazy(() => import('./pages/NotFoundPage'));

function LoadingFallback(): React.ReactElement {
  return (
    <div style={{ color: 'var(--accent)', padding: 24, fontSize: 14 }}>Loading…</div>
  );
}

export default function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          {/* V2 UI — new VisualForge shell mounted at /v2/* */}
          <Route path="/v2/*" element={<V2App />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppShell>
                  <Suspense fallback={<LoadingFallback />}>
                    <Routes>
                      <Route path="/dashboard"        element={<DashboardPage />} />
                      <Route path="/devices"          element={<DevicesPage />} />
                      <Route path="/devices/:id"      element={<DeviceDetailPage />} />
                      <Route path="/alarms"           element={<AlarmsPage />} />
                      <Route path="/topology"         element={<TopologyPage />} />
                      <Route path="/kpi"              element={<KpiPage />} />
                      <Route path="/discovery"        element={<DiscoveryPage />} />
                      <Route path="/troubleshoot"     element={<TroubleshootingPage />} />
                      <Route path="/notifications"    element={<NotificationRulesPage />} />
                      <Route path="/dashboards"       element={<CustomDashboardPage />} />
                      <Route
                        path="/config"
                        element={
                          <ProtectedRoute allowedRoles={['Admin', 'Operator']}>
                            <ConfigPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/reports"
                        element={
                          <ProtectedRoute allowedRoles={['Admin', 'Operator']}>
                            <ReportsPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/admin"
                        element={
                          <ProtectedRoute allowedRoles={['Admin']}>
                            <AdminPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </Suspense>
                </AppShell>
              </ProtectedRoute>
            }
          />
        </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

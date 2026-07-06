import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { Role } from '../../auth/tokens';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  allowedRoles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard',  label: 'Dashboard',    icon: '⊞', allowedRoles: ['Admin', 'Operator', 'User', 'admin', 'operator', 'user'] },
  { path: '/devices',    label: 'Devices',      icon: '📡', allowedRoles: ['Admin', 'Operator', 'User', 'admin', 'operator', 'user'] },
  { path: '/alarms',     label: 'Alarms',       icon: '🔔', allowedRoles: ['Admin', 'Operator', 'User', 'admin', 'operator', 'user'] },
  { path: '/topology',   label: 'Topology',     icon: '🗺', allowedRoles: ['Admin', 'Operator', 'User', 'admin', 'operator', 'user'] },
  { path: '/kpi',        label: 'KPI',          icon: '📈', allowedRoles: ['Admin', 'Operator', 'User', 'admin', 'operator', 'user'] },
  { path: '/config',     label: 'Config',       icon: '⚙', allowedRoles: ['Admin', 'Operator', 'admin', 'operator'] },
  { path: '/reports',    label: 'Reports',      icon: '📄', allowedRoles: ['Admin', 'Operator', 'admin', 'operator'] },
  { path: '/admin',      label: 'Admin',        icon: '🔑', allowedRoles: ['Admin', 'admin'] },
];

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const userRole = user?.role ?? '';
  const visibleItems = NAV_ITEMS.filter(
    (item) => !user || item.allowedRoles.includes(userRole as Role),
  );

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* Sidebar navigation */}
      <nav
        aria-label="Main navigation"
        style={{
          width: 220, background: '#0d1b2a', color: '#e0e8f0',
          display: 'flex', flexDirection: 'column', padding: '20px 0',
          borderRight: '1px solid #1e293b', flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ padding: '0 20px 20px', borderBottom: '1px solid #1e293b', marginBottom: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#60a5fa', letterSpacing: '-0.3px' }}>UBR NMS</div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>Network Management</div>
        </div>

        {/* Nav links */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {visibleItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              aria-label={item.label}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 20px', textDecoration: 'none',
                color: isActive ? '#e2e8f0' : '#94a3b8',
                background: isActive ? 'rgba(96,165,250,0.12)' : 'transparent',
                borderLeft: isActive ? '3px solid #60a5fa' : '3px solid transparent',
                fontSize: 13, fontWeight: isActive ? 600 : 400,
                transition: 'background 0.1s',
              })}
            >
              <span aria-hidden="true" style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>

        {/* User info + logout */}
        <div style={{ padding: '16px 20px', borderTop: '1px solid #1e293b' }}>
          {user && (
            <>
              <div style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 600, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.fullName || user.email}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                <span style={{ background: '#1e3a5f', color: '#93c5fd', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                  {user.role}
                </span>
              </div>
            </>
          )}
          <button
            onClick={handleLogout}
            aria-label="Sign out"
            style={{
              background: 'none', border: '1px solid #374151', color: '#94a3b8',
              padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              width: '100%', textAlign: 'left',
            }}
          >
            ⎋ Sign out
          </button>
        </div>
      </nav>

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top header */}
        <header
          role="banner"
          style={{
            background: '#0f172a', borderBottom: '1px solid #1e293b',
            padding: '0 24px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 15 }}>Network Operations Center</span>
          <span style={{ color: '#64748b', fontSize: 12 }}>{user?.email}</span>
        </header>

        {/* Skip-to-content link for keyboard users */}
        <a
          href="#main-content"
          style={{
            position: 'absolute', left: -9999, top: 'auto', width: 1, height: 1, overflow: 'hidden',
          }}
          onFocus={(e) => { (e.currentTarget as HTMLAnchorElement).style.cssText = 'position:fixed;top:8px;left:8px;width:auto;height:auto;padding:8px 16px;background:#2563eb;color:#fff;border-radius:4px;font-size:14px;font-weight:600;z-index:9999;text-decoration:none;'; }}
          onBlur={(e) => { (e.currentTarget as HTMLAnchorElement).style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;'; }}
        >
          Skip to main content
        </a>

        {/* Page content */}
        <main
          id="main-content"
          role="main"
          tabIndex={-1}
          style={{ flex: 1, overflow: 'auto', padding: 24, background: '#0a1628' }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

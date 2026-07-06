import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
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
  const { theme, toggleTheme, isDark } = useTheme();
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
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {/* Sidebar navigation */}
      <nav
        aria-label="Main navigation"
        style={{
          width: 220,
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          display: 'flex', flexDirection: 'column', padding: '20px 0',
          borderRight: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ padding: '0 20px 16px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--accent)', letterSpacing: '-0.3px' }}>UBR NMS</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Network Management</div>
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
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: isActive ? 'var(--accent-subtle)' : 'transparent',
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                fontSize: 13, fontWeight: isActive ? 600 : 400,
                transition: 'background 0.1s',
              })}
            >
              <span aria-hidden="true" style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>

        {/* Theme toggle */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              padding: '6px 10px', borderRadius: 6,
              cursor: 'pointer', fontSize: 12,
              transition: 'background 0.15s',
            }}
          >
            <span style={{ fontSize: 14 }}>{isDark ? '☀' : '◑'}</span>
            <span>{isDark ? 'Light Mode' : 'Dark Mode'}</span>
            <span style={{
              marginLeft: 'auto',
              background: 'var(--accent-bg)',
              color: 'var(--accent)',
              fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 700,
            }}>
              {theme.toUpperCase()}
            </span>
          </button>
        </div>

        {/* User info + logout */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          {user && (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.fullName || user.email}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                <span style={{ background: 'var(--accent-bg)', color: 'var(--accent)', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                  {user.role}
                </span>
              </div>
            </>
          )}
          <button
            onClick={handleLogout}
            aria-label="Sign out"
            style={{
              background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
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
            background: 'var(--bg-card)',
            borderBottom: '1px solid var(--border-subtle)',
            padding: '0 24px', height: 52,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 15 }}>Network Operations Center</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{user?.email}</span>
            <button
              onClick={toggleTheme}
              aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-secondary)',
                borderRadius: 4, padding: '4px 10px',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              {isDark ? '☀ Light' : '◑ Dark'}
            </button>
          </div>
        </header>

        {/* Skip-to-content link for keyboard users */}
        <a
          href="#main-content"
          style={{ position: 'absolute', left: -9999, top: 'auto', width: 1, height: 1, overflow: 'hidden' }}
          onFocus={(e) => { (e.currentTarget as HTMLAnchorElement).style.cssText = 'position:fixed;top:8px;left:8px;width:auto;height:auto;padding:8px 16px;background:var(--accent);color:#fff;border-radius:4px;font-size:14px;font-weight:600;z-index:9999;text-decoration:none;'; }}
          onBlur={(e) => { (e.currentTarget as HTMLAnchorElement).style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;'; }}
        >
          Skip to main content
        </a>

        {/* Page content */}
        <main
          id="main-content"
          role="main"
          tabIndex={-1}
          style={{ flex: 1, overflow: 'auto', padding: 24, background: 'var(--bg-base)' }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

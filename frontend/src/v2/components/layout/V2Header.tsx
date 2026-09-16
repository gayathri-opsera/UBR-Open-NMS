import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useTheme } from '../../../contexts/ThemeContext';

function buildBreadcrumbs(pathname: string): { label: string; path: string }[] {
  const labelMap: Record<string, string> = {
    v2: 'V2', dashboard: 'Dashboard', devices: 'Devices', alarms: 'Alarms',
    topology: 'Topology', kpi: 'KPI', config: 'Config', discovery: 'Discovery',
    troubleshoot: 'Troubleshoot', reports: 'Reports', notifications: 'Notifications',
    admin: 'Admin', dashboards: 'Dashboards',
  };

  const segments = pathname.replace(/^\//, '').split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let current = '';

  for (const seg of segments) {
    current += `/${seg}`;
    const label = labelMap[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
    crumbs.push({ label, path: current });
  }

  return crumbs;
}

export function V2Header() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const breadcrumbs = buildBreadcrumbs(location.pathname);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        gap: 16,
      }}
    >
      {/* Skip link */}
      <a
        href="#vf-main-content"
        style={{
          position: 'absolute',
          top: -100,
          left: 12,
          background: 'var(--vf-accent)',
          color: '#fff',
          padding: '6px 12px',
          borderRadius: 'var(--vf-radius-sm)',
          fontSize: 13,
          fontWeight: 600,
          zIndex: 9999,
          transition: `top var(--vf-transition-fast)`,
          textDecoration: 'none',
        }}
        onFocus={(e) => { (e.currentTarget as HTMLAnchorElement).style.top = '8px'; }}
        onBlur={(e) => { (e.currentTarget as HTMLAnchorElement).style.top = '-100px'; }}
      >
        Skip to main content
      </a>

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <ol
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            flexWrap: 'wrap',
          }}
        >
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <li key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && (
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M4 2l4 4-4 4" stroke="var(--vf-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
                {isLast ? (
                  <span
                    aria-current="page"
                    style={{
                      fontSize: 'var(--vf-type-body-size)',
                      fontWeight: 700,
                      color: 'var(--vf-text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    to={crumb.path}
                    style={{
                      fontSize: 'var(--vf-type-caption-size)',
                      color: 'var(--vf-text-secondary)',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                      fontWeight: 500,
                    }}
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            background: 'transparent',
            border: '1px solid var(--vf-border-default)',
            borderRadius: 'var(--vf-radius-sm)',
            color: 'var(--vf-text-secondary)',
            cursor: 'pointer',
            padding: 6,
            display: 'flex',
            alignItems: 'center',
            transition: `color var(--vf-transition-fast), border-color var(--vf-transition-fast)`,
          }}
        >
          {theme === 'dark'
            ? <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M7.5 1.5v1M13.5 7.5h-1M7.5 13.5v-1M1.5 7.5h1M11.7 3.3l-.7.7M4 11l-.7.7M11.7 11.7l-.7-.7M4 4l-.7-.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="7.5" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="1.3"/></svg>
            : <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M12 8.5A5 5 0 016.5 3 5.5 5.5 0 1012 8.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
        </button>

        {/* Notifications badge */}
        <button
          aria-label="View notifications"
          style={{
            position: 'relative',
            background: 'transparent',
            border: '1px solid var(--vf-border-default)',
            borderRadius: 'var(--vf-radius-sm)',
            color: 'var(--vf-text-secondary)',
            cursor: 'pointer',
            padding: 6,
            display: 'flex',
            alignItems: 'center',
            transition: `color var(--vf-transition-fast)`,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M7.5 1.5A4.5 4.5 0 0112 6v3.5l1.5 2h-12L3 9.5V6A4.5 4.5 0 017.5 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M6 12a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>

        {/* User menu */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="User menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: '1px solid var(--vf-border-subtle)',
              borderRadius: 'var(--vf-radius-md)',
              color: 'var(--vf-text-primary)',
              cursor: 'pointer',
              padding: '4px 8px 4px 4px',
              transition: `background var(--vf-transition-fast)`,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'var(--vf-accent-muted)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {user?.username.charAt(0).toUpperCase() ?? '?'}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.username ?? 'User'}
            </span>
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="User options"
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                background: 'var(--vf-elevated)',
                border: '1px solid var(--vf-border-default)',
                borderRadius: 'var(--vf-radius-md)',
                boxShadow: 'var(--vf-shadow-high)',
                minWidth: 160,
                overflow: 'hidden',
                animation: 'vf-scale-in 120ms ease',
                zIndex: 200,
              }}
            >
              <div
                style={{
                  padding: '10px 14px 8px',
                  borderBottom: '1px solid var(--vf-border-subtle)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                  {user?.username}
                </div>
                <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'capitalize' }}>
                  {String(user?.role ?? '').toLowerCase()}
                </div>
              </div>
              {/* Security Settings */}
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); navigate('/v2/profile'); }}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  color: 'var(--vf-text-primary)', cursor: 'pointer',
                  padding: '9px 14px', fontSize: 13, fontWeight: 500,
                  textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                  fontFamily: 'var(--vf-font-sans)',
                  borderBottom: '1px solid var(--vf-border-subtle)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 1L2 3.5v4C2 9.985 4.238 12.32 7 13c2.762-.68 5-3.015 5-5.5v-4L7 1z"/>
                  <polyline points="5 7 6.5 8.5 9.5 5.5"/>
                </svg>
                Security &amp; MFA
              </button>

              <button
                role="menuitem"
                onClick={async () => { setMenuOpen(false); await logout(); }}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--vf-danger)',
                  cursor: 'pointer',
                  padding: '9px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--vf-font-sans)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M5 7h6M9 5l2 2-2 2M9 7H3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M8 3H3a1 1 0 00-1 1v6a1 1 0 001 1h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

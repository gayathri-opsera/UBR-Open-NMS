import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import type { Role } from '../../auth/tokens';
import { apiClient } from '../../api/client';

// ── Constants ──────────────────────────────────────────────────────────────────
const SIDEBAR_W = 64;
const HEADER_H  = 52;

// ── Password strength helper ───────────────────────────────────────────────────
function pwStrength(pw: string): { score: number; label: string; color: string; hints: string[] } {
  const hints: string[] = [];
  if (pw.length < 8)  hints.push('At least 8 characters');
  if (!/[A-Z]/.test(pw)) hints.push('One uppercase letter');
  if (!/[a-z]/.test(pw)) hints.push('One lowercase letter');
  if (!/\d/.test(pw)) hints.push('One digit');
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw)) hints.push('One special character');
  const score = 5 - hints.length;
  const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
  const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#10b981'];
  return { score, label: pw ? labels[score] : '', color: pw ? colors[score] : 'transparent', hints };
}

// ── Change Password Modal ──────────────────────────────────────────────────────
function ChangePasswordModal({ onClose }: { onClose(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const str = pwStrength(next);

  const inp: React.CSSProperties = {
    background: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 4,
    color: 'var(--text-primary)', padding: '7px 10px', fontSize: 13, width: '100%',
  };
  const lbl: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 11, display: 'block', marginBottom: 4 };

  const handleSubmit = async () => {
    if (!current || !next || !confirm) { setMsg({ type: 'err', text: 'All fields are required.' }); return; }
    if (next !== confirm) { setMsg({ type: 'err', text: 'New passwords do not match.' }); return; }
    if (str.score < 3) { setMsg({ type: 'err', text: 'Password does not meet requirements: ' + str.hints.join(', ') }); return; }
    setLoading(true); setMsg(null);
    try {
      await apiClient.put('/auth/change-password', { currentPassword: current, newPassword: next });
      setMsg({ type: 'ok', text: '✓ Password changed successfully.' });
      setTimeout(onClose, 1500);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      setMsg({ type: 'err', text: err?.response?.data?.message ?? 'Failed. Check current password.' });
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 28, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: 'var(--text-primary)' }}>Change Password</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
          <div><label style={lbl}>Current Password</label><input type="password" style={inp} value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
          <div>
            <label style={lbl}>New Password</label>
            <input type="password" style={inp} value={next} onChange={(e) => setNext(e.target.value)} />
            {next && (
              <div style={{ marginTop: 5 }}>
                <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                  {[1,2,3,4,5].map((i) => <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= str.score ? str.color : 'var(--bg-elevated)' }} />)}
                </div>
                <div style={{ color: str.color, fontSize: 11 }}>{str.label}</div>
                {str.hints.length > 0 && <div style={{ color: '#f87171', fontSize: 11, marginTop: 2 }}>Needs: {str.hints.join(' · ')}</div>}
              </div>
            )}
          </div>
          <div><label style={lbl}>Confirm New Password</label><input type="password" style={inp} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        </div>
        {msg && <div style={{ background: msg.type === 'ok' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${msg.type === 'ok' ? '#86efac' : '#fca5a5'}`, borderRadius: 6, padding: '7px 12px', marginBottom: 14, color: msg.type === 'ok' ? '#15803d' : '#dc2626', fontSize: 12 }}>{msg.text}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={handleSubmit} disabled={loading} style={{ background: '#1967D2', border: 'none', color: '#fff', padding: '7px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Saving…' : 'Change Password'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
function SvgIcon({ children, size = 20 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
      {children}
    </svg>
  );
}

const NAV_ICONS: Record<string, React.ReactElement> = {
  dashboard:     <SvgIcon><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></SvgIcon>,
  dashboards:    <SvgIcon><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></SvgIcon>,
  devices:       <SvgIcon><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></SvgIcon>,
  discovery:     <SvgIcon><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></SvgIcon>,
  alarms:        <SvgIcon><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></SvgIcon>,
  notifications: <SvgIcon><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></SvgIcon>,
  topology:      <SvgIcon><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12 5 17M12 12l7 5"/></SvgIcon>,
  kpi:           <SvgIcon><path d="M3 20l4-8 4 4 4-6 4 4"/><path d="M3 4v16h18"/></SvgIcon>,
  config:        <SvgIcon><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M12 2v2M4.93 4.93l1.41 1.41M2 12h2M4.93 19.07l1.41-1.41M12 20v2M19.07 19.07l-1.41-1.41M20 12h2"/></SvgIcon>,
  troubleshoot:  <SvgIcon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></SvgIcon>,
  reports:       <SvgIcon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></SvgIcon>,
  admin:         <SvgIcon><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></SvgIcon>,
  users:         <SvgIcon><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></SvgIcon>,
  monitor:       <SvgIcon size={16}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></SvgIcon>,
  search:        <SvgIcon size={17}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></SvgIcon>,
  bell:          <SvgIcon size={17}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></SvgIcon>,
  help:          <SvgIcon size={17}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></SvgIcon>,
  sun:           <SvgIcon size={17}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></SvgIcon>,
  moon:          <SvgIcon size={17}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></SvgIcon>,
};

// ── Senao Logo ─────────────────────────────────────────────────────────────────
// Blue "a" swoosh logo – Senao brand mark (same shape as classic telecom "a", recoloured blue)
function SenaoLogo() {
  return (
    <svg viewBox="0 0 100 110" width={38} height={42} style={{ display: 'block' }}>
      {/* Outer oval body of the "a" swoosh */}
      <path
        fillRule="evenodd"
        fill="#1877F2"
        d={[
          /* outer boundary */
          'M 60 5 C 78 2 96 16 96 36 C 96 56 80 70 60 72',
          'C 40 74 22 60 22 42 C 22 32 26 24 34 18',
          'C 42 12 52 8 60 5 Z',
          /* inner oval hole – evenodd punches it out */
          'M 60 22 C 72 20 80 30 78 42 C 76 54 64 62 52 58',
          'C 40 54 34 44 38 32 C 42 20 52 18 60 22 Z',
        ].join(' ')}
      />
      {/* Tail extending down-left, matching the Airtel-style "a" */}
      <path
        fill="#1877F2"
        d="M 24 62 C 18 74 10 86 8 88 C 14 92 22 86 24 78 L 32 62 Z"
      />
    </svg>
  );
}

// ── Nav item definition ────────────────────────────────────────────────────────
interface NavItem {
  path: string;
  label: string;
  iconKey: string;
  allowedRoles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard',     label: 'Dashboard',     iconKey: 'dashboard',     allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/dashboards',    label: 'My Dashboards', iconKey: 'dashboards',    allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/devices',       label: 'Inventory',     iconKey: 'devices',       allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/discovery',     label: 'Discovery',     iconKey: 'discovery',     allowedRoles: ['Admin','Operator','admin','operator'] },
  { path: '/topology',      label: 'Topology',      iconKey: 'topology',      allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/alarms',        label: 'Alarms',        iconKey: 'alarms',        allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/notifications', label: 'Notifications', iconKey: 'notifications', allowedRoles: ['Admin','admin'] },
  { path: '/kpi',           label: 'KPI',           iconKey: 'kpi',           allowedRoles: ['Admin','Operator','User','admin','operator','user'] },
  { path: '/config',        label: 'Config',        iconKey: 'config',        allowedRoles: ['Admin','Operator','admin','operator'] },
  { path: '/troubleshoot',  label: 'Troubleshoot',  iconKey: 'troubleshoot',  allowedRoles: ['Admin','Operator','admin','operator'] },
  { path: '/reports',       label: 'Reports',       iconKey: 'reports',       allowedRoles: ['Admin','Operator','admin','operator'] },
];

const BOTTOM_NAV: NavItem[] = [
  { path: '/admin', label: 'Admin', iconKey: 'admin', allowedRoles: ['Admin','admin'] },
];

// page title shown in the center of the header
const PAGE_TITLES: Record<string, string> = {
  '/dashboard':     'Dashboard',
  '/dashboards':    'My Dashboards',
  '/devices':       'Inventory',
  '/discovery':     'Discovery',
  '/topology':      'Topology',
  '/alarms':        'Alarms',
  '/notifications': 'Notifications',
  '/kpi':           'KPI',
  '/config':        'Configuration',
  '/troubleshoot':  'Troubleshoot',
  '/reports':       'Reports',
  '/admin':         'Admin',
};

// ── Tooltip wrapper ────────────────────────────────────────────────────────────
function NavTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div style={{
          position: 'absolute', left: SIDEBAR_W - 2, top: '50%', transform: 'translateY(-50%)',
          background: '#1b3270', color: '#fff', padding: '4px 10px', borderRadius: 4,
          fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', zIndex: 200,
          pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ── Header icon button ─────────────────────────────────────────────────────────
function HdrBtn({ icon, title, onClick, badge }: { icon: React.ReactElement; title: string; onClick?: () => void; badge?: number }) {
  return (
    <button title={title} onClick={onClick}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '6px', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', transition: 'color 0.15s' }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}>
      {icon}
      {badge != null && badge > 0 && (
        <span style={{ position: 'absolute', top: 2, right: 2, background: '#dc2626', color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 8, padding: '0 4px', minWidth: 14, textAlign: 'center', lineHeight: '14px' }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// ── Main AppShell ──────────────────────────────────────────────────────────────
export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [showChangePw, setShowChangePw] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const userRole = user?.role ?? '';
  const visibleItems = NAV_ITEMS.filter((item) => !user || item.allowedRoles.includes(userRole as Role));
  const visibleBottom = BOTTOM_NAV.filter((item) => !user || item.allowedRoles.includes(userRole as Role));

  const pageTitle = Object.entries(PAGE_TITLES).find(
    ([path]) => location.pathname === path || location.pathname.startsWith(path + '/')
  )?.[1] ?? 'Network Operations Center';

  const userInitial = (user?.fullName || user?.email || 'U')[0].toUpperCase();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  // Close user menu on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const sidebarBg = isDark ? '#070f1e' : '#1b3270';
  const activeColor = isDark ? 'rgba(66,133,244,0.18)' : 'rgba(255,255,255,0.12)';

  const navItemStyle = (isActive: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: SIDEBAR_W, height: 48,
    color: isActive ? '#fff' : 'rgba(255,255,255,0.50)',
    background: isActive ? activeColor : 'transparent',
    borderLeft: isActive ? '3px solid #4285f4' : '3px solid transparent',
    textDecoration: 'none',
    transition: 'background 0.12s, color 0.12s',
    cursor: 'pointer',
  });

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-base)' }}>

      {/* ── Narrow icon sidebar ── */}
      <nav aria-label="Main navigation" style={{
        position: 'fixed', left: 0, top: 0, bottom: 0, width: SIDEBAR_W,
        background: sidebarBg, display: 'flex', flexDirection: 'column',
        alignItems: 'center', zIndex: 100,
        boxShadow: '2px 0 6px rgba(0,0,0,0.20)',
        overflowY: 'auto', overflowX: 'hidden',
      }}>
        {/* Logo */}
        <div style={{ padding: '14px 0 10px', marginBottom: 4, flexShrink: 0 }}>
          <SenaoLogo />
        </div>

        {/* Primary nav icons */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', paddingTop: 4 }}>
          {visibleItems.map((item) => (
            <NavTooltip key={item.path} label={item.label}>
              <NavLink to={item.path} style={({ isActive }) => navItemStyle(isActive)}>
                {NAV_ICONS[item.iconKey]}
              </NavLink>
            </NavTooltip>
          ))}
        </div>

        {/* Bottom: users / admin */}
        <div style={{ width: '100%', paddingBottom: 10, flexShrink: 0 }}>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.10)', margin: '6px 10px 8px' }} />
          <NavTooltip label="Users / Admin">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: SIDEBAR_W, height: 44, color: 'rgba(255,255,255,0.50)', cursor: 'pointer' }}
              onClick={() => navigate('/admin')}>
              {NAV_ICONS.users}
            </div>
          </NavTooltip>
          {visibleBottom.map((item) => (
            <NavTooltip key={item.path} label={item.label}>
              <NavLink to={item.path} style={({ isActive }) => navItemStyle(isActive)}>
                {NAV_ICONS[item.iconKey]}
              </NavLink>
            </NavTooltip>
          ))}
        </div>
      </nav>

      {/* ── Top header ── */}
      <header role="banner" style={{
        position: 'fixed', left: SIDEBAR_W, top: 0, right: 0, height: HEADER_H,
        background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center',
        padding: '0 20px 0 24px', zIndex: 99,
        boxShadow: 'var(--header-shadow)',
      }}>
        {/* Breadcrumb / page title (centered) */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
            {NAV_ICONS.monitor}
          </span>
          <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{pageTitle}</span>
        </div>

        {/* Right action icons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <HdrBtn icon={NAV_ICONS.search} title="Search" />
          <HdrBtn icon={isDark ? NAV_ICONS.sun : NAV_ICONS.moon} title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'} onClick={toggleTheme} />
          <HdrBtn icon={NAV_ICONS.help} title="Help" />
          <HdrBtn icon={NAV_ICONS.bell} title="Notifications" onClick={() => navigate('/alarms')} />

          {/* User avatar + dropdown */}
          <div ref={userMenuRef} style={{ position: 'relative', marginLeft: 6 }}>
            <button
              title={`${user?.fullName || user?.email || 'User'} (${userRole})`}
              onClick={() => setShowUserMenu((v) => !v)}
              style={{
                width: 30, height: 30, borderRadius: '50%',
                background: '#1967D2', border: 'none', color: '#fff',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              {userInitial}
            </button>

            {showUserMenu && (
              <div style={{
                position: 'absolute', top: 38, right: 0, background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)', borderRadius: 8,
                boxShadow: '0 6px 20px rgba(0,0,0,0.12)', zIndex: 300,
                minWidth: 200, overflow: 'hidden',
              }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                    {user?.fullName || user?.email || 'User'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {userRole}
                  </div>
                </div>
                {[
                  { label: '🔒 Change Password', action: () => { setShowChangePw(true); setShowUserMenu(false); } },
                  { label: '⎋ Sign Out', action: handleLogout },
                ].map(({ label, action }) => (
                  <button key={label} onClick={action}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'none', border: 'none', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Main content area ── */}
      <main id="main-content" role="main" style={{
        marginLeft: SIDEBAR_W,
        marginTop: HEADER_H,
        flex: 1,
        overflow: 'auto',
        padding: 24,
        minHeight: `calc(100vh - ${HEADER_H}px)`,
        background: 'var(--bg-base)',
      }}>
        {children}
      </main>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  );
}

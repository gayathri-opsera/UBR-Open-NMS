import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import type { Role } from '../../../auth/tokens';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  allowedRoles?: Role[];
  badge?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Grouped navigation — mirrors the Opsera reference sidebar structure
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { path: '/v2/dashboard',  label: 'Dashboard',     icon: <GridIcon /> },
      { path: '/v2/dashboards', label: 'My Dashboards', icon: <DashIcon /> },
    ],
  },
  {
    label: 'Network',
    items: [
      { path: '/v2/devices',    label: 'Inventory',  icon: <ServerIcon /> },
      { path: '/v2/alarms',     label: 'Alarms',     icon: <BellIcon /> },
      { path: '/v2/topology',   label: 'Topology',   icon: <TopologyIcon /> },
      { path: '/v2/kpi',        label: 'KPI',        icon: <ChartIcon /> },
      { path: '/v2/groups',     label: 'Device Groups', icon: <GroupIcon /> },
    ],
  },
  {
    label: 'Operations',
    items: [
      { path: '/v2/config',       label: 'Config',       icon: <CogIcon />,    allowedRoles: ['Admin', 'Operator'] as Role[] },
      { path: '/v2/troubleshoot', label: 'Troubleshoot', icon: <WrenchIcon />, allowedRoles: ['Admin', 'Operator'] as Role[] },
      { path: '/v2/reports',      label: 'Reports',      icon: <ReportIcon /> },
    ],
  },
  {
    label: 'Admin',
    items: [
      { path: '/v2/hierarchy',    label: 'Org / Hierarchy', icon: <OrgIcon />,   allowedRoles: ['Admin', 'Operator'] as Role[] },
      { path: '/v2/notifications',label: 'Notifications',   icon: <NotifIcon />, allowedRoles: ['Admin'] as Role[] },
      { path: '/v2/admin',        label: 'Admin',            icon: <AdminIcon />, allowedRoles: ['Admin'] as Role[] },
    ],
  },
];

function normalizeRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function canAccess(item: NavItem, role: string | undefined): boolean {
  if (!item.allowedRoles || !role) return !item.allowedRoles;
  const normalized = normalizeRole(role);
  return item.allowedRoles.some((r) => r === normalized || r === role);
}

export interface V2SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function V2Sidebar({ collapsed, onToggle }: V2SidebarProps) {
  const { user } = useAuth();
  const location = useLocation();

  return (
    <nav
      aria-label="Primary navigation"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* Logo + collapse toggle */}
      <div
        style={{
          height: 58,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          padding: collapsed ? '0 12px' : '0 14px 0 18px',
          borderBottom: '1px solid var(--vf-nav-border, rgba(255,255,255,0.08))',
          flexShrink: 0,
        }}
      >
        {!collapsed && (
          <span style={{
            fontSize: 15,
            fontWeight: 800,
            background: 'linear-gradient(90deg, #6366f1 0%, #a855f7 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>
            UBR NMS
          </span>
        )}
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="vf-sidebar-nav"
          style={{
            background: 'transparent', border: 'none',
            color: 'var(--vf-nav-text)', cursor: 'pointer',
            padding: 6, borderRadius: 'var(--vf-radius-sm)',
            display: 'flex', alignItems: 'center',
            transition: 'color var(--vf-transition-fast)',
          }}
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>

      {/* Grouped nav items */}
      <ul
        id="vf-sidebar-nav"
        role="list"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', listStyle: 'none', margin: 0, padding: '8px 0 8px' }}
      >
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) => canAccess(item, user?.role));
          if (visibleItems.length === 0) return null;
          return (
            <li key={group.label}>
              {/* Section label — only when expanded */}
              {!collapsed && (
                <div style={{
                  padding: '14px 18px 3px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--vf-nav-group-label)',
                  userSelect: 'none',
                }}>
                  {group.label}
                </div>
              )}
              {collapsed && <div style={{ height: 6 }} />}
              <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {visibleItems.map((item) => {
                  const isActive = location.pathname.startsWith(item.path);
                  return (
                    <li key={item.path} role="listitem">
                      <NavLink
                        to={item.path}
                        aria-current={isActive ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: collapsed ? '10px 0' : '8px 12px 8px 14px',
                          justifyContent: collapsed ? 'center' : 'flex-start',
                          textDecoration: 'none',
                          color: isActive ? 'var(--vf-nav-text-active)' : 'var(--vf-nav-text)',
                          background: isActive ? 'var(--vf-shell-active-bg)' : 'transparent',
                          borderLeft: `3px solid ${isActive ? 'var(--vf-shell-active-indicator)' : 'transparent'}`,
                          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                          whiteSpace: 'nowrap', overflow: 'hidden',
                          fontSize: 13.5, fontWeight: isActive ? 600 : 400,
                          borderRadius: collapsed ? 0 : '0 6px 6px 0',
                          margin: collapsed ? '1px 0' : '1px 10px 1px 0',
                        }}
                      >
                        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: isActive ? 'var(--vf-nav-icon-active)' : 'var(--vf-nav-icon)' }}>
                          {item.icon}
                        </span>
                        {!collapsed && (
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                            {item.label}
                          </span>
                        )}
                        {!collapsed && item.badge != null && item.badge > 0 && (
                          <span style={{ background: 'var(--vf-danger)', color: '#fff', borderRadius: '999px', fontSize: 10, fontWeight: 700, padding: '1px 5px', minWidth: 16, textAlign: 'center', lineHeight: 1.5 }}>
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      {/* User row */}
      {user && (
        <div
          style={{
            padding: collapsed ? '10px 0' : '10px 14px',
            borderTop: '1px solid var(--vf-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #3b82f6 0%, #6d28d9 100%)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
              boxShadow: '0 2px 8px rgba(59,130,246,0.4)',
            }}
          >
            {user.username.charAt(0).toUpperCase()}
          </div>
          {!collapsed && (
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.username}
              </div>
              <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', textTransform: 'capitalize' }}>
                {String(user.role).toLowerCase()}
              </div>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

// ── Inline SVG icons (16×16, currentColor) ────────────────────────────────────

function GridIcon()     { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4"/></svg>; }
function DashIcon()     { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="1" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="1" width="6" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="7" width="6" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="12" width="6" height="3" rx="1.5" stroke="currentColor" strokeWidth="1.4"/></svg>; }
function ServerIcon()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="2" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="9" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><circle cx="12.5" cy="4.5" r="1" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1" fill="currentColor"/></svg>; }
function BellIcon()     { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5a5 5 0 015 5v3l1 1.5H2L3 9.5v-3a5 5 0 015-5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function TopologyIcon() { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.4"/><circle cx="3" cy="13" r="2" stroke="currentColor" strokeWidth="1.4"/><circle cx="13" cy="13" r="2" stroke="currentColor" strokeWidth="1.4"/><path d="M8 5L3 11M8 5l5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function ChartIcon()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 12L5.5 7.5L8.5 9.5L12 5L14 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 14h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function CogIcon()      { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1 1M11.9 11.9l1 1M3.1 12.9l1-1M11.9 4.1l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function WrenchIcon()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2a3 3 0 013 3c0 1.2-.7 2.2-1.7 2.7L4.5 15.5a1 1 0 01-1.4 0l-.6-.6a1 1 0 010-1.4L10.3 5.7A3 3 0 0111 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>; }
function ReportIcon()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="1" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function NotifIcon()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8a6 6 0 1112 0v3l1.5 2H.5L2 11V8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function AdminIcon()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 14c0-2.76 2.46-5 5.5-5s5.5 2.24 5.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function OrgIcon()      { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="1" width="6" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="11" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="6" y="11" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="11" y="11" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/><path d="M3 11V9h10v2M8 5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function GroupIcon()    { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="2" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="2" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="1" y="9" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/><rect x="9" y="9" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/></svg>; }

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return collapsed
    ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

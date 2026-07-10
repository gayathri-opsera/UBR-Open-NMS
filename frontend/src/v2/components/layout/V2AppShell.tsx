import React, { createContext, useContext, useState } from 'react';
import { V2Sidebar } from './V2Sidebar';
import { V2Header } from './V2Header';
import { useTheme } from '../../../contexts/ThemeContext';

interface ShellContextValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}
const ShellCtx = createContext<ShellContextValue>({ sidebarCollapsed: false, toggleSidebar: () => {} });
export const useShell = () => useContext(ShellCtx);

const SIDEBAR_FULL = 220;
const SIDEBAR_MINI = 56;
const HEADER_H     = 52;

export function V2AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('vf_sidebar_collapsed') === '1'; } catch { return false; }
  });
  const { theme } = useTheme();
  // Keep html attribute in sync with context theme
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('vf_sidebar_collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const sidebarW = collapsed ? SIDEBAR_MINI : SIDEBAR_FULL;

  return (
    <ShellCtx.Provider value={{ sidebarCollapsed: collapsed, toggleSidebar }}>
      <div
        className="vf-root"
        style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--vf-canvas)' }}
      >
        {/* Sidebar */}
        <aside
          aria-label="Navigation"
          style={{
            width: sidebarW,
            flexShrink: 0,
            height: '100vh',
            background: 'var(--vf-sidebar-bg)',
            borderRight: '1px solid var(--vf-nav-border, var(--vf-border-subtle))',
            transition: `width var(--vf-transition-normal)`,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 100,
          }}
        >
          <V2Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        </aside>

        {/* Main area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Header */}
          <header
            style={{
              height: HEADER_H,
              flexShrink: 0,
              background: 'var(--vf-surface)',
              borderBottom: '1px solid var(--vf-border-subtle)',
              boxShadow: 'var(--vf-shadow-low)',
              zIndex: 99,
            }}
          >
            <V2Header />
          </header>

          {/* Content */}
          <main
            id="vf-main-content"
            tabIndex={-1}
            style={{
              flex: 1,
              overflowY: 'auto',
              background: 'var(--vf-canvas)',
              outline: 'none',
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </ShellCtx.Provider>
  );
}

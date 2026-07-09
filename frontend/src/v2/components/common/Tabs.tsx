import React, { createContext, useContext, useId } from 'react';

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
  baseId: string;
}
const TabsCtx = createContext<TabsContextValue | null>(null);

export interface Tab {
  id: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  children: React.ReactNode;
  variant?: 'underline' | 'pill';
  style?: React.CSSProperties;
}

export function Tabs({ tabs, activeTab, onChange, children, variant = 'underline', style }: TabsProps) {
  const baseId = useId();

  return (
    <TabsCtx.Provider value={{ activeTab, setActiveTab: onChange, baseId }}>
      <div style={style}>
        {/* Tab list */}
        <div
          role="tablist"
          aria-label="Tabs"
          style={{
            display: 'flex',
            gap: variant === 'pill' ? 4 : 0,
            borderBottom: variant === 'underline' ? '1px solid var(--vf-border-subtle)' : undefined,
            padding: variant === 'pill' ? '4px' : undefined,
            background: variant === 'pill' ? 'var(--vf-elevated)' : undefined,
            borderRadius: variant === 'pill' ? 'var(--vf-radius-md)' : undefined,
          }}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                role="tab"
                id={`${baseId}-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`${baseId}-panel-${tab.id}`}
                disabled={tab.disabled}
                onClick={() => !tab.disabled && onChange(tab.id)}
                tabIndex={isActive ? 0 : -1}
                style={{
                  padding: variant === 'underline' ? '8px 14px' : '6px 14px',
                  fontSize: 'var(--vf-type-body-size)',
                  fontWeight: 600,
                  fontFamily: 'var(--vf-font-sans)',
                  background: variant === 'pill' && isActive ? 'var(--vf-surface)' : 'transparent',
                  color: isActive ? 'var(--vf-text-primary)' : 'var(--vf-text-muted)',
                  border: variant === 'pill' ? 'none' : 'none',
                  borderBottom: variant === 'underline' ? `2px solid ${isActive ? 'var(--vf-accent)' : 'transparent'}` : 'none',
                  borderRadius: variant === 'pill' ? 'var(--vf-radius-sm)' : 0,
                  cursor: tab.disabled ? 'not-allowed' : 'pointer',
                  opacity: tab.disabled ? 0.45 : 1,
                  transition: `color var(--vf-transition-fast), border-color var(--vf-transition-fast), background var(--vf-transition-fast)`,
                  whiteSpace: 'nowrap',
                  boxShadow: variant === 'pill' && isActive ? 'var(--vf-shadow-low)' : undefined,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        {/* Panels */}
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function TabPanel({ id, children }: { id: string; children: React.ReactNode }) {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error('TabPanel must be inside Tabs');
  const isActive = ctx.activeTab === id;

  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${id}`}
      aria-labelledby={`${ctx.baseId}-tab-${id}`}
      hidden={!isActive}
      tabIndex={isActive ? 0 : undefined}
    >
      {isActive ? children : null}
    </div>
  );
}

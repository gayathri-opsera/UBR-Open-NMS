import React, { createContext, useCallback, useContext, useState } from 'react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastCtx = createContext<ToastContextValue>({ toasts: [], addToast: () => {}, removeToast: () => {} });
export const useToast = () => useContext(ToastCtx);

const variantStyle: Record<ToastVariant, { bg: string; color: string; icon: string }> = {
  success: { bg: 'var(--vf-success-subtle)', color: 'var(--vf-success)', icon: '✓' },
  error:   { bg: 'var(--vf-danger-subtle)',  color: 'var(--vf-danger)',  icon: '✕' },
  warning: { bg: 'var(--vf-warning-subtle)', color: 'var(--vf-warning)', icon: '⚠' },
  info:    { bg: 'var(--vf-info-subtle)',    color: 'var(--vf-info)',    icon: 'ℹ' },
};

let _counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const addToast = useCallback((message: string, variant: ToastVariant = 'info', duration = 4000) => {
    const id = `toast-${++_counter}`;
    setToasts((t) => [...t, { id, message, variant, duration }]);
    if (duration > 0) setTimeout(() => removeToast(id), duration);
  }, [removeToast]);

  return (
    <ToastCtx.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 3000,
          maxWidth: 380,
        }}
      >
        {toasts.map((t) => {
          const s = variantStyle[t.variant];
          return (
            <div
              key={t.id}
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: 'var(--vf-elevated)',
                border: `1px solid ${s.color}`,
                borderLeft: `4px solid ${s.color}`,
                borderRadius: 'var(--vf-radius-md)',
                padding: '10px 14px',
                boxShadow: 'var(--vf-shadow-medium)',
                animation: 'vf-slide-in-right 200ms ease',
                fontFamily: 'var(--vf-font-sans)',
              }}
            >
              <span style={{ color: s.color, fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{s.icon}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--vf-text-primary)', lineHeight: 1.4 }}>{t.message}</span>
              <button
                onClick={() => removeToast(t.id)}
                aria-label="Dismiss"
                style={{ background: 'none', border: 'none', color: 'var(--vf-text-muted)', cursor: 'pointer', padding: 2, flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

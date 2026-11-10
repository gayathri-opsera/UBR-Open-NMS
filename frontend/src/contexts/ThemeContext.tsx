import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/** User-chosen preference — 'system' means follow OS */
type ThemeMode = 'light' | 'dark' | 'system';

/** Resolved theme actually applied to the document */
type Theme = 'light' | 'dark';

interface ThemeContextValue {
  /** The user's stored preference (light / dark / system) */
  mode: ThemeMode;
  /** The resolved theme currently applied (light / dark) */
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
  /** Convenience — true when resolved theme is dark */
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  theme: 'light',
  setMode: () => {},
  isDark: false,
});

function getSystemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === 'system') return getSystemTheme();
  return mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('nms_theme_mode') as ThemeMode | null;
      // Migrate legacy 'dark'/'light' string stored under old key
      const legacy = localStorage.getItem('nms_theme') as Theme | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
      if (legacy === 'dark') return 'dark';
      // Default: light
      return 'light';
    } catch {
      return 'light';
    }
  });

  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => resolveTheme(mode));

  // Apply resolved theme to <html> element
  useEffect(() => {
    const resolved = resolveTheme(mode);
    setResolvedTheme(resolved);
    document.documentElement.setAttribute('data-theme', resolved);
    try {
      localStorage.setItem('nms_theme_mode', mode);
    } catch { /* ignore */ }
  }, [mode]);

  // Listen for OS theme changes when mode is 'system'
  useEffect(() => {
    if (mode !== 'system') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const resolved: Theme = e.matches ? 'dark' : 'light';
      setResolvedTheme(resolved);
      document.documentElement.setAttribute('data-theme', resolved);
    };

    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, theme: resolvedTheme, setMode, isDark: resolvedTheme === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

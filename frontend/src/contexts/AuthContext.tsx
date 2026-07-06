import React, { createContext, useCallback, useContext, useState } from 'react';
import type { UserInfo } from '../auth/tokens';
import { clearTokens, setTokens } from '../auth/tokens';
import { login as apiLogin, logout as apiLogout } from '../api/auth.api';

interface AuthContextValue {
  user: UserInfo | null;
  isAuthenticated: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<UserInfo | null>(null);

  const login = useCallback(async (username: string, password: string) => {
    const { tokens, user } = await apiLogin(username, password);
    setTokens(tokens);
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearTokens();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: user !== null, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

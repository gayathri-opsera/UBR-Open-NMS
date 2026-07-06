import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { UserInfo } from '../auth/tokens';
import { clearTokens, getStoredUser, isTokenExpired, setTokens, setStoredUser } from '../auth/tokens';
import { login as apiLogin, logout as apiLogout } from '../api/auth.api';

interface AuthContextValue {
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Rehydrate auth state from localStorage on startup
  useEffect(() => {
    const storedUser = getStoredUser();
    if (storedUser && !isTokenExpired()) {
      setUser(storedUser);
    } else if (isTokenExpired()) {
      // Token expired — clear stale data
      clearTokens();
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { tokens, user: loggedInUser } = await apiLogin(username, password);
    setTokens(tokens);
    setStoredUser(loggedInUser);
    setUser(loggedInUser);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearTokens();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: user !== null, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { UserInfo } from '../auth/tokens';
import { clearTokens, getStoredUser, isTokenExpired, setTokens, setStoredUser } from '../auth/tokens';
import { login as apiLogin, logout as apiLogout, submitMfaChallenge } from '../api/auth.api';

// ── MFA challenge state ───────────────────────────────────────────────────────

export interface MfaChallengeState {
  mfaToken: string;
  mfaTokenExpiresIn: number;
  username: string;
}

// ── Context shape ─────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: UserInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Pending MFA challenge — non-null means the login UI must show OTP input */
  mfaChallenge: MfaChallengeState | null;
  /** Step 1: username + password */
  login(username: string, password: string): Promise<void>;
  /** Step 2: OTP code (only valid when mfaChallenge !== null) */
  completeMfaChallenge(code: string): Promise<void>;
  /** Cancel the MFA step and go back to username/password */
  cancelMfaChallenge(): void;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeState | null>(null);

  // Rehydrate auth state from localStorage on startup
  useEffect(() => {
    const storedUser = getStoredUser();
    if (storedUser && !isTokenExpired()) {
      setUser(storedUser);
    } else if (isTokenExpired()) {
      clearTokens();
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password);
    if (result.mfaRequired) {
      // Store the challenge — LoginPage will switch to OTP screen
      setMfaChallenge({
        mfaToken: result.mfaToken,
        mfaTokenExpiresIn: result.mfaTokenExpiresIn,
        username,
      });
    } else {
      setTokens(result.tokens);
      setStoredUser(result.user);
      setUser(result.user);
    }
  }, []);

  const completeMfaChallenge = useCallback(async (code: string) => {
    if (!mfaChallenge) throw new Error('No active MFA challenge');
    const { tokens, user: loggedInUser } = await submitMfaChallenge(
      mfaChallenge.mfaToken,
      code,
      mfaChallenge.username,
    );
    setMfaChallenge(null);
    setTokens(tokens);
    setStoredUser(loggedInUser);
    setUser(loggedInUser);
  }, [mfaChallenge]);

  const cancelMfaChallenge = useCallback(() => {
    setMfaChallenge(null);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearTokens();
    setUser(null);
    setMfaChallenge(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: user !== null,
      isLoading,
      mfaChallenge,
      login,
      completeMfaChallenge,
      cancelMfaChallenge,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export type Role = 'Admin' | 'Operator' | 'User' | 'admin' | 'operator' | 'user';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix timestamp ms
}

export interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: Role;
  fullName: string;
}

export interface AuthState {
  tokens: AuthTokens | null;
  user: UserInfo | null;
  isAuthenticated: boolean;
}

const TOKENS_KEY = 'nms_tokens';
const USER_KEY   = 'nms_user';

// ── Token persistence ─────────────────────────────────────────────────────────

export function setTokens(tokens: AuthTokens): void {
  try { localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens)); } catch { /* quota exceeded */ }
}

export function clearTokens(): void {
  try {
    localStorage.removeItem(TOKENS_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
}

export function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as AuthTokens).accessToken ?? null;
  } catch { return null; }
}

export function getRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as AuthTokens).refreshToken ?? null;
  } catch { return null; }
}

export function isTokenExpired(): boolean {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) return true;
    const { expiresAt } = JSON.parse(raw) as AuthTokens;
    return Date.now() >= expiresAt - 30_000; // 30 s buffer
  } catch { return true; }
}

// ── User info persistence ──────────────────────────────────────────────────────

export function setStoredUser(user: UserInfo): void {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* quota */ }
}

export function getStoredUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserInfo) : null;
  } catch { return null; }
}

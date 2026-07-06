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

let _tokens: AuthTokens | null = null;

export function setTokens(tokens: AuthTokens): void {
  _tokens = tokens;
}

export function clearTokens(): void {
  _tokens = null;
}

export function getAccessToken(): string | null {
  if (!_tokens) return null;
  return _tokens.accessToken;
}

export function getRefreshToken(): string | null {
  if (!_tokens) return null;
  return _tokens.refreshToken;
}

export function isTokenExpired(): boolean {
  if (!_tokens) return true;
  return Date.now() >= _tokens.expiresAt - 30_000; // 30s buffer
}

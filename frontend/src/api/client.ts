import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, getRefreshToken, isTokenExpired, setTokens, clearTokens } from '../auth/tokens';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

let _refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token');

  const response = await axios.post<{ status: string; data: { accessToken: string; expiresIn: number; refreshToken: string } }>(
    `${API_BASE}/auth/refresh`,
    { refreshToken },
  );
  const { accessToken, expiresIn, refreshToken: newRefreshToken } = response.data.data;
  setTokens({
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return accessToken;
}

/**
 * Refresh the access token when it has expired (single in-flight refresh shared by all callers).
 * Exported so clients that cannot use apiClient (different base path) stay logged in too.
 */
export async function ensureFreshAccessToken(): Promise<void> {
  // Only attempt refresh if we already have tokens and the access token is expired
  if (getAccessToken() && getRefreshToken() && isTokenExpired()) {
    if (!_refreshPromise) {
      _refreshPromise = refreshAccessToken().finally(() => { _refreshPromise = null; });
    }
    try { await _refreshPromise; } catch { /* refresh failed; proceed without token */ }
  }
}

// Request interceptor: attach Bearer token, refresh if expired
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  await ensureFreshAccessToken();
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor: handle 401 by redirecting to login
apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      clearTokens();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

import { apiClient } from './client';
import type { AuthTokens, UserInfo } from '../auth/tokens';

interface LoginResponseData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  role: string;
  userId: string;
}

interface ApiResponse<T> {
  status: string;
  data: T;
}

export async function login(username: string, password: string): Promise<{ tokens: AuthTokens; user: UserInfo }> {
  const res = await apiClient.post<ApiResponse<LoginResponseData>>('/auth/login', { username, password });
  const { accessToken, refreshToken, expiresIn, role, userId } = res.data.data;
  const user: UserInfo = {
    id: userId,
    username,
    email: '',
    role: (role.charAt(0).toUpperCase() + role.slice(1)) as UserInfo['role'],
    fullName: username,
  };
  return {
    tokens: { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 },
    user,
  };
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post('/auth/logout');
  } catch {
    // best-effort
  }
}

export async function getMe(): Promise<UserInfo> {
  const res = await apiClient.get<UserInfo>('/auth/me');
  return res.data;
}

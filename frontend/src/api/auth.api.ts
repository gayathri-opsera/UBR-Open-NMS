import { apiClient } from './client';
import type { AuthTokens, UserInfo } from '../auth/tokens';
import { getRefreshToken } from '../auth/tokens';

// ── Response shapes ───────────────────────────────────────────────────────────

interface LoginFullResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  role: string;
  userId: string;
}

interface LoginMfaResponse {
  mfaRequired: true;
  mfaToken: string;
  mfaTokenExpiresIn: number;
}

type LoginResponseData = LoginFullResponse | LoginMfaResponse;

interface ApiResponse<T> {
  status: string;
  data: T;
}

// ── Discriminator ─────────────────────────────────────────────────────────────

export function isMfaChallengeResponse(data: LoginResponseData): data is LoginMfaResponse {
  return (data as LoginMfaResponse).mfaRequired === true;
}

// ── Login (step 1) ────────────────────────────────────────────────────────────

export type LoginResult =
  | { mfaRequired: false; tokens: AuthTokens; user: UserInfo }
  | { mfaRequired: true;  mfaToken: string; mfaTokenExpiresIn: number };

export async function login(username: string, password: string): Promise<LoginResult> {
  const res = await apiClient.post<ApiResponse<LoginResponseData>>('/auth/login', { username, password });
  const data = res.data.data;

  if (isMfaChallengeResponse(data)) {
    return {
      mfaRequired: true,
      mfaToken: data.mfaToken,
      mfaTokenExpiresIn: data.mfaTokenExpiresIn,
    };
  }

  const { accessToken, refreshToken, expiresIn, role, userId } = data as LoginFullResponse;
  const user: UserInfo = {
    id: userId,
    username,
    email: '',
    role: (role.charAt(0).toUpperCase() + role.slice(1)) as UserInfo['role'],
    fullName: username,
  };
  return {
    mfaRequired: false,
    tokens: { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 },
    user,
  };
}

// ── MFA challenge (step 2) ────────────────────────────────────────────────────

export async function submitMfaChallenge(
  mfaToken: string,
  code: string,
  username: string,
): Promise<{ tokens: AuthTokens; user: UserInfo }> {
  const res = await apiClient.post<ApiResponse<LoginFullResponse>>('/auth/mfa/challenge', {
    mfaToken,
    code,
  });
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

// ── MFA management ────────────────────────────────────────────────────────────

export interface MfaStatus {
  mfaEnabled: boolean;
  mfaEnabledAt: string | null;
}

export interface MfaSetupResult {
  qrCodeDataUrl: string;
  manualEntryKey: string;
  instructions: string[];
}

export async function getMfaStatus(): Promise<MfaStatus> {
  const res = await apiClient.get<ApiResponse<MfaStatus>>('/auth/mfa/status');
  return res.data.data;
}

export async function setupMfa(): Promise<MfaSetupResult> {
  const res = await apiClient.post<ApiResponse<MfaSetupResult>>('/auth/mfa/setup');
  return res.data.data;
}

export async function verifyMfaSetup(code: string): Promise<void> {
  await apiClient.post('/auth/mfa/verify-setup', { code });
}

export async function disableMfa(code: string): Promise<void> {
  await apiClient.delete('/auth/mfa/disable', { data: { code } });
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  try {
    const refreshToken = getRefreshToken();
    await apiClient.post('/auth/logout', refreshToken ? { refreshToken } : {});
  } catch {
    // best-effort — clear local tokens regardless
  }
}

export async function getMe(): Promise<UserInfo> {
  const res = await apiClient.get<UserInfo>('/auth/me');
  return res.data;
}

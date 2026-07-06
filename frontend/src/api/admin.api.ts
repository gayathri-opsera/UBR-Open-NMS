import { apiClient } from './client';
import type { NmsUser, UserSession, SystemHealth } from './admin.types';

// Auth-service wraps all responses as { status: 'ok', data: T }
// Helper to unwrap safely:
function unwrap<T>(responseData: unknown): T {
  if (responseData && typeof responseData === 'object' && 'data' in (responseData as object)) {
    return (responseData as { data: T }).data;
  }
  return responseData as T;
}

// ── Users — /api/v1/users (proxied by gateway to auth-service) ──────────────
export async function fetchUsers(): Promise<NmsUser[]> {
  const res = await apiClient.get('/users');
  // Auth-service wraps as { status, data: { users: [], total, page, limit } }
  const envelope = unwrap<{ users?: NmsUser[]; items?: NmsUser[] } | NmsUser[]>(res.data);
  let users: NmsUser[];
  if (Array.isArray(envelope)) {
    users = envelope;
  } else if (envelope && 'users' in envelope && Array.isArray(envelope.users)) {
    users = envelope.users;
  } else if (envelope && 'items' in envelope && Array.isArray(envelope.items)) {
    users = envelope.items;
  } else {
    users = [];
  }
  // Normalize _id → id (lean() MongoDB objects use _id)
  return users.map((u) => ({
    ...u,
    id: u.id ?? (u as unknown as { _id: string })._id ?? '',
  }));
}

export async function createUser(user: Partial<NmsUser> & { password: string }): Promise<NmsUser> {
  const body = {
    username: user.username,
    email: user.email,
    password: user.password,
    role: (user.role ?? 'user').toLowerCase(),
    permissions: {},
  };
  const res = await apiClient.post('/users', body);
  return unwrap<NmsUser>(res.data);
}

export async function updateUser(id: string, patch: Partial<NmsUser>): Promise<NmsUser> {
  const body: Record<string, unknown> = {};
  if (patch.role !== undefined) body.role = patch.role.toLowerCase();
  if ((patch as Record<string, unknown>).enabled !== undefined) body.isActive = (patch as Record<string, unknown>).enabled;
  if ((patch as Record<string, unknown>).isActive !== undefined) body.isActive = (patch as Record<string, unknown>).isActive;
  const res = await apiClient.put(`/users/${id}`, body);
  return unwrap<NmsUser>(res.data);
}

export async function deleteUser(id: string): Promise<void> {
  await apiClient.delete(`/users/${id}`);
}

export async function resetPassword(id: string, newPassword: string): Promise<void> {
  await apiClient.put(`/users/${id}/password`, { newPassword });
}

// ── Sessions — GET /api/v1/auth/sessions (admin) ───────────────────────────
export async function fetchSessions(): Promise<UserSession[]> {
  try {
    const res = await apiClient.get('/auth/sessions');
    const sessions = unwrap<UserSession[]>(res.data);
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return []; // graceful fallback if endpoint not yet available
  }
}

export async function terminateSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/auth/sessions/${sessionId}`);
}

// ── System health — GET /api/v1/system/health (health-monitor service) ─────
export async function fetchSystemHealth(): Promise<SystemHealth> {
  const res = await apiClient.get('/system/health');
  return res.data as SystemHealth;
}

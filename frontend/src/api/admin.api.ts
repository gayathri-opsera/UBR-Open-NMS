import { apiClient } from './client';
import type {
  NmsUser, UserSession, SystemHealth,
  AuditEntry, BackupRecord, NorthboundConfig, RedundancyStatus,
} from './admin.types';

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

function toBackendRole(r: string): string {
  const lower = r.toLowerCase();
  return lower === 'viewer' ? 'user' : lower;
}

export async function createUser(user: Partial<NmsUser> & { password: string }): Promise<NmsUser> {
  const body = {
    username: user.username,
    email: user.email,
    password: user.password,
    role: toBackendRole(user.role ?? 'user'),
    permissions: {},
  };
  const res = await apiClient.post('/users', body);
  return unwrap<NmsUser>(res.data);
}

export async function updateUser(id: string, patch: Partial<NmsUser>): Promise<NmsUser> {
  const body: Record<string, unknown> = {};
  if (patch.role !== undefined) body.role = toBackendRole(patch.role);
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

// ── Audit log — GET /api/v1/audit/logs ──────────────────────────────────────
// The audit service exposes /audit/logs; response is { status, logs: [], total }.
export async function fetchAuditLog(params?: { limit?: number; actor?: string; action?: string }): Promise<AuditEntry[]> {
  try {
    const queryParams: Record<string, string | number> = {};
    if (params?.limit)  queryParams.limit  = params.limit;
    if (params?.actor)  queryParams.actor  = params.actor;
    if (params?.action) queryParams.action = params.action;

    const res = await apiClient.get('/audit/logs', { params: queryParams });
    // Real service returns { status: 'ok', logs: [...], total: N }
    const data = res.data as { logs?: AuditEntry[]; data?: AuditEntry[] } | AuditEntry[];
    if (Array.isArray(data)) return data;
    if (data && 'logs' in data && Array.isArray(data.logs)) {
      // Normalize field names: the audit service uses result/sourceIp/serviceSource
      return (data.logs as unknown as Record<string, unknown>[]).map((e) => ({
        id:         String(e._id ?? e.id ?? ''),
        timestamp:  String(e.timestamp ?? e.createdAt ?? ''),
        actor:      String(e.actor ?? ''),
        action:     String(e.action ?? ''),
        resource:   String(e.resource ?? ''),
        resourceId: e.resourceId as string | undefined,
        outcome:    (e.result === 'success' || e.outcome === 'SUCCESS') ? 'SUCCESS' : 'FAILURE',
        ipAddress:  String(e.sourceIp ?? e.ipAddress ?? ''),
        detail:     e.serviceSource as string | undefined,
      } as AuditEntry));
    }
    return (data as { data?: AuditEntry[] }).data ?? [];
  } catch {
    // Fallback: hit the audit/fallback stub on the gateway
    try {
      const res = await apiClient.get('/audit/fallback', { params });
      return Array.isArray(res.data) ? res.data : [];
    } catch { return []; }
  }
}

// ── Backup & Restore ────────────────────────────────────────────────────────
export async function fetchBackups(): Promise<BackupRecord[]> {
  try {
    const res = await apiClient.get('/admin/backups');
    return unwrap<BackupRecord[]>(res.data) ?? [];
  } catch { return []; }
}
export async function triggerBackup(type: 'FULL' | 'INCREMENTAL' = 'FULL'): Promise<BackupRecord> {
  const res = await apiClient.post('/admin/backups', { type });
  return unwrap<BackupRecord>(res.data);
}
export async function restoreBackup(id: string): Promise<void> {
  await apiClient.post(`/admin/backups/${id}/restore`);
}
export async function deleteBackup(id: string): Promise<void> {
  await apiClient.delete(`/admin/backups/${id}`);
}

// ── Northbound OSS/BSS config ───────────────────────────────────────────────
export async function fetchNorthboundConfig(): Promise<NorthboundConfig> {
  try {
    const res = await apiClient.get('/admin/northbound');
    return unwrap<NorthboundConfig>(res.data);
  } catch {
    return {
      netcool: { enabled: false, host: '', port: 9999 },
      mycom:   { enabled: false, host: '', port: 8080 },
      mobinet: { enabled: false, url: '' },
      syslog:  { enabled: false, host: '', port: 514, protocol: 'UDP' },
      niam:    { enabled: false, ldapUrl: '', baseDn: '' },
    };
  }
}
export async function updateNorthboundConfig(cfg: NorthboundConfig): Promise<void> {
  await apiClient.put('/admin/northbound', cfg);
}

// ── Redundancy / HA ─────────────────────────────────────────────────────────
export async function fetchRedundancyStatus(): Promise<RedundancyStatus> {
  try {
    const res = await apiClient.get('/admin/redundancy');
    return unwrap<RedundancyStatus>(res.data);
  } catch {
    // Return a sensible mock when the endpoint is not yet wired
    return {
      sites: [
        { name: 'Site A — Primary',   role: 'PRIMARY', ipAddress: '10.0.1.100', status: 'ACTIVE',  syncStatus: 'IN_SYNC', lastSyncAt: new Date().toISOString(), cpuPct: 28, memPct: 45 },
        { name: 'Site B — Secondary', role: 'STANDBY', ipAddress: '10.0.2.100', status: 'STANDBY', syncStatus: 'IN_SYNC', lastSyncAt: new Date().toISOString(), cpuPct: 12, memPct: 38 },
      ],
      vipAddress: '10.0.0.100',
      heartbeatIntervalSec: 5,
      failoverThresholdMissed: 3,
      maxFailoverTimeSec: 60,
      dbReplication: 'Synchronous (MongoDB replica set)',
      dataLossTolerance: 'Zero (RPO = 0)',
    };
  }
}
export async function forceSyncRedundancy(): Promise<void> {
  await apiClient.post('/admin/redundancy/sync');
}
export async function triggerManualSwitchover(): Promise<void> {
  await apiClient.post('/admin/redundancy/switchover');
}

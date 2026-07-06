import type { NmsUser, UserSession, SystemHealth } from '../api/admin.types';

export const MOCK_USERS: NmsUser[] = [
  { id: 'u1', username: 'admin', email: 'admin@ubrnms.local', role: 'Admin', fullName: 'System Administrator', enabled: true, createdAt: new Date(Date.now() - 86_400_000 * 30).toISOString(), lastLoginAt: new Date(Date.now() - 3_600_000).toISOString() },
  { id: 'u2', username: 'noc1', email: 'noc1@ubrnms.local', role: 'Operator', fullName: 'NOC Operator 1', enabled: true, createdAt: new Date(Date.now() - 86_400_000 * 15).toISOString(), lastLoginAt: new Date(Date.now() - 7_200_000).toISOString() },
  { id: 'u3', username: 'viewer', email: 'viewer@ubrnms.local', role: 'User', fullName: 'Read-Only Viewer', enabled: false, createdAt: new Date(Date.now() - 86_400_000 * 7).toISOString() },
];

export const MOCK_SESSIONS: UserSession[] = [
  { sessionId: 's1', userId: 'u1', username: 'admin', ipAddress: '192.168.1.100', loginAt: new Date(Date.now() - 3_600_000).toISOString(), lastActivityAt: new Date(Date.now() - 60_000).toISOString(), stale: false },
  { sessionId: 's2', userId: 'u2', username: 'noc1', ipAddress: '10.0.0.5', loginAt: new Date(Date.now() - 86_400_000).toISOString(), lastActivityAt: new Date(Date.now() - 7_200_000).toISOString(), stale: true },
];

const SERVICES = ['auth-service', 'api-gateway', 'audit-service', 'discovery-service',
  'inventory-service', 'topology-service', 'alarm-service', 'notification-service',
  'config-service', 'config-push-worker', 'kpi-collector', 'kpi-aggregation-service',
  'kpi-query-service', 'diagnostics-service', 'report-service'];

export const MOCK_SYSTEM_HEALTH: SystemHealth = {
  kafka: 'UP', mongodb: 'UP', redis: 'UP',
  checkedAt: new Date().toISOString(),
  services: SERVICES.map((name, i) => ({
    name, version: '1.0.0',
    status: i === 10 ? 'DEGRADED' : 'UP',
    responseTimeMs: 12 + i * 3,
    uptimeMs: 86_400_000 * 5,
  })),
};

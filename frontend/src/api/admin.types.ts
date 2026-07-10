// Backend roles are lowercase; accept both forms for resilience
export type UserRole = 'Admin' | 'Operator' | 'User' | 'admin' | 'operator' | 'user';

export interface NmsUser {
  id: string;
  _id?: string;        // MongoDB may return _id
  username: string;
  email: string;
  role: UserRole;
  fullName?: string;   // not stored in auth-service — optional
  isActive?: boolean;  // backend field name
  enabled?: boolean;   // frontend convenience alias
  createdAt?: string;
  updatedAt?: string;
  lastLogin?: string;  // backend field name
  lastLoginAt?: string;// frontend convenience alias
  isLdapUser?: boolean;
}

export interface UserSession {
  sessionId: string;
  userId: string;
  username: string;
  ipAddress: string;
  loginAt: string;
  lastActivityAt: string;
  stale: boolean;
}

export type ServiceStatus = 'UP' | 'DOWN' | 'DEGRADED';

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  version?: string;
  uptimeMs?: number;
  responseTimeMs?: number;
}

export interface SystemHealth {
  services: ServiceHealth[];
  kafka: ServiceStatus;
  mongodb: ServiceStatus;
  redis: ServiceStatus;
  checkedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  outcome: 'SUCCESS' | 'FAILURE';
  ipAddress?: string;
  detail?: string;
}

export interface BackupRecord {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  status: 'COMPLETED' | 'RUNNING' | 'FAILED';
  type: 'FULL' | 'INCREMENTAL';
}

export interface NorthboundConfig {
  netcool:  { enabled: boolean; host: string; port: number; username?: string };
  mycom:    { enabled: boolean; host: string; port: number; apiKey?: string };
  mobinet:  { enabled: boolean; url: string; apiKey?: string };
  syslog:   { enabled: boolean; host: string; port: number; protocol: 'UDP' | 'TCP' };
  niam:     { enabled: boolean; ldapUrl: string; baseDn: string; bindDn?: string };
}

export interface RedundancySite {
  name: string;
  role: 'PRIMARY' | 'STANDBY';
  ipAddress: string;
  status: 'ACTIVE' | 'STANDBY' | 'FAILED' | 'UNKNOWN';
  syncStatus: 'IN_SYNC' | 'LAGGING' | 'UNKNOWN';
  lastSyncAt?: string;
  cpuPct?: number;
  memPct?: number;
}

export interface RedundancyStatus {
  sites: RedundancySite[];
  vipAddress: string;
  heartbeatIntervalSec: number;
  failoverThresholdMissed: number;
  maxFailoverTimeSec: number;
  dbReplication: string;
  dataLossTolerance: string;
}

export interface HierarchyOrg {
  id?: string;
  name: string;
  description?: string;
}

export interface HierarchyView {
  id?: string;
  name: string;
  organizationId: string;
  description?: string;
}

export interface HierarchyNetwork {
  id?: string;
  name: string;
  hierarchyId: string;
  organizationId: string;
}

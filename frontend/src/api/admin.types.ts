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

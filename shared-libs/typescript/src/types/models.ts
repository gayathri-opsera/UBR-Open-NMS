export type DeviceType = 'BTS' | 'CPE' | 'IDU';
export type DeviceStatus = 'online' | 'offline' | 'provisioning' | 'decommissioned';
export type AlarmSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE' | 'CLEARED';
export type AlarmState = 'RAISED' | 'ACKNOWLEDGED' | 'CLEARED';
export type UserRole = 'admin' | 'operator' | 'user';
export type AuditOutcome = 'success' | 'failure' | 'denied';
export type KPIGranularity = 'raw' | '15min' | '1hour' | 'daily';
export type ConfigStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'rolled_back';
export type ConfigProtocol = 'NETCONF' | 'CLI' | 'TR-069';

export interface DeviceTag {
  key: string;
  value: string;
}

export interface DeviceEntity {
  deviceId: string;
  serialNumber: string;
  macAddress: string;
  ipAddress?: string;
  deviceType: DeviceType;
  model?: string;
  firmwareVersion?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
  azimuth?: number;
  tilt?: number;
  status: DeviceStatus;
  uptimeSeconds?: number;
  connectedBtsSerial?: string | null;
  connectedCpeCount?: number;
  connectedIduCount?: number;
  tags?: DeviceTag[];
  organizationId?: string;
  networkId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AlarmRecord {
  alarmId: string;
  deviceId: string;
  deviceType?: DeviceType;
  alarmName: string;
  alarmDescription?: string;
  severity: AlarmSeverity;
  state: AlarmState;
  correlationGroup?: string;
  rootCause?: string;
  acknowledged?: boolean;
  acknowledgedBy?: string | null;
  raisedAt: string;
  clearedAt?: string | null;
  ttlExpiry?: string;
}

export interface KPIDataPoint {
  deviceId: string;
  serialNumber?: string;
  deviceType?: DeviceType;
  kpiName: string;
  value: number;
  unit?: string;
  pollInterval?: number;
  timestamp: string;
  granularity?: KPIGranularity;
}

export interface ConfigTemplate {
  templateId: string;
  templateName: string;
  deviceType: DeviceType;
  parameters?: Record<string, unknown>;
  validationSchema?: Record<string, unknown>;
  version?: number;
  createdBy?: string;
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigJob {
  jobId: string;
  templateId: string;
  deviceIds: string[];
  parameters?: Record<string, unknown>;
  status: ConfigStatus;
  protocol?: ConfigProtocol;
  approvedBy?: string | null;
  createdBy: string;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  ttlExpiry?: string;
  createdAt?: string;
}

export interface UserSession {
  sessionId: string;
  userId: string;
  username?: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
  refreshToken?: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt?: string;
}

export interface AuditActor {
  userId: string;
  username: string;
  role: string;
  ipAddress?: string;
}

export interface AuditResource {
  type: string;
  id: string;
}

export interface AuditEntry {
  auditId: string;
  actor: AuditActor;
  action: string;
  resource: AuditResource;
  payload?: Record<string, unknown>;
  outcome: AuditOutcome;
  errorMessage?: string | null;
  timestamp: string;
}

export interface BirthCertificate {
  serialNumber: string;
  macAddress: string;
  model: string;
  deviceType: DeviceType;
  firmware?: string;
  systemName?: string;
  ipAddress?: string;
  publicKey?: string;
  hmacSignature?: string;
  organizationId?: string | null;
  networkId?: string | null;
  registeredAt: string;
}

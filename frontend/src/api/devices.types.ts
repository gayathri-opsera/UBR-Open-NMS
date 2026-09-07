export type DeviceType = 'BTS' | 'CPE' | 'IDU';
export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'PROVISIONING' | 'UNKNOWN';

export interface GpsLocation {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export interface DeviceTag {
  key: string;
  value: string;
}

export interface Device {
  id: string;
  deviceId: string;
  deviceType: DeviceType;
  serialNumber: string;
  macAddress: string;
  ipAddress: string;
  manufacturer: string;
  model: string;
  firmwareVersion: string;
  status: DeviceStatus;
  location?: GpsLocation;
  /** Flat lat/lng fields used by some API responses and the GPS search/export UI */
  latitude?: number;
  longitude?: number;
  networkId?: string;
  organizationId?: string;
  hierarchyId?: string;
  tags?: DeviceTag[];
  pendingCommandCount?: number;
  registeredAt?: string;
  lastSeenAt?: string;
  birthCertificate?: Record<string, string | number | boolean>;

  // ── WO-028 authority and bootstrap fields ─────────────────────────────────
  discoveryParadigm?: string;
  identityAuthority?: string;
  onlineStateAuthority?: string;
  bootstrapState?: string;
  lastCheckInAt?: string;
  lastRealtimeAt?: string;
  capabilityProfileId?: string;
  credentialRef?: string;
  configVersion?: string;

  // ── WO-027 SNMP fingerprint fields ────────────────────────────────────────
  sysObjectID?: string;
  sysDescr?: string;

  // ── WO-026 onboarding state progress fields ───────────────────────────────
  lastSuccessfulBootstrapState?: string;
  onboardingFailureReason?: string;
  retryAfterSeconds?: number;
  retryJitterMaxSeconds?: number;
  assignmentRequired?: boolean;
  commissioningPendingFields?: string;
  realtimeConnectionId?: string;
  realtimeStatusReason?: string;
}

export interface DeviceFilter {
  search?: string;
  deviceType?: DeviceType;
  status?: DeviceStatus;
  firmware?: string;
  organizationId?: string;
  hierarchyId?: string;
  networkId?: string;
  tags?: string[];
  /** Filter by SNMP sysObjectID prefix or exact value (WO-027) */
  sysObjectID?: string;
  /** Maximum number of results to return */
  limit?: number;
}

export interface GpsSearchParams {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

// ── WO-026: Bootstrap onboarding state types ─────────────────────────────────

export type BootstrapStateValue =
  | 'PENDING'
  | 'AUTHENTICATED'
  | 'CHECK_IN_RECEIVED'
  | 'REALTIME_ESTABLISHED'
  | 'ONLINE'
  | 'OFFLINE'
  | 'FAILED'
  | 'UNKNOWN'
  | string; // tolerate unknown future states gracefully — do not crash on new values

export interface DeviceOnboardingState {
  deviceId: string;
  serialNumber: string;
  macAddress: string;
  deviceType: DeviceType;
  bootstrapState: BootstrapStateValue;
  operationalStatus?: string;
  lastSuccessfulState?: string;
  failureReason?: string;
  retryAfterSeconds?: number;
  retryJitterMaxSeconds?: number;
  assignmentRequired?: boolean;
  commissioningPendingFields?: string;
  lastCheckInAt?: string;
  lastRealtimeAt?: string;
  updatedAt?: string;
}

export interface OnboardingStatesResponse {
  items: DeviceOnboardingState[];
  total: number;
  source: string;
}

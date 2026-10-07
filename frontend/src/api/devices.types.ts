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

export interface DeviceInterface {
  index: number;
  name: string;
  type?: number | null;
  speedMbps?: number | null;
  macAddress?: string | null;
  adminStatus?: string | null;
  operStatus?: string | null;
  ipAddresses?: string[];
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
  /** Generic device type from SNMP classification (switch, router, access_point, etc.) */
  genericDeviceType?: string;
  firmwareVersion: string;
  /** Inventory facts collected from the device at discovery (all optional) */
  hardwareVersion?: string;
  bootloaderVersion?: string;
  /** Serial number the device reports about itself (serialNumber is the NMS record key) */
  reportedSerialNumber?: string;
  uptimeSeconds?: number;
  sysContact?: string;
  sysLocation?: string;
  managementInterface?: string;
  factsCollectedAt?: string;
  interfaces?: DeviceInterface[];
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

  // ── WO-010: Framework identity fields (additive, nullable) ─────────────────
  productDefinitionId?: string;
  productDefinitionVersion?: string;
  observedFirmwareVersion?: string;
  activeAdapter?: string;
  frameworkStatus?: string;
  lastFrameworkFailureSummary?: string;
  lastFrameworkSeenAt?: string;
}

export interface DeviceFilter {
  search?: string;
  deviceType?: DeviceType;
  /** Filter by genericDeviceType (switch, router, access_point, etc.) */
  genericDeviceType?: string;
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

// ── WO-038: Onboarding status API types ──────────────────────────────────────

export type OnboardingStateValue =
  | 'MANAGED'
  | 'PENDING_ASSIGNMENT'
  | 'CONFIG_WITHHELD'
  | 'FAILED'
  | 'RETRYING'
  | 'REDIRECTED'
  | 'CHECK_IN_RECEIVED'
  | 'AUTHENTICATED'
  | 'PENDING'
  | 'UNKNOWN'
  | string;

export type ConfigDeliveryState = 'ELIGIBLE' | 'WITHHELD' | 'UNKNOWN' | string;

/**
 * Operator-facing onboarding status for a single device (WO-038).
 * Sensitive fields (credential refs, certificates) are never present.
 */
export interface OnboardingStatusItem {
  deviceId: string;
  serialNumber: string;
  macAddress?: string;
  deviceType?: string;
  discoveryParadigm?: string;
  sysObjectID?: string;
  bootstrapState?: string;
  onboardingState: OnboardingStateValue;
  lastSuccessfulState?: string;
  reasonCategory?: string;
  retryAfterSeconds?: number;
  retryJitterMaxSeconds?: number;
  lastCheckInAt?: string;
  lastRealtimeAt?: string;
  assignmentState?: string;
  configurationDeliveryState?: ConfigDeliveryState;
  updatedAt?: string;
}

export interface OnboardingStatusResponse {
  items: OnboardingStatusItem[];
  page: number;
  limit: number;
  total: number;
  /** "enabled" when any discovery mode is active; "disabled" otherwise. */
  capabilityStatus: 'enabled' | 'disabled' | string;
}

export interface OnboardingStatusFilter {
  page?: number;
  limit?: number;
  state?: OnboardingStateValue;
  paradigm?: string;
  deviceType?: string;
  reasonCategory?: string;
  serialNumber?: string;
  macAddress?: string;
  sysObjectID?: string;
  from?: string;
  to?: string;
}

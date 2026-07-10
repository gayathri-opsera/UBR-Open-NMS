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
  networkId?: string;
  organizationId?: string;
  hierarchyId?: string;
  tags?: DeviceTag[];
  pendingCommandCount?: number;
  registeredAt?: string;
  lastSeenAt?: string;
  birthCertificate?: Record<string, string | number | boolean>;
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
}

export interface GpsSearchParams {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

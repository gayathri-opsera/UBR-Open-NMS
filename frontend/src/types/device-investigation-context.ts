/**
 * WO-047: Shared device investigation context types for KPI, topology, and alarm integration
 */

export interface DeviceIdentity {
  deviceId: string;
  serialNumber?: string;
  macAddress?: string;
  displayName: string;
  deviceType?: string;
}

export interface AvailabilityState {
  status: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
  healthReason?: string;
  lastSeen?: string;
  uptime?: number;
}

export interface RecentKpiBreach {
  metricName: string;
  breachTime: string;
  thresholdValue: number;
  actualValue: number;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
}

export interface ActiveAlarm {
  alarmId: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING';
  category: string;
  message: string;
  raisedAt: string;
  acknowledged: boolean;
}

export interface TopologyNeighbor {
  deviceId: string;
  displayName: string;
  relationship: 'PARENT' | 'CHILD' | 'PEER';
  linkStatus: 'UP' | 'DOWN' | 'DEGRADED';
}

export interface DeviceInvestigationContext {
  device: DeviceIdentity;
  availability: AvailabilityState;
  activeAlarms: ActiveAlarm[];
  recentKpiBreaches: RecentKpiBreach[];
  topologyNeighbors: TopologyNeighbor[];
  permittedActions: string[];
  generatedAt: string;
  warnings?: string[];
}

export interface InvestigationContextLoading {
  device: boolean;
  availability: boolean;
  alarms: boolean;
  kpi: boolean;
  topology: boolean;
}

export interface InvestigationContextError {
  domain: 'device' | 'availability' | 'alarms' | 'kpi' | 'topology';
  message: string;
  retryable: boolean;
}

/**
 * Normalizes device identity from different sources (KPI uses serialNumber, topology uses deviceId, etc.)
 */
export function normalizeDeviceIdentity(
  input: Partial<DeviceIdentity>
): DeviceIdentity {
  if (!input.deviceId && !input.serialNumber) {
    throw new Error('Device identity must have either deviceId or serialNumber');
  }

  return {
    deviceId: input.deviceId || input.serialNumber || '',
    serialNumber: input.serialNumber,
    macAddress: input.macAddress,
    displayName: input.displayName || input.deviceId || input.serialNumber || 'Unknown Device',
    deviceType: input.deviceType,
  };
}

/**
 * Builds query parameters for device investigation route
 */
export function buildInvestigationRouteParams(
  device: DeviceIdentity,
  filters?: {
    timeRange?: string;
    metricName?: string;
    topologyFilters?: Record<string, string>;
    alarmFilters?: Record<string, string>;
  }
): Record<string, string> {
  const params: Record<string, string> = {
    deviceId: device.deviceId,
  };

  if (device.serialNumber) {
    params.serialNumber = device.serialNumber;
  }

  if (filters) {
    if (filters.timeRange) params.timeRange = filters.timeRange;
    if (filters.metricName) params.metricName = filters.metricName;
    if (filters.topologyFilters) {
      params.topologyFilters = JSON.stringify(filters.topologyFilters);
    }
    if (filters.alarmFilters) {
      params.alarmFilters = JSON.stringify(filters.alarmFilters);
    }
  }

  return params;
}

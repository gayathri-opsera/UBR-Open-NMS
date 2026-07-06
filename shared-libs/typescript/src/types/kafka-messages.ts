import type { AlarmSeverity, AlarmState, DeviceType } from './models';

export interface RawAlarmMessage {
  alarmId: string;
  alarmName: string;
  severity: AlarmSeverity;
  alarmDescription?: string;
  state: 'RAISED' | 'CLEARED';
  Time: string;
  data: {
    deviceType: DeviceType;
    deviceId: string;
  };
}

export interface ProcessedAlarmMessage {
  alarmId: string;
  deviceId: string;
  deviceType?: DeviceType;
  alarmName: string;
  alarmDescription?: string;
  severity: AlarmSeverity;
  state: AlarmState;
  correlationGroup: string;
  rootCause?: string;
  acknowledged?: boolean;
  raisedAt: string;
  processedAt?: string;
}

export interface RawKPIMessage {
  deviceId: string;
  serialNumber?: string;
  deviceType?: DeviceType;
  kpiName: string;
  value: number;
  unit?: string;
  timestamp: string;
}

export interface ConfigPushMessage {
  jobId: string;
  deviceId: string;
  deviceType?: DeviceType;
  templateId: string;
  protocol: 'NETCONF' | 'CLI' | 'TR-069';
  parameters: Record<string, unknown>;
  approvedBy?: string;
  ttlExpiry?: string;
  enqueuedAt?: string;
}

export interface DeviceDiscoveredMessage {
  deviceId: string;
  serialNumber: string;
  macAddress: string;
  ipAddress?: string;
  deviceType: DeviceType;
  model?: string;
  firmware?: string;
  discoveredAt: string;
}

export interface NetcoolAlarmForwardMessage {
  alarmId: string;
  alarmName: string;
  severity: AlarmSeverity;
  alarmDescription: string;
  state: AlarmState;
  Time: string;
  data: {
    deviceType: DeviceType;
    deviceId: string;
  };
}

export interface Wireless5GhzRadio {
  txPowerDbm?: number;
  rxSignalStrengthDbm?: number;
  channelUtilizationPct?: number;
  snrDb?: number;
  connectedClients?: number;
  modulation?: string;
  throughputMbps?: number;
}

export interface EthernetPort {
  portId?: string;
  txBytesTotal?: number;
  rxBytesTotal?: number;
  txErrorsPct?: number;
  rxErrorsPct?: number;
  linkUptime?: number;
}

export interface MycomKPIExportMessage {
  deviceId: string;
  serialNumber: string;
  ipAddress?: string;
  timestamp: string;
  wireless5GhzRadio?: Wireless5GhzRadio;
  ethernetPorts?: EthernetPort[];
}

export interface InventorySyncMessage {
  systemName?: string;
  ipAddress: string;
  macAddress: string;
  serialNumber: string;
  model: string;
  firmware: string;
  deviceType?: DeviceType;
  latitude?: number;
  longitude?: number;
  region?: string;
  organizationId?: string;
  syncSource?: 'mobinet' | 'telemedia' | 'manual';
  syncedAt?: string;
}

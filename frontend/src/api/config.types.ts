// 12 parameter categories from NMS-CF-01
export const CONFIG_PARAMS = {
  wireless: ['ssid24', 'ssid5', 'wpaKey', 'operatingChannel', 'txPower', 'channelWidth'],
  network: ['ipMode', 'ipAddress', 'subnetMask', 'gateway', 'dnsServer'],
  vlan: ['vlanId', 'vlanPriority'],
  qos: ['ulBandwidthLimit', 'dlBandwidthLimit', 'qosPriority'],
  security: ['macAcl', 'isolateClients'],
  snmp: ['snmpCommunity', 'snmpTrapHost'],
  ntp: ['ntpServer', 'timezone'],
  management: ['adminUsername', 'httpPort', 'httpsPort'],
  firmware: ['firmwareVersion', 'firmwareUrl', 'autoUpgrade'],
  monitoring: ['pingInterval', 'pingTarget'],
  logging: ['syslogServer', 'logLevel'],
  backup: ['backupServer', 'backupSchedule'],
} as const;

export type ConfigCategory = keyof typeof CONFIG_PARAMS;
export type ConfigParamKey = string;

export interface ConfigTemplate {
  id?: string;
  name: string;
  description?: string;
  isDefault: boolean;
  parameters: Record<ConfigParamKey, string | number | boolean>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigJob {
  id?: string;
  jobId: string;
  totalDevices: number;
  successCount: number;
  failureCount: number;
  pendingCount: number;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
  progressPercent: number;
  perDeviceStatus?: Record<string, string>;
}

export interface ConfigVersion {
  id?: string;
  deviceId: string;
  versionNumber: number;
  actor: string;
  appliedAt: string;
  previousValues?: Record<string, string>;
  newValues: Record<string, string>;
}

export interface PushResult {
  status: 'PUSHED' | 'QUEUED' | 'REJECTED' | 'DEVICE_OFFLINE';
  message: string;
  commandId?: string;
}

export function validateTemplate(params: Record<string, string | number | boolean>): string[] {
  const errors: string[] = [];
  if (params.txPower !== undefined && (Number(params.txPower) < 0 || Number(params.txPower) > 30)) {
    errors.push('txPower must be between 0 and 30 dBm');
  }
  if (params.vlanId !== undefined && (Number(params.vlanId) < 1 || Number(params.vlanId) > 4094)) {
    errors.push('vlanId must be between 1 and 4094');
  }
  if (params.ssid24 && String(params.ssid24).length > 32) {
    errors.push('ssid24 must be 32 characters or less');
  }
  return errors;
}

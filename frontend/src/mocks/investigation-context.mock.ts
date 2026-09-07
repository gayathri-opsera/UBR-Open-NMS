/**
 * WO-047: Mock data for device investigation context
 */
import { DeviceInvestigationContext } from '../types/device-investigation-context';

export const mockBtsParentIncident: DeviceInvestigationContext = {
  device: {
    deviceId: 'bts-001',
    serialNumber: 'SN-BTS-001',
    macAddress: 'AA:BB:CC:DD:01:01',
    displayName: 'BTS Tower Alpha',
    deviceType: 'BTS',
  },
  availability: {
    status: 'DEGRADED',
    healthReason: 'High packet loss detected on uplink',
    lastSeen: '2026-09-07T22:00:00Z',
    uptime: 86400,
  },
  activeAlarms: [
    {
      alarmId: 'alarm-001',
      severity: 'CRITICAL',
      category: 'FAULT',
      message: 'Link degradation: packet loss > 5%',
      raisedAt: '2026-09-07T21:45:00Z',
      acknowledged: false,
    },
    {
      alarmId: 'alarm-002',
      severity: 'WARNING',
      category: 'THRESHOLD',
      message: 'Latency threshold breach',
      raisedAt: '2026-09-07T21:50:00Z',
      acknowledged: true,
    },
  ],
  recentKpiBreaches: [
    {
      metricName: 'packetLoss',
      breachTime: '2026-09-07T21:45:00Z',
      thresholdValue: 3,
      actualValue: 7.2,
      severity: 'CRITICAL',
    },
    {
      metricName: 'latency',
      breachTime: '2026-09-07T21:50:00Z',
      thresholdValue: 50,
      actualValue: 78,
      severity: 'WARNING',
    },
  },
  topologyNeighbors: [
    {
      deviceId: 'cpe-001',
      displayName: 'CPE Alpha-1',
      relationship: 'CHILD',
      linkStatus: 'DEGRADED',
    },
    {
      deviceId: 'cpe-002',
      displayName: 'CPE Alpha-2',
      relationship: 'CHILD',
      linkStatus: 'DOWN',
    },
  ],
  permittedActions: ['view', 'acknowledge_alarm', 'update_notes'],
  generatedAt: '2026-09-07T22:00:00Z',
};

export const mockImpactedCpe: DeviceInvestigationContext = {
  device: {
    deviceId: 'cpe-002',
    serialNumber: 'SN-CPE-002',
    macAddress: 'AA:BB:CC:DD:02:02',
    displayName: 'CPE Alpha-2',
    deviceType: 'CPE',
  },
  availability: {
    status: 'OFFLINE',
    healthReason: 'No response from device',
    lastSeen: '2026-09-07T21:42:00Z',
  },
  activeAlarms: [
    {
      alarmId: 'alarm-003',
      severity: 'MAJOR',
      category: 'FAULT',
      message: 'Device unreachable',
      raisedAt: '2026-09-07T21:43:00Z',
      acknowledged: false,
    },
  ],
  recentKpiBreaches: [],
  topologyNeighbors: [
    {
      deviceId: 'bts-001',
      displayName: 'BTS Tower Alpha',
      relationship: 'PARENT',
      linkStatus: 'DOWN',
    },
  ],
  permittedActions: ['view'],
  generatedAt: '2026-09-07T22:00:00Z',
};

export const mockPartialContextFailure: DeviceInvestigationContext = {
  device: {
    deviceId: 'dev-999',
    serialNumber: 'SN-DEV-999',
    displayName: 'Test Device',
    deviceType: 'GENERIC',
  },
  availability: {
    status: 'UNKNOWN',
  },
  activeAlarms: [],
  recentKpiBreaches: [],
  topologyNeighbors: [],
  permittedActions: ['view'],
  generatedAt: '2026-09-07T22:00:00Z',
  warnings: [
    'KPI service unavailable',
    'Alarm service timeout',
  ],
};

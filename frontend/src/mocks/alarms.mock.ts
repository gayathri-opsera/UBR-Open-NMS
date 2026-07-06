import type { Alarm } from '../api/alarms.types';

export const MOCK_ALARMS: Alarm[] = [
  {
    id: 'a1', alarmId: 'AL-001', deviceId: 'CPE-001', deviceType: 'CPE',
    alarmName: 'Link Down', alarmType: 'LINK_DOWN', severity: 'CRITICAL',
    state: 'ACTIVE', timestamp: new Date(Date.now() - 300_000).toISOString(),
    networkId: 'net-1', organizationId: 'org-1', dedupCount: 1,
  },
  {
    id: 'a2', alarmId: 'AL-002', deviceId: 'BTS-001', deviceType: 'BTS',
    alarmName: 'High CPU', alarmType: 'HIGH_CPU', severity: 'MAJOR',
    state: 'ACTIVE', timestamp: new Date(Date.now() - 600_000).toISOString(),
    networkId: 'net-1', organizationId: 'org-1', dedupCount: 3,
  },
  {
    id: 'a3', alarmId: 'AL-003', deviceId: 'CPE-002', deviceType: 'CPE',
    alarmName: 'Low RSSI', alarmType: 'LOW_RSSI', severity: 'WARNING',
    state: 'ACKNOWLEDGED', timestamp: new Date(Date.now() - 1_200_000).toISOString(),
    acknowledgedBy: 'noc1', networkId: 'net-2', organizationId: 'org-1', dedupCount: 2,
  },
  {
    id: 'a4', alarmId: 'AL-004', deviceId: 'CPE-003', deviceType: 'CPE',
    alarmName: 'Link Restored', alarmType: 'LINK_DOWN', severity: 'CLEAR',
    state: 'CLEARED', timestamp: new Date(Date.now() - 900_000).toISOString(),
    clearedAt: new Date(Date.now() - 600_000).toISOString(),
    networkId: 'net-1', organizationId: 'org-1', dedupCount: 1,
  },
];

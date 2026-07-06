import type { ConfigTemplate, ConfigJob, ConfigVersion } from '../api/config.types';

export const MOCK_TEMPLATES: ConfigTemplate[] = [
  {
    id: 't1', name: 'Standard CPE', description: 'Default CPE config', isDefault: true,
    parameters: { ssid24: 'UBR-NET', wpaKey: 'changeme', txPower: 20, vlanId: 100, channelWidth: 40 },
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
  {
    id: 't2', name: 'High Power BTS', description: 'BTS max power config', isDefault: false,
    parameters: { txPower: 28, operatingChannel: '149', channelWidth: 80 },
    createdAt: new Date(Date.now() - 43_200_000).toISOString(),
  },
];

export const MOCK_JOB: ConfigJob = {
  jobId: 'job-001', totalDevices: 10, successCount: 6, failureCount: 1, pendingCount: 3,
  status: 'RUNNING', progressPercent: 70,
  perDeviceStatus: {
    'CPE-001': 'SUCCESS', 'CPE-002': 'SUCCESS', 'CPE-003': 'FAILURE',
    'CPE-004': 'PENDING', 'BTS-001': 'SUCCESS',
  },
};

export const MOCK_VERSIONS: ConfigVersion[] = [
  {
    id: 'v1', deviceId: 'CPE-001', versionNumber: 2, actor: 'noc1',
    appliedAt: new Date(Date.now() - 3_600_000).toISOString(),
    previousValues: { txPower: '18', ssid24: 'UBR-OLD' },
    newValues: { txPower: '20', ssid24: 'UBR-NET' },
  },
  {
    id: 'v2', deviceId: 'CPE-001', versionNumber: 1, actor: 'admin',
    appliedAt: new Date(Date.now() - 86_400_000).toISOString(),
    newValues: { txPower: '18', ssid24: 'UBR-OLD' },
  },
];

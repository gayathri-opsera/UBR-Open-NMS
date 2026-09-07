import type { TopologyGraph } from '../api/topology.types';
import type { AvailabilitySummary } from '../api/topology.types';

export const MOCK_TOPOLOGY: TopologyGraph = {
  nodeCount: 5,
  edgeCount: 4,
  nodes: [
    {
      id: 'n1', deviceId: 'BTS-001', deviceType: 'BTS', serialNumber: 'BTS-SN-001',
      ipAddress: '10.0.0.1', macAddress: 'AA:BB:CC:DD:EE:01',
      operatingChannel: '149', rssi: -55, snr: 30,
      firmwareVersion: '3.4.1', uptime: '15d 4h',
      health: 'HEALTHY', pendingCommandCount: 0,
      location: { lat: 23.8103, lng: 90.4125 }, cascadeHop: 0,
    },
    {
      id: 'n2', deviceId: 'CPE-001', deviceType: 'CPE', serialNumber: 'CPE-SN-001',
      ipAddress: '192.168.1.2', macAddress: 'AA:BB:CC:DD:EE:02',
      rssi: -65, snr: 22, firmwareVersion: '3.4.1',
      health: 'HEALTHY', pendingCommandCount: 2,
      location: { lat: 23.8200, lng: 90.4200 }, parentDeviceId: 'BTS-001', cascadeHop: 1,
    },
    {
      id: 'n3', deviceId: 'CPE-002', deviceType: 'CPE', serialNumber: 'CPE-SN-002',
      ipAddress: '192.168.1.3', macAddress: 'AA:BB:CC:DD:EE:03',
      rssi: -78, snr: 15, firmwareVersion: '3.2.0',
      health: 'DEGRADED', pendingCommandCount: 0,
      location: { lat: 23.8050, lng: 90.4300 }, parentDeviceId: 'BTS-001', cascadeHop: 1,
    },
    {
      id: 'n4', deviceId: 'IDU-001', deviceType: 'IDU', serialNumber: 'IDU-SN-001',
      ipAddress: '10.0.0.2', macAddress: 'AA:BB:CC:DD:EE:04',
      health: 'FAULTY', pendingCommandCount: 1,
      location: { lat: 23.8150, lng: 90.4050 }, cascadeHop: 0,
    },
    {
      id: 'n5', deviceId: 'CPE-003', deviceType: 'CPE', serialNumber: 'CPE-SN-003',
      ipAddress: '192.168.1.4', macAddress: 'AA:BB:CC:DD:EE:05',
      rssi: -70, snr: 20,
      health: 'HEALTHY', pendingCommandCount: 0,
      location: { lat: 23.8300, lng: 90.4000 }, parentDeviceId: 'BTS-001', cascadeHop: 1,
    },
  ],
  edges: [
    { id: 'e1', sourceDeviceId: 'BTS-001', targetDeviceId: 'CPE-001', linkType: 'BTS_TO_CPE', health: 'HEALTHY' },
    { id: 'e2', sourceDeviceId: 'BTS-001', targetDeviceId: 'CPE-002', linkType: 'BTS_TO_CPE', health: 'DEGRADED' },
    { id: 'e3', sourceDeviceId: 'BTS-001', targetDeviceId: 'CPE-003', linkType: 'BTS_TO_CPE', health: 'HEALTHY' },
    { id: 'e4', sourceDeviceId: 'IDU-001', targetDeviceId: 'BTS-001', linkType: 'IDU_TO_BTS', health: 'FAULTY' },
  ],
};

// ── WO-036: Availability summary fixtures ──────────────────────────────────────

const NOW = new Date().toISOString();
const STALE = new Date(Date.now() - 8 * 60_000).toISOString();

/** Full availability summary fixture — healthy, degraded, down, unknown states. */
export const MOCK_AVAILABILITY_SUMMARIES: AvailabilitySummary[] = [
  {
    deviceId: 'BTS-001', serialNumber: 'BTS-SN-001',
    availabilityPct: 99.8, healthState: 'HEALTHY',
    activeAlarmCount: 0, primaryReason: 'All subsystems nominal',
    lastObservedAt: NOW, healthSource: 'AVAILABILITY',
  },
  {
    deviceId: 'CPE-001', serialNumber: 'CPE-SN-001',
    availabilityPct: 98.1, healthState: 'HEALTHY',
    activeAlarmCount: 1, primaryReason: 'Minor signal degradation (RSSI -65 dBm)',
    lastObservedAt: NOW, healthSource: 'ALARM',
  },
  {
    deviceId: 'CPE-002', serialNumber: 'CPE-SN-002',
    availabilityPct: 87.4, healthState: 'DEGRADED',
    activeAlarmCount: 3, primaryReason: 'High packet loss 4.2% — RSSI -78 dBm below threshold',
    lastObservedAt: STALE, healthSource: 'ALARM',
  },
  {
    deviceId: 'IDU-001', serialNumber: 'IDU-SN-001',
    availabilityPct: 0.0, healthState: 'FAULTY',
    activeAlarmCount: 5, primaryReason: 'Device unreachable — last seen 18 min ago',
    lastObservedAt: new Date(Date.now() - 18 * 60_000).toISOString(), healthSource: 'CONNECTIVITY',
  },
  // CPE-003 intentionally absent — tests UNKNOWN fallback for missing node
];

/** Partial-unavailability fixture: some nodes missing summary data. */
export const MOCK_AVAILABILITY_PARTIAL: AvailabilitySummary[] = [
  {
    deviceId: 'BTS-001', serialNumber: 'BTS-SN-001',
    availabilityPct: 99.8, healthState: 'HEALTHY',
    activeAlarmCount: 0, primaryReason: 'All subsystems nominal',
    lastObservedAt: NOW, healthSource: 'AVAILABILITY',
  },
  // All other devices absent — they must become UNKNOWN, not HEALTHY
];

/** Generic device fixture — for testing GENERIC nodeType rendering. */
export const MOCK_TOPOLOGY_WITH_GENERIC: TopologyGraph = {
  nodeCount: 2,
  edgeCount: 1,
  nodes: [
    {
      id: 'ng1', deviceId: 'GENERIC-001', deviceType: 'GENERIC',
      serialNumber: 'GENERIC-IP-10.0.1.1', ipAddress: '10.0.1.1',
      macAddress: '11:22:33:44:55:66',
      health: 'UNKNOWN',
      location: { lat: 23.82, lng: 90.42 },
    },
    {
      id: 'ng2', deviceId: 'BTS-001', deviceType: 'BTS',
      serialNumber: 'BTS-SN-001', ipAddress: '10.0.0.1',
      macAddress: 'AA:BB:CC:DD:EE:01', health: 'HEALTHY',
      location: { lat: 23.81, lng: 90.41 },
    },
  ],
  edges: [
    {
      id: 'eg1', sourceDeviceId: 'GENERIC-001', targetDeviceId: 'BTS-001',
      linkType: 'GENERIC_TO_BTS',
      health: 'UNKNOWN',
      // linkQuality absent — must render as UNKNOWN, not drop the edge
    },
  ],
};

/** DOWN link fixture — edge with linkQuality DOWN must render as FAULTY. */
export const MOCK_TOPOLOGY_DOWN_LINK: TopologyGraph = {
  nodeCount: 2,
  edgeCount: 1,
  nodes: [
    { id: 'd1', deviceId: 'BTS-DOWN-001', deviceType: 'BTS', serialNumber: 'BTS-SN-DOWN', ipAddress: '10.0.99.1', macAddress: 'DD:DD:DD:DD:DD:01', health: 'FAULTY' },
    { id: 'd2', deviceId: 'CPE-DOWN-001', deviceType: 'CPE', serialNumber: 'CPE-SN-DOWN', ipAddress: '10.0.99.2', macAddress: 'DD:DD:DD:DD:DD:02', health: 'DEGRADED' },
  ],
  edges: [
    { id: 'de1', sourceDeviceId: 'BTS-DOWN-001', targetDeviceId: 'CPE-DOWN-001', linkType: 'BTS_TO_CPE', linkQuality: 'DOWN', health: 'FAULTY' },
  ],
};

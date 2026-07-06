import type { TopologyGraph } from '../api/topology.types';

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

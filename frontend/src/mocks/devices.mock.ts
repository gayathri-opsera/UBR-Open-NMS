import type { Device } from '../api/devices.types';

export const MOCK_DEVICES: Device[] = [
  {
    id: 'd1', deviceId: 'CPE-SN001', deviceType: 'CPE',
    serialNumber: 'SN-001-ABC', macAddress: '00:1A:2B:3C:4D:5E',
    ipAddress: '192.168.1.101', manufacturer: 'Senao', model: 'ENH900EXT',
    firmwareVersion: '3.4.1', status: 'ONLINE',
    location: { type: 'Point', coordinates: [90.4125, 23.8103] },
    networkId: 'net-1', organizationId: 'org-1',
    tags: ['circle-dhaka', 'tier1'],
    pendingCommandCount: 2,
    birthCertificate: { vendor: 'Senao', pn: 'ENH900', orderId: 'ORD-001' },
  },
  {
    id: 'd2', deviceId: 'BTS-SN002', deviceType: 'BTS',
    serialNumber: 'SN-002-XYZ', macAddress: 'AA:BB:CC:DD:EE:FF',
    ipAddress: '10.0.0.5', manufacturer: 'Ubiquiti', model: 'AirFiber 5X',
    firmwareVersion: '2.1.0', status: 'ONLINE',
    location: { type: 'Point', coordinates: [90.3563, 23.7275] },
    networkId: 'net-1', organizationId: 'org-1',
    tags: [],
    pendingCommandCount: 0,
  },
  {
    id: 'd3', deviceId: 'CPE-SN003', deviceType: 'CPE',
    serialNumber: 'SN-003-DEF', macAddress: '11:22:33:44:55:66',
    ipAddress: '192.168.2.50', manufacturer: 'Senao', model: 'EAP1750H',
    firmwareVersion: '2.8.0', status: 'OFFLINE',
    networkId: 'net-2', organizationId: 'org-1',
    tags: ['circle-chittagong'],
    pendingCommandCount: 0,
  },
];

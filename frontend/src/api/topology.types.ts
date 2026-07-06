export type NodeType = 'BTS' | 'CPE' | 'IDU';
export type NodeHealth = 'HEALTHY' | 'DEGRADED' | 'FAULTY' | 'UNKNOWN';

export interface TopologyNode {
  id: string;
  deviceId: string;
  deviceType: NodeType;
  serialNumber: string;
  ipAddress: string;
  macAddress: string;
  operatingChannel?: string;
  rssi?: number;
  snr?: number;
  firmwareVersion?: string;
  uptime?: string;
  networkId?: string;
  health: NodeHealth;
  pendingCommandCount?: number;
  location?: { lat: number; lng: number };
  parentDeviceId?: string;
  cascadeHop?: number;
}

export interface TopologyEdge {
  id: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  linkType: string;
  health: NodeHealth;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  nodeCount: number;
  edgeCount: number;
}

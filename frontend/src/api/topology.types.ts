export type NodeType = 'BTS' | 'CPE' | 'IDU';
export type NodeHealth = 'HEALTHY' | 'DEGRADED' | 'FAULTY' | 'UNKNOWN';

export interface TopologyNode {
  id: string;
  deviceId: string;
  deviceName?: string;
  deviceType: NodeType;
  serialNumber: string;
  ipAddress: string;
  macAddress: string;
  operatingChannel?: string;
  rssi?: number;
  /** A1 chain RSSI — included in graph response per NMS-TP-06 */
  a1Rssi?: number;
  /** A2 chain RSSI — included in graph response per NMS-TP-06 */
  a2Rssi?: number;
  snr?: number;
  firmwareVersion?: string;
  /** Ethernet speed of connected clients e.g. "144 Mbps" */
  ethernetSpeed?: string;
  /** Duplex mode e.g. "Half Duplex" */
  duplex?: string;
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
  /** GOOD | FAIR | POOR | DOWN — used for edge colour in graph view */
  linkQuality?: 'GOOD' | 'FAIR' | 'POOR' | 'DOWN';
  health: NodeHealth;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  nodeCount: number;
  edgeCount: number;
}

/** Extended summary — returned by /topology/device/{id}/summary */
export interface DeviceSummary {
  deviceId: string;
  serialNumber: string;
  operatingChannel?: string;
  rssi?: number;
  a1Rssi?: number;
  a2Rssi?: number;
  snr?: number;
  firmwareVersion?: string;
  ethernetSpeed?: string;
  duplex?: string;
  uptime?: string;
  connectedClients?: number;
  cpuPercent?: number;
  memPercent?: number;
  gpsRelocation?: boolean;
  compassDrift?: number;
}

/** Link health metrics — /topology/device/{id}/link-health */
export interface LinkHealth {
  deviceId: string;
  linkQuality: 'GOOD' | 'FAIR' | 'POOR' | 'DOWN';
  rssi?: number;
  snr?: number;
  throughputMbps?: number;
  packetLossPct?: number;
  latencyMs?: number;
  a1Rssi?: number;
  a2Rssi?: number;
  lastUpdated: string;
}

export type EventSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INFO';

/** Device event — /topology/device/{id}/events */
export interface DeviceEvent {
  id: string;
  timestamp: string;
  eventType: string;
  severity: EventSeverity;
  description: string;
  deviceId: string;
  acknowledged?: boolean;
}

import { apiClient } from './client';
import type {
  TopologyGraph, TopologyNode, TopologyEdge, NodeHealth,
  DeviceSummary, LinkHealth, DeviceEvent,
} from './topology.types';

type RawNode = Omit<TopologyNode, 'deviceType' | 'health' | 'location'> & {
  type: string;
  status: string;
  latitude?: number;
  longitude?: number;
  linkHealth?: string;
  // extended fields included in graph response
  a1Rssi?: number;
  a2Rssi?: number;
  ethernetSpeed?: string;
  duplex?: string;
  deviceName?: string;
};

type RawEdge = Omit<TopologyEdge, 'id'> & { id?: string; linkQuality?: string };

type RawGraph = {
  nodes: RawNode[];
  edges: RawEdge[];
  nodeCount: number;
  edgeCount: number;
};

function normalizeNode(raw: RawNode): TopologyNode {
  return {
    ...raw,
    deviceType: (raw.type as TopologyNode['deviceType']) ?? 'CPE',
    health: (raw.status as NodeHealth) ?? 'UNKNOWN',
    location:
      raw.latitude != null && raw.longitude != null
        ? { lat: raw.latitude, lng: raw.longitude }
        : undefined,
  } as TopologyNode;
}

function normalizeEdge(raw: RawEdge, idx: number): TopologyEdge {
  return {
    id: raw.id ?? `${raw.sourceDeviceId}-${raw.targetDeviceId}-${idx}`,
    sourceDeviceId: raw.sourceDeviceId,
    targetDeviceId: raw.targetDeviceId,
    linkType: raw.linkType,
    linkQuality: raw.linkQuality as TopologyEdge['linkQuality'],
    health: raw.health,
  };
}

function normalizeGraph(raw: RawGraph): TopologyGraph {
  return {
    nodes: raw.nodes.map(normalizeNode),
    edges: raw.edges.map(normalizeEdge),
    nodeCount: raw.nodeCount,
    edgeCount: raw.edgeCount,
  };
}

export async function fetchTopology(networkId?: string, bustCache = false): Promise<TopologyGraph> {
  const params: Record<string, string> = {};
  if (networkId) params.networkId = networkId;
  if (bustCache) params._t = String(Date.now()); // bypass 30s stub cache
  const res = await apiClient.get<RawGraph>('/topology', { params });
  return normalizeGraph(res.data);
}

export async function fetchDeviceConnections(deviceId: string): Promise<TopologyNode[]> {
  const res = await apiClient.get<RawNode[]>(`/topology/device/${deviceId}/connections`);
  return res.data.map(normalizeNode);
}

/** Extended hover data: A1/A2 RSSI, speed/duplex (NMS-TP-06) */
export async function fetchDeviceSummary(deviceId: string): Promise<DeviceSummary> {
  const res = await apiClient.get<DeviceSummary>(`/topology/device/${deviceId}/summary`);
  return res.data;
}

/** Link health metrics (NMS-TP-08) */
export async function fetchDeviceLinkHealth(deviceId: string): Promise<LinkHealth> {
  const res = await apiClient.get<LinkHealth>(`/topology/device/${deviceId}/link-health`);
  return res.data;
}

/**
 * Event history for a device (NMS-TP-08).
 * from/to are ISO timestamps. Max window: 1 week.
 */
export async function fetchDeviceEvents(
  deviceId: string,
  from?: string,
  to?: string,
): Promise<DeviceEvent[]> {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to)   params.to   = to;
  const res = await apiClient.get<DeviceEvent[]>(`/topology/device/${deviceId}/events`, { params });
  return res.data;
}

/** GPS radius search — returns devices within radiusKm (NMS-TP-02) */
export async function searchTopology(params: {
  search?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}): Promise<TopologyNode[]> {
  const res = await apiClient.get<RawNode[]>('/topology/search', { params });
  return res.data.map(normalizeNode);
}

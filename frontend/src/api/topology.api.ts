import { apiClient } from './client';
import type { TopologyGraph, TopologyNode, TopologyEdge, NodeHealth } from './topology.types';

type RawNode = Omit<TopologyNode, 'deviceType' | 'health' | 'location'> & {
  type: string;
  status: string;
  latitude?: number;
  longitude?: number;
  linkHealth?: string;
};

type RawEdge = Omit<TopologyEdge, 'id'> & { id?: string };

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

export async function fetchTopology(networkId?: string): Promise<TopologyGraph> {
  const params = networkId ? { networkId } : {};
  const res = await apiClient.get<RawGraph>('/topology', { params });
  return normalizeGraph(res.data);
}

export async function fetchDeviceConnections(deviceId: string): Promise<TopologyNode[]> {
  const res = await apiClient.get<RawNode[]>(`/topology/device/${deviceId}/connections`);
  return res.data.map(normalizeNode);
}

export async function searchTopology(params: {
  search?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}): Promise<TopologyNode[]> {
  const res = await apiClient.get<RawNode[]>('/topology/search', { params });
  return res.data.map(normalizeNode);
}

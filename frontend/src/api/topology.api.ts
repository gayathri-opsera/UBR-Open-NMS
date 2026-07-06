import { apiClient } from './client';
import type { TopologyGraph, TopologyNode } from './topology.types';

export async function fetchTopology(networkId: string): Promise<TopologyGraph> {
  const res = await apiClient.get<TopologyGraph>('/topology', { params: { networkId } });
  return res.data;
}

export async function fetchDeviceConnections(deviceId: string): Promise<TopologyNode[]> {
  const res = await apiClient.get<TopologyNode[]>(`/topology/device/${deviceId}/connections`);
  return res.data;
}

export async function searchTopology(params: {
  search?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}): Promise<TopologyNode[]> {
  const res = await apiClient.get<TopologyNode[]>('/topology/search', { params });
  return res.data;
}

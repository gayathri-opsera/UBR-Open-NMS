/**
 * Device Groups API — REQ-015 / NMS-INV-05
 *
 * Groups allow operators to organise devices (BTS/CPE/IDU) into logical
 * management sets — e.g. "Delhi Ring", "Core BTS", "Maintenance Window" — for
 * bulk operations, filtered KPI views, and topology groupings.
 */
import { apiClient } from './client';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DeviceGroup {
  id: string;
  name: string;
  description?: string;
  color?: string;          // hex color for UI badge
  deviceIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  tags?: string[];
}

export interface GroupSummary {
  id: string;
  name: string;
  color?: string;
  deviceCount: number;
  onlineCount: number;
  offlineCount: number;
  criticalAlarmCount: number;
  updatedAt: string;
}

// ── API functions ─────────────────────────────────────────────────────────────
export async function fetchGroups(): Promise<DeviceGroup[]> {
  const { data } = await apiClient.get<DeviceGroup[]>('/groups');
  return data;
}

export async function fetchGroupSummaries(): Promise<GroupSummary[]> {
  const { data } = await apiClient.get<GroupSummary[]>('/groups/summary');
  return data;
}

export async function fetchGroup(id: string): Promise<DeviceGroup> {
  const { data } = await apiClient.get<DeviceGroup>(`/groups/${id}`);
  return data;
}

export async function createGroup(payload: Omit<DeviceGroup, 'id' | 'createdAt' | 'updatedAt'>): Promise<DeviceGroup> {
  const { data } = await apiClient.post<DeviceGroup>('/groups', payload);
  return data;
}

export async function updateGroup(id: string, updates: Partial<Omit<DeviceGroup, 'id' | 'createdAt' | 'updatedAt'>>): Promise<DeviceGroup> {
  const { data } = await apiClient.put<DeviceGroup>(`/groups/${id}`, updates);
  return data;
}

export async function deleteGroup(id: string): Promise<void> {
  await apiClient.delete(`/groups/${id}`);
}

export async function addDevicesToGroup(groupId: string, deviceIds: string[]): Promise<DeviceGroup> {
  const { data } = await apiClient.post<DeviceGroup>(`/groups/${groupId}/devices`, { deviceIds });
  return data;
}

export async function removeDevicesFromGroup(groupId: string, deviceIds: string[]): Promise<DeviceGroup> {
  const { data } = await apiClient.delete<DeviceGroup>(`/groups/${groupId}/devices`, { data: { deviceIds } });
  return data;
}

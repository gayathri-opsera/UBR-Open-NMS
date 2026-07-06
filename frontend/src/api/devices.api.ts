import { apiClient } from './client';
import type { Device, DeviceFilter, GpsSearchParams } from './devices.types';

export async function fetchDevices(filter: DeviceFilter = {}): Promise<Device[]> {
  const res = await apiClient.get<Device[]>('/devices', { params: filter });
  return res.data;
}

export async function fetchDevice(id: string): Promise<Device> {
  const res = await apiClient.get<Device>(`/devices/${id}`);
  return res.data;
}

export async function updateDeviceTags(id: string, tags: Array<{ key: string; value: string }>): Promise<Device> {
  const res = await apiClient.put<Device>(`/devices/${id}/tags`, { tags });
  return res.data;
}

export async function searchByGps(params: GpsSearchParams): Promise<Device[]> {
  const res = await apiClient.get<Device[]>('/devices/search/gps', { params });
  return res.data;
}

export async function fetchPendingCommands(id: string): Promise<unknown[]> {
  const res = await apiClient.get<unknown[]>(`/devices/${id}/pending-commands`);
  return res.data;
}

export function buildExportUrl(filter: DeviceFilter, format: 'csv' | 'xls'): string {
  const params = new URLSearchParams({ ...filter as Record<string, string>, format });
  return `/api/v1/devices/export?${params}`;
}

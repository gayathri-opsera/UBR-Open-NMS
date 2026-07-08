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

export async function createDevice(device: Omit<Device, 'id'>): Promise<Device> {
  const res = await apiClient.post<Device>('/devices', device);
  return res.data;
}

export async function updateDevice(id: string, updates: Partial<Device>): Promise<Device> {
  const res = await apiClient.put<Device>(`/devices/${id}`, updates);
  return res.data;
}

export async function deleteDevice(id: string): Promise<void> {
  await apiClient.delete(`/devices/${id}`);
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

export async function downloadDeviceExport(filter: DeviceFilter, format: 'csv' | 'xls'): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = String(v);
  }
  clean.format = format;
  const res = await apiClient.get('/devices/export', { params: clean, responseType: 'blob' });
  const ext = format === 'xls' ? 'xlsx' : 'csv';
  const url = URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `devices-export.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

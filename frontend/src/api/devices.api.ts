import { apiClient } from './client';
import type { Device, DeviceFilter, GpsSearchParams } from './devices.types';

/** Safely extract a Device array from any paginated response shape. */
function extractBatch(data: unknown): Device[] {
  if (Array.isArray(data)) return data as Device[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['devices', 'data', 'items', 'content', 'results']) {
      if (Array.isArray(d[key])) return d[key] as Device[];
    }
  }
  return [];
}

export async function fetchDevices(filter: DeviceFilter = {}): Promise<Device[]> {
  // The Java inventory service caps each page at 100 — paginate to collect all devices
  const PAGE_SIZE = 100;
  const MAX_PAGES = 20; // safety cap — up to 2,000 devices
  const all: Device[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await apiClient.get('/devices', {
      params: { limit: PAGE_SIZE, page, ...filter },
    });
    const batch = extractBatch(res.data);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break; // last page reached
  }
  return all;
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

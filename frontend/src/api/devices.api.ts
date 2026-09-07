import { apiClient } from './client';
import type { Device, DeviceFilter, GpsSearchParams, DeviceOnboardingState, OnboardingStatesResponse, OnboardingStatusFilter, OnboardingStatusItem, OnboardingStatusResponse } from './devices.types';

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

/**
 * Fetch devices filtered by SNMP sysObjectID (WO-004).
 * Returns only generic-discovery devices matching the OID; UBR devices are excluded.
 */
export async function fetchDevicesBySysObjectId(sysObjectID: string): Promise<Device[]> {
  return fetchDevices({ sysObjectID } as DeviceFilter);
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

// ── WO-026: Bootstrap onboarding state API ───────────────────────────────────

/**
 * Fetch UBR device bootstrap onboarding states from the discovery service.
 * Returns a list of call-home-capable devices with their current bootstrap
 * progress, failure reasons, and commissioning pending fields.
 * No sensitive authentication material is included in the response.
 */
export async function fetchOnboardingStates(stateFilter?: string): Promise<DeviceOnboardingState[]> {
  const params: Record<string, string> = {};
  if (stateFilter) params.state = stateFilter;
  const res = await apiClient.get<OnboardingStatesResponse | DeviceOnboardingState[]>(
    '/discovery/onboarding',
    { params },
  );
  // Tolerate both array and wrapped { items: [] } shapes from API
  const data = res.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && 'items' in data && Array.isArray(data.items)) {
    return data.items;
  }
  return [];
}

// ── WO-038: Onboarding Status API ────────────────────────────────────────────

/**
 * Fetches the paginated onboarding status feed from the inventory service (WO-038).
 * Returns operator-safe status data — no sensitive authentication material.
 */
export async function fetchOnboardingStatus(
  filter: OnboardingStatusFilter = {},
): Promise<OnboardingStatusResponse> {
  const params: Record<string, string | number> = {};
  if (filter.page !== undefined)         params.page = filter.page;
  if (filter.limit !== undefined)        params.limit = filter.limit;
  if (filter.state)                      params.state = filter.state;
  if (filter.paradigm)                   params.paradigm = filter.paradigm;
  if (filter.deviceType)                 params.deviceType = filter.deviceType;
  if (filter.reasonCategory)             params.reasonCategory = filter.reasonCategory;
  if (filter.serialNumber)               params.serialNumber = filter.serialNumber;
  if (filter.macAddress)                 params.macAddress = filter.macAddress;
  if (filter.sysObjectID)                params.sysObjectID = filter.sysObjectID;
  if (filter.from)                       params.from = filter.from;
  if (filter.to)                         params.to = filter.to;

  const res = await apiClient.get<OnboardingStatusResponse>(
    '/inventory/onboarding-status',
    { params },
  );
  return res.data;
}

/**
 * Fetches the onboarding status for a single device by its inventory ID (WO-038).
 */
export async function fetchOnboardingStatusById(deviceId: string): Promise<OnboardingStatusItem> {
  const res = await apiClient.get<OnboardingStatusItem>(
    `/inventory/onboarding-status/${deviceId}`,
  );
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

/**
 * Device Type Combinations API — DT-02, DT-04, DT-10
 *
 * Manages (model + role) → (configuration + nodeView) combinations.
 */
import { apiClient } from './client';

export interface DeviceTypeCombination {
  id: string;
  combinationId: string;
  model: string;
  role: string;
  description?: string;
  productDefinitionId?: string | null;
  nodeViewDescriptorId?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface DeviceTypeCombinationInput {
  model: string;
  role: string;
  description?: string;
  productDefinitionId?: string | null;
  nodeViewDescriptorId?: string | null;
}

export interface DeviceTypeAuditEntry {
  _id?: string;
  serialNumber: string;
  oldType: string | null;
  oldModel: string | null;
  oldRole: string | null;
  newType: string;
  newModel: string | null;
  newRole: string | null;
  combinationId?: string | null;
  changedBy: string;
  changedAt: string;
  reason?: string;
}

/** List all device type combinations */
export async function listCombinations(): Promise<DeviceTypeCombination[]> {
  const res = await apiClient.get<DeviceTypeCombination[]>('/device-type-combinations');
  return res.data;
}

/** List all unique models (for first-step picker) */
export async function listModels(): Promise<string[]> {
  const res = await apiClient.get<string[]>('/device-type-combinations/models');
  return res.data;
}

/** List roles for a specific model (for second-step dropdown) */
export async function listRolesForModel(model: string): Promise<{ role: string; description: string; productDefinitionId: string | null }[]> {
  const res = await apiClient.get('/device-type-combinations/roles', { params: { model } });
  return res.data;
}

/** Create a new combination */
export async function createCombination(input: DeviceTypeCombinationInput): Promise<DeviceTypeCombination> {
  const res = await apiClient.post<DeviceTypeCombination>('/device-type-combinations', input);
  return res.data;
}

/** Update an existing combination */
export async function updateCombination(id: string, input: Partial<DeviceTypeCombinationInput & { isActive: boolean }>): Promise<DeviceTypeCombination> {
  const res = await apiClient.put<DeviceTypeCombination>(`/device-type-combinations/${id}`, input);
  return res.data;
}

/** Soft-delete a combination */
export async function deleteCombination(id: string): Promise<void> {
  await apiClient.delete(`/device-type-combinations/${id}`);
}

/** Fetch full audit log (all devices) */
export async function fetchAuditLog(): Promise<DeviceTypeAuditEntry[]> {
  const res = await apiClient.get<DeviceTypeAuditEntry[]>('/device-type-combinations/audit');
  return res.data;
}

/** Fetch audit log for one device */
export async function fetchDeviceAuditLog(serialNumber: string): Promise<DeviceTypeAuditEntry[]> {
  const res = await apiClient.get<DeviceTypeAuditEntry[]>(`/device-type-combinations/audit/${encodeURIComponent(serialNumber)}`);
  return res.data;
}

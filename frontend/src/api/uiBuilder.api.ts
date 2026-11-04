import { apiClient } from './client';
import type { MibObjectSummary } from './productDefinitions.api';

export type { MibObjectSummary };

export interface UiDescriptorField {
  fieldId: string;
  elementType: 'heading' | 'sub-heading' | 'field-label' | 'table-block' | 'divider';
  label: string;
  labelLevel?: 'heading' | 'sub-heading' | 'field';
  mibObject?: string;
  oid?: string;
  syntax?: string;
  units?: string;
  access?: 'read-only' | 'read-write' | 'not-accessible';
  widget?: string;
  minValue?: number;
  maxValue?: number;
  pollInterval?: number;
  writeMode?: 'apply-button' | 'direct';
  helpText?: string;
  confirmWrite?: boolean;
  enumMap?: Record<string, string>;
  order: number;
}

export interface UiDescriptorSection {
  sectionId: string;
  title: string;
  columns: 1 | 2;
  fullWidth?: boolean;
  pollInterval?: number;
  writeMode?: 'apply-button' | 'direct' | 'read-only';
  fields: UiDescriptorField[];
  order: number;
}

export interface UiDescriptor {
  descriptorId: string;
  screenName: string;
  deviceProfile?: string;
  productDefinitionId?: string;
  vendor?: string;
  productFamily?: string;
  mibModule?: string;
  status: 'draft' | 'published';
  sections: UiDescriptorSection[];
  generatedXml?: string;
  /** MIB objects selected during Stage 1; stored for session restore. */
  selectedObjects?: MibObjectSummary[];
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UiDescriptorSummary extends Omit<UiDescriptor, 'sections' | 'generatedXml' | 'selectedObjects'> {
  sectionCount: number;
  objectCount: number;
}

const BASE = '/ui-builder';

interface Envelope<T> {
  status: string;
  data: T;
}

function unwrap<T>(body: Envelope<T>): T {
  return body.data;
}

export async function listDescriptors(): Promise<UiDescriptorSummary[]> {
  const res = await apiClient.get<Envelope<UiDescriptorSummary[]>>(`${BASE}/descriptors`);
  return unwrap(res.data);
}

export async function createDescriptor(data: Partial<UiDescriptor>): Promise<UiDescriptor> {
  const res = await apiClient.post<Envelope<UiDescriptor>>(`${BASE}/descriptors`, data);
  return unwrap(res.data);
}

export async function getDescriptor(id: string): Promise<UiDescriptor> {
  const res = await apiClient.get<Envelope<UiDescriptor>>(`${BASE}/descriptors/${encodeURIComponent(id)}`);
  return unwrap(res.data);
}

export async function updateDescriptor(id: string, data: Partial<UiDescriptor>): Promise<UiDescriptor> {
  const res = await apiClient.put<Envelope<UiDescriptor>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}`,
    data,
  );
  return unwrap(res.data);
}

export async function publishDescriptor(
  id: string,
  options?: { productDefinitionId?: string },
): Promise<UiDescriptor> {
  const res = await apiClient.post<Envelope<UiDescriptor>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}/publish`,
    options ?? {},
  );
  return unwrap(res.data);
}

export async function deleteDescriptor(id: string): Promise<void> {
  await apiClient.delete(`${BASE}/descriptors/${encodeURIComponent(id)}`);
}

export async function getDescriptorXml(id: string): Promise<string> {
  const res = await apiClient.get<Envelope<{ descriptorId: string; xml: string }>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}/xml`,
  );
  return unwrap(res.data).xml;
}

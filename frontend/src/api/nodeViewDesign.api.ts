/**
 * Node View Design API — Pre-MIB designer phase (PV-01 → PV-12)
 */
import axios from 'axios';

const BASE = '/api/v1/node-view-designs';

export interface NvdLabel {
  labelId:     string;
  text:        string;
  unit:        string | null;
  order:       number;
  position:    { x: number; y: number };
  frozen:      boolean;
  mappedField: string | null;
}

export interface NvdSection {
  sectionId:       string;
  title:           string;
  parentSectionId: string | null;
  /** scalar | single | double | triple */
  indexLevel:      'scalar' | 'single' | 'double' | 'triple';
  order:           number;
  position:        { x: number; y: number };
  size:            { width: number; height: number };
  frozen:          boolean;
  labels:          NvdLabel[];
}

export interface NodeViewDesign {
  nodeViewId:        string;
  name:              string;
  deviceFamily:      string;
  description:       string;
  status:            'draft' | 'ready';
  locked:            boolean;
  gridSize:          number;
  sections:          NvdSection[];
  linkedDescriptorId:string | null;
  copiedFromId:      string | null;
  createdBy:         string | null;
  updatedBy:         string | null;
  createdAt:         string;
  updatedAt:         string;
}

export interface NodeViewDesignSummary extends Omit<NodeViewDesign, 'sections'> {
  sectionCount: number;
  labelCount:   number;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function listNodeViewDesigns(params?: { status?: string; deviceFamily?: string }): Promise<NodeViewDesignSummary[]> {
  const { data } = await axios.get(BASE, { params });
  return data.data;
}

export async function createNodeViewDesign(payload: {
  name: string;
  deviceFamily?: string;
  description?: string;
  sections?: NvdSection[];
}): Promise<NodeViewDesign> {
  const { data } = await axios.post(BASE, payload);
  return data.data;
}

export async function getNodeViewDesign(id: string): Promise<NodeViewDesign> {
  const { data } = await axios.get(`${BASE}/${id}`);
  return data.data;
}

export async function updateNodeViewDesign(
  id: string,
  payload: Partial<Pick<NodeViewDesign, 'name' | 'deviceFamily' | 'description' | 'sections' | 'linkedDescriptorId' | 'gridSize'>>,
): Promise<NodeViewDesign> {
  const { data } = await axios.put(`${BASE}/${id}`, payload);
  return data.data;
}

export async function deleteNodeViewDesign(id: string): Promise<void> {
  await axios.delete(`${BASE}/${id}`);
}

export async function copyNodeViewDesign(id: string, name?: string): Promise<NodeViewDesign> {
  const { data } = await axios.post(`${BASE}/${id}/copy`, name ? { name } : {});
  return data.data;
}

export async function toggleNodeViewLock(id: string, locked?: boolean): Promise<{ nodeViewId: string; locked: boolean }> {
  const { data } = await axios.post(`${BASE}/${id}/lock`, locked !== undefined ? { locked } : {});
  return data.data;
}

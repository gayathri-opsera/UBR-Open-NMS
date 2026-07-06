import { apiClient } from './client';

export interface Organization {
  id?: string;
  name: string;
  description?: string;
  createdAt?: string;
}

export interface HierarchyView {
  id?: string;
  name: string;
  description?: string;
  organizationId: string;
}

export interface Network {
  id?: string;
  name: string;
  description?: string;
  organizationId: string;
  hierarchyViewId: string;
}

// Organizations
export async function fetchOrganizations(): Promise<Organization[]> {
  const res = await apiClient.get<Organization[]>('/organizations');
  return res.data;
}
export async function createOrganization(org: Omit<Organization, 'id' | 'createdAt'>): Promise<Organization> {
  const res = await apiClient.post<Organization>('/organizations', org);
  return res.data;
}
export async function updateOrganization(id: string, org: Partial<Organization>): Promise<Organization> {
  const res = await apiClient.put<Organization>(`/organizations/${id}`, org);
  return res.data;
}
export async function deleteOrganization(id: string): Promise<void> {
  await apiClient.delete(`/organizations/${id}`);
}

// Hierarchy Views
export async function fetchHierarchies(orgId: string): Promise<HierarchyView[]> {
  const res = await apiClient.get<HierarchyView[]>(`/organizations/${orgId}/hierarchies`);
  return res.data;
}
export async function createHierarchy(orgId: string, hv: Omit<HierarchyView, 'id' | 'organizationId'>): Promise<HierarchyView> {
  const res = await apiClient.post<HierarchyView>(`/organizations/${orgId}/hierarchies`, hv);
  return res.data;
}
export async function deleteHierarchy(orgId: string, hvId: string): Promise<void> {
  await apiClient.delete(`/organizations/${orgId}/hierarchies/${hvId}`);
}

// Networks
export async function fetchNetworks(orgId: string, hvId: string): Promise<Network[]> {
  const res = await apiClient.get<Network[]>(`/organizations/${orgId}/hierarchies/${hvId}/networks`);
  return res.data;
}
export async function createNetwork(orgId: string, hvId: string, network: Omit<Network, 'id' | 'organizationId' | 'hierarchyViewId'>): Promise<Network> {
  const res = await apiClient.post<Network>(`/organizations/${orgId}/hierarchies/${hvId}/networks`, network);
  return res.data;
}
export async function deleteNetwork(orgId: string, hvId: string, networkId: string): Promise<void> {
  await apiClient.delete(`/organizations/${orgId}/hierarchies/${hvId}/networks/${networkId}`);
}

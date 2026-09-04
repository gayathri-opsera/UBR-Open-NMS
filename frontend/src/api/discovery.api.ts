import { apiClient } from './client';

// ── WO-011: Discovery scope intake types and API ─────────────────────────────

export type ScopeEntryType = 'CIDR' | 'IP' | 'SEED';

export interface ScopeEntry {
  type: ScopeEntryType;
  value: string;
  label?: string;
  managementPorts?: number[];
  tags?: string[];
}

export interface DiscoveryRunRequest {
  scope: ScopeEntry[];
}

export interface DiscoveryRunResponse {
  runId: string;
  status: 'CREATED' | 'QUEUED';
  normalizedScope: ScopeEntry[];
  createdBy: string;
  createdAt: string;
  validationSummary: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ScopeValidationError {
  status: string;
  reason: string;
  message: string;
  fieldErrors?: ValidationError[];
}

/**
 * Create a generic discovery run with validated scope (WO-011).
 * @param request Discovery scope entries
 * @returns Created discovery run details
 * @throws ScopeValidationError on validation failure (400)
 */
export async function createDiscoveryRun(request: DiscoveryRunRequest): Promise<DiscoveryRunResponse> {
  const res = await apiClient.post<DiscoveryRunResponse>('/discovery/runs', request);
  return res.data;
}

/**
 * Parse a comma-separated list of IP addresses or CIDRs into scope entries.
 * @param input Comma-separated string like "192.168.1.0/24, 10.0.0.1"
 * @returns Array of scope entries
 */
export function parseScopeInput(input: string): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  const parts = input.split(',').map(s => s.trim()).filter(s => s.length > 0);

  for (const part of parts) {
    if (part.includes('/')) {
      // CIDR notation
      entries.push({ type: 'CIDR', value: part });
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(part)) {
      // IPv4 address
      entries.push({ type: 'IP', value: part });
    } else {
      // Hostname or seed device
      entries.push({ type: 'SEED', value: part });
    }
  }

  return entries;
}

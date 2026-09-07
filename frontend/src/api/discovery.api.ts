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

// ── WO-016: Parallel ICMP sweep progress and scheduling ──────────────────────

/** Sweep progress fields included in a DiscoveryRun detail response (WO-016). */
export interface SweepProgress {
  totalHosts: number;
  hostsScanned: number;
  reachableHosts: number;
  sweepStartedAt?: string;
  sweepCompletedAt?: string;
  sweepDurationMs?: number;
  workerCount?: number;
}

/** Extended discovery run detail with sweep progress (WO-016). */
export interface DiscoveryRunDetail extends DiscoveryRunResponse {
  sweep?: SweepProgress;
  updatedAt?: string;
}

/**
 * Fetch a discovery run by ID, including sweep progress fields (WO-016).
 */
export async function getDiscoveryRun(runId: string): Promise<DiscoveryRunDetail> {
  const res = await apiClient.get<DiscoveryRunDetail>(`/discovery/runs/${runId}`);
  return res.data;
}

// ── WO-017: Discovery schedules ───────────────────────────────────────────────

/** Cron-based schedule for recurring discovery runs (WO-017). */
export interface DiscoverySchedule {
  scheduleId: string;
  name: string;
  cronExpression: string;
  scope: ScopeEntry[];
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface CreateScheduleRequest {
  name: string;
  cronExpression: string;
  scope: ScopeEntry[];
  enabled?: boolean;
}

/**
 * List all discovery schedules for the current tenant (WO-017).
 */
export async function listDiscoverySchedules(): Promise<DiscoverySchedule[]> {
  try {
    const res = await apiClient.get<DiscoverySchedule[] | { schedules: DiscoverySchedule[] }>('/discovery/schedules');
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && 'schedules' in data && Array.isArray(data.schedules)) return data.schedules;
    return [];
  } catch {
    return [];
  }
}

/**
 * Create a new discovery schedule (WO-017).
 */
export async function createSchedule(schedule: CreateScheduleRequest): Promise<DiscoverySchedule> {
  const res = await apiClient.post<DiscoverySchedule>('/discovery/schedules', schedule);
  return res.data;
}

/**
 * Manually trigger an immediate run of an existing discovery schedule (WO-017).
 */
export async function triggerSchedule(scheduleId: string): Promise<DiscoveryRunResponse> {
  const res = await apiClient.post<DiscoveryRunResponse>(`/discovery/schedules/${scheduleId}/trigger`);
  return res.data;
}

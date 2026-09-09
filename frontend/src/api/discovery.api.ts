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

// ── WO-001: SNMP-specific protocol and credential types ───────────────────────

/** SNMP protocol version for a discovery run. */
export type SnmpProtocol = 'SNMP_V1' | 'SNMP_V2C' | 'SNMP_V3';

/**
 * Request payload for creating an SNMP-aware discovery run.
 * Extends the basic scope with SNMP parameters. Community strings
 * are NEVER sent directly — use credentialId to reference a stored credential.
 */
export interface SnmpDiscoveryRunRequest {
  /** One or more CIDR blocks, single IPs, or seed hostnames to scan. */
  scope: ScopeEntry[];
  /** SNMP protocol version (default: SNMP_V2C). */
  protocol?: SnmpProtocol;
  /**
   * Reference ID to a stored SNMP credential (from the credential store).
   * If omitted the backend falls back to the default community "public".
   */
  credentialId?: string;
  /** Per-host SNMP GET timeout in seconds (default: 5). */
  timeoutSeconds?: number;
  /** Number of SNMP retries on timeout (default: 2). Auth failures are never retried). */
  retries?: number;
}

/** Backward-compatible alias for the basic scope-only request (WO-011). */
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

// ── WO-001: Discovery result types ───────────────────────────────────────────

/** ICMP reachability outcome for a single host. */
export type IcmpStatus = 'reachable' | 'unreachable' | 'timeout';

/** SNMP fingerprint outcome for a single host. */
export type SnmpStatus = 'success' | 'auth_failed' | 'timeout' | 'not_attempted' | 'partial';

/** OID-based or sysDescr-based device classification outcome. */
export type ClassificationStatus = 'RECOGNISED' | 'DEFERRED_UNSUPPORTED' | 'CLASSIFICATION_ERROR';

/**
 * Per-host result within a discovery run.
 * Populated after ICMP sweep + port probe + SNMP fingerprinting + classification.
 */
export interface DiscoveryResult {
  /** IPv4 address of the discovered host. */
  ip: string;
  /** ICMP ping result. */
  icmpStatus: IcmpStatus;
  /** SNMP fingerprinting result. */
  snmpStatus: SnmpStatus;
  /** Vendor name derived from sysObjectID or sysDescr heuristics. */
  vendor?: string;
  /** Device model derived from sysObjectID or sysDescr heuristics. */
  model?: string;
  /** Generic device category (ROUTER, SWITCH, FIREWALL, SERVER, UNKNOWN). */
  genericDeviceType?: string;
  /** Normalized sysObjectID from SNMP MIB-II (e.g. .1.3.6.1.4.1.9.1.x). */
  sysObjectID?: string;
  /** Raw sysDescr string from SNMP MIB-II. */
  sysDescr?: string;
  /** Classification outcome from the OID→vendor mapping table. */
  classificationStatus: ClassificationStatus;
  /**
   * Machine-readable reason when classificationStatus is not RECOGNISED.
   * Examples: OID_NOT_IN_RELEASE_SCOPE, INSUFFICIENT_FINGERPRINT_EVIDENCE.
   */
  deferReason?: string;
  /** Opaque correlation ID for tracing this result back to the backend log. */
  correlationId?: string;
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

/** All lifecycle states a discovery run may be in. */
export type DiscoveryRunStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Extended discovery run detail with sweep progress and SNMP metadata.
 * Returned by GET /discovery/runs/:runId.
 */
export interface DiscoveryRunDetail extends DiscoveryRunResponse {
  /** Overrides DiscoveryRunResponse.status with all lifecycle states. */
  status: DiscoveryRunStatus;
  /** Live ICMP sweep progress; present while status is RUNNING. */
  sweep?: SweepProgress;
  /** Timestamp of the last status change. */
  updatedAt?: string;
  /** Human-readable failure reason when status is FAILED. */
  failureReason?: string;
  /** SNMP protocol used for this run. */
  protocol?: SnmpProtocol;
  /** Number of hosts for which SNMP fingerprinting was attempted. */
  snmpAttemptCount?: number;
  /** Number of hosts for which SNMP fingerprinting succeeded. */
  snmpSuccessCount?: number;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Create a generic or SNMP-specific discovery run with validated scope (WO-011, WO-001).
 *
 * Accepts both the basic `DiscoveryRunRequest` and the extended `SnmpDiscoveryRunRequest`.
 * Community strings must NEVER be passed directly; use credentialId.
 *
 * @throws ScopeValidationError on HTTP 400 (validation failure)
 * @throws Error on HTTP 403 (insufficient role) or 5xx (server error)
 */
export async function createDiscoveryRun(
  request: SnmpDiscoveryRunRequest | DiscoveryRunRequest,
): Promise<DiscoveryRunResponse> {
  const res = await apiClient.post<DiscoveryRunResponse>('/discovery/runs', request);
  return res.data;
}

/**
 * Fetch a discovery run by ID, including sweep progress fields (WO-016).
 *
 * Poll every 2 seconds while status === 'RUNNING'.
 */
export async function getDiscoveryRun(runId: string): Promise<DiscoveryRunDetail> {
  const res = await apiClient.get<DiscoveryRunDetail>(`/discovery/runs/${runId}`);
  return res.data;
}

/**
 * Fetch all per-host results for a completed discovery run (WO-001).
 *
 * The backend caps results at 5 000 hosts per run. Filter and sort client-side.
 *
 * @param runId The UUID of the discovery run.
 * @returns Array of per-host discovery results. Empty if run has no results yet.
 * @throws Error on HTTP 404 (run not found), 403 (insufficient role), or 5xx.
 */
export async function getDiscoveryRunResults(runId: string): Promise<DiscoveryResult[]> {
  const res = await apiClient.get<DiscoveryResult[] | { results: DiscoveryResult[] }>(
    `/discovery/runs/${runId}/results`,
  );
  const data = res.data;
  // Normalise: backend may return array directly or wrapped in {results:[...]}
  if (Array.isArray(data)) return data;
  if (data && 'results' in data && Array.isArray(data.results)) return data.results;
  return [];
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
    const res = await apiClient.get<DiscoverySchedule[] | { schedules: DiscoverySchedule[] }>(
      '/discovery/schedules',
    );
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
export async function createSchedule(
  schedule: CreateScheduleRequest,
): Promise<DiscoverySchedule> {
  const res = await apiClient.post<DiscoverySchedule>('/discovery/schedules', schedule);
  return res.data;
}

/**
 * Manually trigger an immediate run of an existing discovery schedule (WO-017).
 */
export async function triggerSchedule(scheduleId: string): Promise<DiscoveryRunResponse> {
  const res = await apiClient.post<DiscoveryRunResponse>(
    `/discovery/schedules/${scheduleId}/trigger`,
  );
  return res.data;
}

// ── Utility: scope input parsing ──────────────────────────────────────────────

/**
 * Parse a comma-separated list of IP addresses or CIDRs into scope entries.
 *
 * Accepts:
 *  - CIDR notation:   "192.168.1.0/24"
 *  - IPv4 address:    "10.0.0.1"
 *  - IP range:        "10.0.0.1-10.0.0.50" → normalised as CIDR type with range label
 *  - Hostname/seed:   "router.example.com"
 *
 * @param input Comma-separated string.
 * @returns Array of scope entries; empty if input is blank.
 */
export function parseScopeInput(input: string): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

  for (const part of parts) {
    if (part.includes('/')) {
      // CIDR notation
      entries.push({ type: 'CIDR', value: part });
    } else if (/^\d+\.\d+\.\d+\.\d+-\d+\.\d+\.\d+\.\d+$/.test(part)) {
      // IP range (e.g. 10.0.0.1-10.0.0.50) — backend normalises to CIDR
      entries.push({ type: 'CIDR', value: part, label: `range:${part}` });
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(part)) {
      // Single IPv4 address
      entries.push({ type: 'IP', value: part });
    } else {
      // Hostname or seed device
      entries.push({ type: 'SEED', value: part });
    }
  }

  return entries;
}

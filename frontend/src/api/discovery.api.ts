import { apiClient } from './client';

// ── WO-008: Multi-mode deterministic discovery probe types ────────────────────

/**
 * Trigger mode — identifies the source that initiated a discovery run.
 * The gateway accepts all five values; MANUAL is the default when absent.
 */
export type TriggerMode =
  | 'MANUAL'
  | 'SCHEDULED'
  | 'EVENT_SNMP_TRAP'
  | 'EVENT_SYSLOG'
  | 'EVENT_DHCP';

/** Protocol used in a single probe attempt. */
export type ProbeType = 'ICMP' | 'SNMP' | 'SSH' | 'HTTP' | 'HTTPS' | 'GRPC_HEALTH';

/** Outcome of a single probe attempt. */
export type ProbeAttemptStatus =
  | 'success'
  | 'timeout'
  | 'unreachable'
  | 'auth_failed'
  | 'skipped'
  | 'failed';

/**
 * Records the outcome of a single protocol probe against one target.
 * Credential material (SNMP community strings, SSH passwords) is NEVER included.
 */
export interface ProbeAttempt {
  /** Protocol used for this probe attempt. */
  probeType:            ProbeType;
  /** Outcome of the probe. */
  status:               ProbeAttemptStatus;
  /** ISO-8601 UTC timestamp when the probe started. */
  startedAt:            string;
  /** ISO-8601 UTC timestamp when the probe completed. */
  completedAt:          string;
  /** Round-trip latency in milliseconds. 0 when the probe failed immediately. */
  latencyMs:            number;
  /** Machine-readable failure category (e.g. TIMEOUT, AUTH_FAILED). Empty on success. */
  failureCategory?:     string;
  /** Human-readable failure message. Never contains credential values. */
  failureReason?:       string;
  /** Credential-free evidence summary (e.g. sysDescr snippet, SSH banner prefix). */
  safeEvidenceSummary?: string;
  /** Whether this probe type should be retried on a subsequent run. */
  retryable:            boolean;
}

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
   * WO-027 will replace direct community input with this field.
   */
  credentialId?: string;
  /**
   * SNMP community string for v1/v2c (Phase 1 — before credential store exists).
   * SECURITY: never logged or stored in plaintext; treated as opaque by the API client.
   * Replaced by credentialId once the credential store is built (WO-027).
   */
  community?: string;
  /** Per-host SNMP GET timeout in seconds (default: 5). */
  timeoutSeconds?: number;
  /** Number of SNMP retries on timeout (default: 2). Auth failures are never retried). */
  retries?: number;
  /** WO-008: Trigger mode. Defaults to MANUAL when absent. */
  triggerMode?: TriggerMode;
  /** WO-008: Caller-supplied correlation ID for end-to-end tracing. */
  correlationId?: string;
}

/** Backward-compatible alias for the basic scope-only request (WO-011). */
export interface DiscoveryRunRequest {
  scope: ScopeEntry[];
  /**
   * WO-008: Trigger mode for multi-mode deterministic probing.
   * Defaults to MANUAL on the backend when absent.
   */
  triggerMode?:   TriggerMode;
  /** WO-008: Caller-supplied correlation ID for end-to-end tracing. */
  correlationId?: string;
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
  /** MIB-II sysName (hostname). WO-016 / WO-026 */
  sysName?: string;
  /** MIB-II sysContact. */
  sysContact?: string;
  /** MIB-II sysLocation. */
  sysLocation?: string;
  /** MIB-II sysUpTime in seconds. */
  sysUpTimeSeconds?: number;
  /**
   * Chassis MAC address retrieved via IF-MIB ifPhysAddress walk (1.3.6.1.2.1.2.2.1.6).
   * Populated only when the discovery scanner successfully walked the interface table.
   * Empty string / undefined when the device doesn't expose IF-MIB or the walk was skipped.
   */
  macAddress?: string;

  // ── WO-010: Framework identity fields (additive, nullable) ─────────────────
  //
  // Populated by the FingerprintMatcher after probe evidence is matched against
  // the active Product Definition registry. Only present when matching was attempted.

  /** Matching outcome: MATCHED, UNKNOWN, CONFLICT, VERSION_MISMATCH, or REGISTRY_UNAVAILABLE. */
  fingerprintStatus?: FingerprintStatus;
  /** Product Definition identifier — set only when fingerprintStatus === 'MATCHED'. */
  productDefinitionId?: string;
  /** Product Definition version that produced the match. */
  productDefinitionVersion?: string;
  /** Registry snapshot version used for this match. */
  registryVersion?: string;
  /** Preferred southbound protocol for this product (e.g. SNMP, SSH). */
  activeAdapterCandidate?: string;
  /**
   * Match confidence score in [0,1]. Higher means stronger evidence.
   * 1.0 = exact SNMP OID match, 0.65 = HTTP body substring match.
   */
  matchConfidence?: number;
  /** Credential-free summary of the matched selector. */
  matchEvidence?: string;
  /** Conflict/mismatch reason — set when fingerprintStatus === 'CONFLICT' or 'VERSION_MISMATCH'. */
  fingerprintConflictReason?: string;
}

/**
 * Fingerprint matching outcome returned alongside each DiscoveryResult.
 * MATCHED — exactly one Product Definition matched with unique evidence.
 * UNKNOWN — no registry entry matched any probe evidence.
 * CONFLICT — two or more definitions matched at equal confidence; no inventory write allowed.
 * VERSION_MISMATCH — OID matched but firmware falls outside the definition's range.
 * REGISTRY_UNAVAILABLE — the registry could not be read; evidence was recorded but not matched.
 */
export type FingerprintStatus =
  | 'MATCHED'
  | 'UNKNOWN'
  | 'CONFLICT'
  | 'VERSION_MISMATCH'
  | 'REGISTRY_UNAVAILABLE';

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
 * Extended discovery run detail with sweep progress, SNMP metadata, and
 * WO-008 multi-mode probe chain fields.
 * Returned by GET /discovery/runs/:runId.
 */
export interface DiscoveryRunDetail extends Omit<DiscoveryRunResponse, 'status'> {
  /** Full lifecycle status (overrides the narrower type on DiscoveryRunResponse). */
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
  // ── WO-008: multi-mode probe fields (absent on legacy runs) ─────────────
  /** Trigger mode that initiated this run (MANUAL, SCHEDULED, EVENT_*). */
  triggerMode?: TriggerMode;
  /** End-to-end correlation identifier for this run. */
  correlationId?: string;
  /** Ordered probe attempt chain across all targets in this run. */
  probeAttempts?: ProbeAttempt[];
  /** Total number of probe attempts recorded. */
  probeAttemptCount?: number;
  /** First probe type that produced usable fingerprint evidence. */
  successfulProbeType?: ProbeType;
  /**
   * ISO-8601 timestamp when this event-driven run should be retried.
   * Present only for EVENT_* trigger modes when the run fails transiently.
   */
  retryAt?: string;
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

/** Rediscovery schedule as returned by the discovery-service (WO-017). */
export interface DiscoverySchedule {
  scheduleId: string;
  /** Baseline scope run this schedule re-scans. */
  scopeRunId: string;
  /** Human-readable label (maps from backend description). */
  name: string;
  cronExpression: string;
  enabled: boolean;
  notifyOnChange?: boolean;
  /** Scope summary from the baseline run (UI-enriched). */
  scopeSummary?: string;
  lastRunId?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateScheduleRequest {
  /** Completed discovery run whose scope is re-scanned on schedule. */
  scopeRunId: string;
  cronExpression: string;
  /** Display name / description for the schedule. */
  name?: string;
  notifyOnChange?: boolean;
}

/**
 * List all discovery schedules for the current tenant (WO-017).
 */
/** Raw schedule shape from discovery-service. */
interface BackendSchedule {
  id: string;
  scopeRunId: string;
  cronExpression: string;
  enabled: boolean;
  notifyOnChange?: boolean;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunId?: string;
}

function mapSchedule(raw: BackendSchedule): DiscoverySchedule {
  return {
    scheduleId: raw.id,
    scopeRunId: raw.scopeRunId,
    name: raw.description || `Schedule ${raw.id.slice(0, 8)}`,
    cronExpression: raw.cronExpression,
    enabled: raw.enabled,
    notifyOnChange: raw.notifyOnChange,
    lastRunId: raw.lastRunId,
    nextRunAt: raw.nextRunAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function listDiscoverySchedules(): Promise<DiscoverySchedule[]> {
  try {
    const res = await apiClient.get<{ schedules: BackendSchedule[] } | BackendSchedule[]>(
      '/discovery/schedules',
    );
    const data = res.data;
    const raw = Array.isArray(data) ? data : data?.schedules ?? [];
    return raw.map(mapSchedule);
  } catch {
    return [];
  }
}

/**
 * Create a new rediscovery schedule (WO-017 / WO-028).
 */
export async function createSchedule(
  schedule: CreateScheduleRequest,
): Promise<DiscoverySchedule> {
  const res = await apiClient.post<BackendSchedule>('/discovery/schedules', {
    scopeRunId: schedule.scopeRunId,
    cronExpression: schedule.cronExpression,
    notifyOnChange: schedule.notifyOnChange ?? true,
    description: schedule.name ?? '',
  });
  return mapSchedule(res.data);
}

/**
 * Delete a rediscovery schedule (WO-028).
 */
export async function deleteSchedule(scheduleId: string): Promise<void> {
  await apiClient.delete(`/discovery/schedules/${scheduleId}`);
}

/**
 * Manually trigger an immediate rediscovery run for a schedule (WO-017).
 */
export async function triggerSchedule(scheduleId: string): Promise<{ currentRunId?: string }> {
  const res = await apiClient.post<{ currentRunId?: string }>(
    `/discovery/schedules/${scheduleId}/run`,
  );
  return res.data;
}

// ── WO-015: Discovery run history list ───────────────────────────────────────

/** Summary row returned by the paginated list endpoint (GET /discovery/runs). */
export interface DiscoveryRunSummary {
  runId: string;
  status: DiscoveryRunStatus;
  /** Comma-separated summary of scope entries, e.g. "192.168.1.0/24, 10.0.0.1" */
  scopeSummary?: string;
  /** ISO-8601 UTC timestamp when the run was created. */
  createdAt: string;
  /** ISO-8601 UTC timestamp when the run reached a terminal state. */
  completedAt?: string;
  /** Number of devices discovered (present when status is COMPLETED). */
  devicesFound?: number;
  /** User or system identity that created the run. */
  createdBy?: string;
  /** Scope entries to allow re-running this scan. */
  normalizedScope?: ScopeEntry[];
}

/** Paginated wrapper for the run list endpoint. */
export interface PaginatedRunsResponse {
  data: DiscoveryRunSummary[];
  pagination: {
    total: number;
    page: number;
    limit: number;
  };
}

/**
 * List past discovery runs with optional pagination and status filter (WO-003 / WO-015).
 *
 * @param page  1-indexed page number (default 1).
 * @param limit Items per page (default 20).
 * @param status Optional filter, e.g. 'COMPLETED', 'FAILED'.
 */
export async function listDiscoveryRuns(
  page = 1,
  limit = 20,
  status?: string,
): Promise<PaginatedRunsResponse> {
  const params: Record<string, string | number> = { page, limit };
  if (status) params.status = status;
  const res = await apiClient.get<PaginatedRunsResponse>('/discovery/runs', { params });
  return res.data;
}

// ── Provisioning: convert discovered hosts into managed inventory devices ─────

/**
 * Maps a `genericDeviceType` string from SNMP discovery to the nearest UBR
 * device type (BTS | CPE | IDU). Falls back to CPE when no mapping exists.
 */
export function mapGenericTypeToDeviceType(generic?: string): 'BTS' | 'CPE' | 'IDU' {
  if (!generic) return 'CPE';
  const g = generic.toUpperCase();
  if (g === 'BTS' || g.includes('BASE') || g.includes('ROUTER')) return 'BTS';
  if (g === 'IDU' || g.includes('IDU')) return 'IDU';
  return 'CPE';
}

/**
 * Derive a provisional serial number from the IP address when SNMP did not
 * return one.  Format: "SNMP-<dotted-IP-with-dashes>" e.g. "SNMP-192-168-1-5".
 */
function deriveSerial(ip: string, sysName?: string): string {
  if (sysName && sysName.trim() && sysName.trim() !== 'N/A') {
    // Use hostname but ensure it conforms to the 8-32 alphanum rule
    const safe = sysName.trim().replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 28);
    if (safe.length >= 4) return `SN-${safe}`;
  }
  return `SNMP-${ip.replace(/\./g, '-')}`;
}

/**
 * Request body for POST /api/v1/discovery/runs/{runId}/provision.
 * Each host entry corresponds to one DiscoveryResult selected by the admin.
 */
export interface ProvisionHostRequest {
  ip: string;
  /** UBR device type chosen by the admin (BTS | CPE | IDU). */
  deviceType: 'BTS' | 'CPE' | 'IDU';
  serialNumber: string;
  macAddress: string;
  networkId?: string;
  vendor?: string;
  model?: string;
  sysName?: string;
  sysLocation?: string;
  sysObjectID?: string;
  sysDescr?: string;
  /** Optional GPS latitude for map placement. */
  latitude?: number;
  /** Optional GPS longitude for map placement. */
  longitude?: number;
}

/** Per-host result returned by the provision endpoint. */
export interface ProvisionHostResult {
  ip: string;
  deviceId: string;
  serialNumber: string;
  status: 'provisioned' | 'failed';
  error?: string;
}

/** Full response from POST /api/v1/discovery/runs/{runId}/provision. */
export interface ProvisionResponse {
  results: ProvisionHostResult[];
  provisioned: number;
  failed: number;
}

/**
 * Provision one or more discovered hosts into the inventory as managed devices.
 *
 * Calls POST /api/v1/discovery/runs/{runId}/provision.  The discovery-service
 * forwards each host to the inventory-service and returns the resulting deviceIds.
 *
 * @param runId   The UUID of the completed discovery run.
 * @param hosts   One or more hosts to provision.
 */
export async function provisionDiscoveredHosts(
  runId: string,
  hosts: ProvisionHostRequest[],
): Promise<ProvisionResponse> {
  const res = await apiClient.post<ProvisionResponse>(
    `/discovery/runs/${runId}/provision`,
    { hosts },
  );
  return res.data;
}

/**
 * Build a ProvisionHostRequest from a DiscoveryResult with admin-provided overrides.
 * Used by the ProvisionDeviceModal to assemble the final payload.
 */
export function buildProvisionRequest(
  result: DiscoveryResult,
  overrides: {
    deviceType: 'BTS' | 'CPE' | 'IDU';
    serialNumber: string;
    macAddress: string;
    networkId?: string;
    latitude?: number;
    longitude?: number;
  },
): ProvisionHostRequest {
  return {
    ip:           result.ip,
    deviceType:   overrides.deviceType,
    serialNumber: overrides.serialNumber || deriveSerial(result.ip, result.sysName),
    macAddress:   overrides.macAddress || '',
    networkId:    overrides.networkId,
    vendor:       result.vendor,
    model:        result.model,
    sysName:      result.sysName,
    sysLocation:  result.sysLocation,
    sysObjectID:  result.sysObjectID,
    sysDescr:     result.sysDescr,
    latitude:     overrides.latitude,
    longitude:    overrides.longitude,
  };
}

// ── Discovery Ignore: suppress unwanted hosts from results ────────────────────

/** A single ignored-host record returned by the ignore list endpoint. */
export interface IgnoredHost {
  ip: string;
  ignoredAt: string;
  ignoredBy: string;
  reason: string;
}

/**
 * Fetch all currently ignored host IPs for the current tenant.
 * Used on mount to pre-populate the ignoredIPs set in the discovery UI.
 */
export async function listIgnoredHosts(): Promise<IgnoredHost[]> {
  try {
    const res = await apiClient.get<IgnoredHost[]>('/discovery/ignore');
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

/**
 * Mark one or more discovered IPs as "ignored".
 * Ignored hosts are suppressed from the discovery results view and are never
 * provisioned into inventory or surfaced on the topology map.
 *
 * @param ips    One or more IPv4 addresses to ignore.
 * @param reason Optional human-readable reason for the audit log.
 */
export async function ignoreDiscoveredHosts(ips: string[], reason?: string): Promise<void> {
  await apiClient.post('/discovery/ignore', { ips, reason: reason ?? '' });
}

/**
 * Remove an IP from the ignore list, making it eligible for provisioning again.
 *
 * @param ip IPv4 address to un-ignore.
 */
export async function unignoreDiscoveredHost(ip: string): Promise<void> {
  await apiClient.delete(`/discovery/ignore/${encodeURIComponent(ip)}`);
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

/**
 * WO-007: TypeScript types for the read-only /api/framework/v1 northbound APIs.
 *
 * These types cover:
 *  - Device framework identity (fingerprint match, definition reference)
 *  - Discovery run results (per-device outcomes)
 *  - Guided failure details (unreachable, unknown, stale, adapter-failed)
 *  - Framework security status (vault health, audit readiness)
 *
 * All types are read-only — no write, provisioning, or activation fields are included.
 * Credential secrets are never present in any response type.
 */

// ── Shared envelope ───────────────────────────────────────────────────────────

export interface FrameworkApiResponse<T> {
  status: 'ok' | 'error';
  data?:  T;
  error?: FrameworkApiError;
}

export interface FrameworkApiError {
  code:          FrameworkErrorCode;
  message:       string;
  details?:      Record<string, unknown>;
  correlationId: string;
}

export type FrameworkErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ACTION'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | string;

/** Paginated list wrapper. */
export interface PaginatedResult<T> {
  items:      T[];
  total?:     number;
  cursor?:    string;    // Opaque cursor for the next page; absent on last page
  hasMore:    boolean;
}

// ── Device Framework Identity ─────────────────────────────────────────────────

/** Status of the framework identity match for a device. */
export type IdentityStatus =
  | 'matched'       // A Product Definition was matched via fingerprint
  | 'unmatched'     // No fingerprint match found
  | 'conflict'      // Multiple fingerprints matched (requires admin resolution)
  | 'stale';        // Matched, but the matched definition has since been superseded

export interface DeviceFrameworkIdentity {
  deviceId:                 string;
  identityStatus:           IdentityStatus;
  productDefinitionId?:     string;
  productDefinitionVersion?: string;
  matchedFingerprintId?:    string;
  /** ISO timestamp of the last successful fingerprint match. */
  matchedAt?:               string;
  /** Actionable guidance when identityStatus is not 'matched'. */
  recommendedAction?:       string;
}

// ── Discovery Run Results ─────────────────────────────────────────────────────

export type DiscoveryResultStatus =
  | 'matched'
  | 'unmatched'
  | 'unreachable'
  | 'probe_failed'
  | 'conflict';

export interface DiscoveryRunResult {
  resultId:        string;
  runId:           string;
  ipAddress:       string;
  hostname?:       string;
  status:          DiscoveryResultStatus;
  /** Matched Product Definition identifier (present when status is 'matched'). */
  productDefinitionId?: string;
  /** OID matched during SNMP probing (present when status is 'matched'). */
  sysObjectId?:    string;
  /** Firmware version observed during probing. */
  firmwareVersion?: string;
  /** Protocols attempted in probe order (e.g. ['icmp', 'snmp_v2c']). */
  protocolsAttempted?: string[];
  /** ISO timestamp when this result was recorded. */
  createdAt:       string;
  /** Actionable failure guidance when status is not 'matched'. */
  failureGuidance?: string;
}

export interface DiscoveryRunResultsResponse {
  runId:  string;
  items:  DiscoveryRunResult[];
  cursor?: string;
  hasMore: boolean;
}

// ── Guided Failure Details ────────────────────────────────────────────────────

export type FailureCategory =
  | 'unreachable'    // Device did not respond to any probe
  | 'unknown'        // Device responded but no fingerprint matched
  | 'adapter_failed' // SPAL adapter returned an error during reads
  | 'stale';         // Parameter values have not been refreshed within the freshness window

export interface GuidedFailure {
  failureId:         string;
  deviceId:          string;
  ipAddress?:        string;
  failureCategory:   FailureCategory;
  /** Last probe protocol that was attempted before failure. */
  lastProtocol?:     string;
  /** ISO timestamp of the most recent failure event. */
  lastFailedAt:      string;
  /** Actionable guidance for operators to resolve the failure. */
  recommendedAction: string;
  /** Additional context (error messages, probe counts) — never includes secrets. */
  details?:          Record<string, unknown>;
}

export interface GuidedFailuresResponse {
  items:   GuidedFailure[];
  cursor?: string;
  hasMore: boolean;
}

// ── Framework Security Status ─────────────────────────────────────────────────

export type VaultStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type TlsStatus   = 'enabled' | 'disabled' | 'partial';

export interface FrameworkSecurityStatus {
  /** Overall status of the credential vault runtime. */
  credentialVaultStatus: VaultStatus;
  /** Encryption algorithm used for stored secrets (e.g. 'AES-256-GCM'). */
  encryptionAlgorithm:   string;
  /** ISO timestamp of the most recent key rotation. */
  lastKeyRotation?:      string;
  /** mTLS / TLS status across service mesh boundaries. */
  tlsStatus:             TlsStatus;
  /** Whether audit event emission is active. */
  auditEnabled:          boolean;
  /** Number of active (non-revoked) credential references. */
  activeCredentialCount: number;
  /** Number of devices currently unreachable (from guided failure aggregation). */
  unreachableCount?:     number;
  /** Number of devices with stale parameter values. */
  staleCount?:           number;
  /** ISO timestamp when this status snapshot was computed. */
  computedAt:            string;
}

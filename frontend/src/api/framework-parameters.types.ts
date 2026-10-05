/**
 * WO-012: TypeScript types for the framework parameter current-value API.
 *
 * These types describe the response shape of:
 *   GET /api/framework/v1/devices/{deviceId}/parameters/current
 *
 * Current-value records are produced by the parameter-poller service and
 * carry freshness metadata, read status, and structured failure details.
 *
 * Credential material is never present in any field of these types.
 * The client must not attempt to derive credential information from any field.
 */

// ── Freshness and read status enumerations ────────────────────────────────────

/**
 * FreshnessState describes whether a polled value is up-to-date.
 *
 * FRESH          — collected within the configured poll interval (×1.5 tolerance).
 * STALE          — collected, but the last success exceeds the staleness threshold.
 * FAILED         — poll has been attempted but never succeeded for this parameter.
 * UNMAPPED       — no read reference exists in the active registry for this parameter.
 * UNKNOWN_DEVICE — the device is not associated with any active Product Definition.
 */
export type FreshnessState =
  | 'FRESH'
  | 'STALE'
  | 'FAILED'
  | 'UNMAPPED'
  | 'UNKNOWN_DEVICE';

/**
 * ParameterReadStatus is the outcome classification of the most recent poll attempt.
 */
export type ParameterReadStatus =
  | 'SUCCESS'
  | 'UNREACHABLE'
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'UNMAPPED'
  | 'NO_SUCH_OBJECT'
  | 'ADAPTER_ERROR'
  | 'REGISTRY_STALE'
  | 'UNKNOWN';

/**
 * PollFailureCategory is the top-level failure classification.
 * Maps to taxonomy constants in the Go parameter-poller service.
 */
export type PollFailureCategory =
  | 'UNREACHABLE'
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'UNMAPPED_PARAMETER'
  | 'ADAPTER_ERROR'
  | 'REGISTRY_STALE'
  | 'UNKNOWN';

// ── Current-value record ──────────────────────────────────────────────────────

/** One row of a table parameter (or the single instance of a scalar). */
export interface ParameterInstance {
  /** SNMP row index ('' for scalars). */
  index: string;
  value: string;
  display: string;
}

/** Outcome of the whole poll for a device. */
export type DevicePollStatus = 'OK' | 'UNREACHABLE' | 'NO_CREDENTIALS' | 'NOT_POLLED';

/**
 * ParameterCurrentValue is a single polled value for one parameter.
 * It is the atomic unit returned in the current-value API response.
 */
export interface ParameterCurrentValue {
  /** Inventory device identifier. */
  deviceId?: string;
  /** Parameter group identifier from the Product Definition. */
  groupId: string;
  /** Stable parameter identifier. */
  parameterId: string;
  /** Human-readable parameter label. */
  label: string;
  /** Declared data type (e.g. "counter", "gauge", "string"). */
  dataType?: string;
  /** Unit string for numeric parameters (e.g. "dBm", "Mbps", "%"). */
  unit?: string;
  /**
   * Raw string representation of the current value.
   * Empty string when the last poll failed with no prior successful value.
   */
  value?: string | null;
  /** Value with enum label resolved; null when no value. */
  display?: string | null;
  /** True when the parameter has several instances (SNMP table). */
  isTable?: boolean;
  /** Per-row instances (tables) or a single instance with index ''. */
  instances?: ParameterInstance[];
  /**
   * Parsed numeric representation of value.
   * Undefined when the value is a string or the poll failed.
   */
  valueNumeric?: number;
  /**
   * Protocol used to collect this value (e.g. "SNMP", "CLI", "REST", "gRPC").
   * Empty when the poll has never succeeded.
   */
  source?: string;
  /** ISO-8601 UTC timestamp of the most recent poll attempt (success or failure). */
  collectedAt?: string | null;
  /** Configured poll interval in seconds for this parameter group. */
  pollIntervalSeconds?: number;
  /** Staleness classification of this value. */
  freshnessState: FreshnessState;
  /** Outcome of the most recent poll attempt. */
  readStatus: ParameterReadStatus;
  /**
   * ISO-8601 UTC timestamp of the last successful value collection.
   * Undefined when the parameter has never been successfully polled.
   */
  lastSuccessAt?: string;
  /** Top-level failure classification when readStatus !== 'SUCCESS'. */
  failureCategory?: PollFailureCategory;
  /**
   * Operator-visible description of the failure.
   * Must never contain credential material.
   */
  failureReason?: string;
  /** Active registry version used to resolve this parameter. */
  registryVersion?: string;
  /** Product Definition identifier that owns this parameter. */
  productDefinitionId?: string;
}

// ── Group and response shapes ─────────────────────────────────────────────────

/** A parameter group as returned by the current-value API. */
export interface ParameterCurrentValueGroup {
  /** Stable group identifier. */
  groupId: string;
  /** Human-readable group label. */
  label: string;
  /** All parameters in this group, including failed and unmapped ones. */
  parameters: ParameterCurrentValue[];
}

/** Success payload for GET /parameters/current. */
export interface ParameterCurrentValueData {
  /** Inventory device identifier. */
  deviceId: string;
  /** Product Definition identifier for the active framework mapping. */
  productDefinitionId: string;
  /** Active registry version. */
  registryVersion: string;
  /** ISO time of the latest poll, null when never polled. */
  collectedAt?: string | null;
  /** Overall poll outcome. */
  pollStatus?: DevicePollStatus;
  /** Operator-visible poll error when pollStatus is not OK. */
  pollError?: string;
  /** Parameter groups with current values. */
  groups: ParameterCurrentValueGroup[];
}

/** Full API response envelope for GET /parameters/current. */
export interface ParameterCurrentValueResponse {
  status: 'ok' | 'error';
  data?: ParameterCurrentValueData;
  error?: ParameterCurrentValueError;
}

/** Error envelope for parameter current-value API failures. */
export interface ParameterCurrentValueError {
  code: ParameterCurrentValueErrorCode;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
}

export type ParameterCurrentValueErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ACTION'
  | 'DEVICE_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | string;

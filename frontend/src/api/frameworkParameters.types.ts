/**
 * WO-006: TypeScript response types for the framework parameter visibility API.
 *
 * These types reflect the filtered response shapes returned by the gateway's
 * server-side role visibility enforcement.  Hidden parameters are absent from
 * all list and template responses — the client must not try to derive role
 * information from presence/absence of parameters.
 *
 * Endpoints:
 *   GET /api/framework/v1/devices/:deviceId/parameter-template
 *   GET /api/framework/v1/devices/:deviceId/parameters
 *   GET /api/framework/v1/devices/:deviceId/parameters/:parameterId
 */

/** Framework role capability levels used in uiVisibleTo allow-lists. */
export type FrameworkCapabilityAlias =
  | 'SuperAdmin' | 'super_admin' | 'admin' | 'framework_admin' | 'system_admin'
  | 'Operator'   | 'operator'   | 'nms_operator' | 'network_engineer' | 'noc_operator'
  | 'ReadOnly'   | 'readonly'   | 'viewer' | 'compliance' | 'auditor' | 'user'
  | string;        // Allow extension for future capability tiers

/** A single parameter entry within a parameter group. */
export interface FrameworkParameter {
  /** Stable identifier referenced by polling configs and alarms. */
  parameterId:   string;
  /** Human-readable label for UI rendering. */
  label:         string;
  /** SNMP OID, REST path, or CLI command that resolves this parameter. */
  oidOrPath?:    string;
  /** Data type for widget auto-selection (e.g. "counter", "gauge", "string"). */
  dataType?:     string;
  /** Unit string for numeric parameters (e.g. "dBm", "Mbps", "%"). */
  unit?:         string;
  /** Optional thresholds for alarm evaluation. */
  thresholds?:   { low?: number; high?: number };
  /**
   * Visibility allow-list.  Present in the upstream Product Definition metadata
   * but intentionally absent from filtered client responses — the gateway strips
   * parameters whose uiVisibleTo the caller's role does not satisfy.
   * Clients MUST NOT rely on this field for authorization decisions.
   */
  uiVisibleTo?:  FrameworkCapabilityAlias | FrameworkCapabilityAlias[] | null;
}

/** A group of related parameters. */
export interface FrameworkParameterGroup {
  /** Stable group identifier. */
  groupId:     string;
  /** Human-readable label for the group. */
  label:       string;
  /** Parameters visible to the caller within this group. Empty groups are omitted by the gateway. */
  parameters:  FrameworkParameter[];
}

/** Response body for GET /parameter-template and GET /parameters. */
export interface FrameworkParameterTemplateResponse {
  status: 'ok' | 'error';
  data?: {
    deviceId:        string;
    /** Only groups containing at least one visible parameter are included. */
    parameterGroups: FrameworkParameterGroup[];
    /** ISO timestamp of the active Product Definition version that produced this template. */
    generatedAt?:    string;
    /** The active Product Definition version ID used to build this template. */
    definitionVersionId?: string;
  };
  error?: FrameworkParameterError;
}

/** Response body for GET /parameters/:parameterId. */
export interface FrameworkSingleParameterResponse {
  status: 'ok' | 'error';
  data?: FrameworkParameter;
  error?: FrameworkParameterError;
}

/** Structured error envelope for framework parameter API failures. */
export interface FrameworkParameterError {
  code:          FrameworkParameterErrorCode;
  message:       string;
  details?:      Record<string, unknown>;
  correlationId: string;
}

export type FrameworkParameterErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ACTION'    // Valid token but insufficient framework capability
  | 'DEVICE_NOT_FOUND'
  | 'PARAMETER_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | string;

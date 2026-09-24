/**
 * WO-014: TypeScript types for the framework adaptive UI template API.
 *
 * These types describe the response shape of:
 *   GET /api/framework/v1/devices/{deviceId}/ui-template
 *
 * The template response drives widget selection, group layout, and role-filtered
 * visibility. Server-side role filtering has already been applied — the client
 * must not attempt to derive or re-apply role information from the response.
 *
 * All types are read-only for P0. Credential material is never present.
 */

// ── Widget types ──────────────────────────────────────────────────────────────

/**
 * Widget type used to render a parameter value.
 * Auto-selected by the server based on dataType, or overridden by uiWidget metadata.
 */
export type UiWidget =
  | 'textfield'   // default for string, IP, MAC, and unrecognised types
  | 'slider'      // numeric with min and max defined
  | 'dropdown'    // enum with defined enumValues
  | 'toggle'      // boolean
  | 'gauge'       // gauge metric (render as read-only gauge display)
  | 'counter'     // counter metric (render as read-only counter display)
  | 'readonly';   // explicitly forced read-only text display

// ── Parameter template types ──────────────────────────────────────────────────

/** Threshold metadata from the Product Definition parameter spec. */
export interface ParameterThresholds {
  /** Value at or above which a threshold-high alarm is raised. */
  high?: number;
  /** Value at or below which a threshold-low alarm is raised. */
  low?: number;
}

/** A single parameter in an adaptive UI template. */
export interface AdaptiveParameter {
  /** Stable parameter identifier. */
  parameterId: string;
  /** Human-readable parameter label. */
  label: string;
  /** Optional description for tooltip/help rendering. */
  description?: string;
  /** Declared data type: "counter", "gauge", "string", "boolean", "enum", "ip", "mac". */
  dataType?: string;
  /** Unit string for numeric parameters (e.g. "dBm", "%", "Mbps"). */
  unit?: string;
  /**
   * True for P0 — all parameters are read-only in the first release.
   * Write widgets must remain disabled until write workflows are enabled.
   */
  readOnly: boolean;
  /** Minimum value for slider widget rendering. Undefined = no minimum. */
  minValue?: number;
  /** Maximum value for slider widget rendering. Undefined = no maximum. */
  maxValue?: number;
  /** Allowed values for dropdown widget rendering. Empty array = no enum. */
  enumValues?: string[];
  /**
   * Widget hint from the Product Definition metadata.
   * When present, overrides the auto-selected widget.
   */
  uiWidget?: UiWidget;
  /**
   * The effective widget to render, after applying:
   *   1. explicit uiWidget override (if valid)
   *   2. auto-selection rules from dataType + min/max/enumValues
   *   3. fallback to 'textfield'
   */
  effectiveWidget: UiWidget;
  /** Threshold metadata for alarm badge rendering. */
  thresholds?: ParameterThresholds;
}

/** A parameter group in an adaptive UI template. */
export interface AdaptiveParameterGroup {
  /** Stable group identifier. */
  groupId: string;
  /** Human-readable group label (used for tab/accordion header). */
  label: string;
  /** Optional icon name for the group tab. */
  icon?: string;
  /**
   * Authorized parameters in this group.
   * Empty groups (after server-side filtering) are absent from the response.
   */
  parameters: AdaptiveParameter[];
}

/** Adapter context attached to the template for failure guidance. */
export interface AdapterContext {
  /** Active southbound adapter protocol (e.g. "SNMP", "CLI", "REST"). */
  activeAdapter?: string;
  /** Protocol that last produced usable evidence. */
  lastSuccessfulProtocol?: string;
  /** Failure category from the most recent failed adapter attempt. */
  lastFailureCategory?: string;
  /** Operator-visible description of the last adapter failure. Never contains credentials. */
  lastFailureReason?: string;
}

/** Success payload for GET /devices/{deviceId}/ui-template. */
export interface AdaptiveUiTemplateData {
  /** Device type / model identifier (e.g. 'CISCO_CATALYST_9300', 'GENERIC'). */
  deviceType?: string;
  deviceId: string;
  productDefinitionId: string;
  registryVersion: string;
  /** ISO-8601 UTC timestamp when this template was generated. */
  renderedAt: string;
  /** Authorized parameter groups. */
  groups: AdaptiveParameterGroup[];
  /** Southbound adapter context for failure guidance. */
  adapterContext?: AdapterContext;
}

/** Full API response envelope for GET /devices/{deviceId}/ui-template. */
export interface AdaptiveUiTemplateResponse {
  status: 'ok' | 'error';
  data?: AdaptiveUiTemplateData;
  error?: AdaptivePanelError;
}

/** Error envelope for adaptive panel API failures. */
export interface AdaptivePanelError {
  code: AdaptivePanelErrorCode;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
}

export type AdaptivePanelErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ACTION'
  | 'DEVICE_NOT_FOUND'
  | 'NO_ACTIVE_FRAMEWORK'    // device has no active Product Definition
  | 'REGISTRY_VERSION_MISMATCH'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | string;

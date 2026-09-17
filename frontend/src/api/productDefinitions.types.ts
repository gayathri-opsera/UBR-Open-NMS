/**
 * TypeScript types for the Product Definition Control Plane (WO-003).
 *
 * These types model the versioned framework API exposed by the Product Definition
 * Service and proxied through the API Gateway.  All types are read-only DTO shapes;
 * no write/provisioning types are included in this story.
 */

// ── Lifecycle states ──────────────────────────────────────────────────────────

/**
 * All possible lifecycle states for a Product Definition version.
 * Matches the canonical states in ProductDefinitionStateMachine (WO-019).
 */
export type LifecycleStatus =
  | 'DRAFT'
  | 'STAGED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'ARCHIVED';

/** Validation outcome for an uploaded definition. */
export type ValidationStatus = 'VALID' | 'INVALID' | 'PENDING';

/** File format of the uploaded Product Definition. */
export type UploadedFormat = 'XML' | 'XLS' | 'JSON';

// ── Summary and version types ─────────────────────────────────────────────────

/**
 * Compact summary of a Product Definition returned by the list endpoint.
 * One row per definition (vendor + model family).
 */
export interface DefinitionSummary {
  definitionId: string;
  name: string;
  vendor: string;
  model: string;
  /** Count of versions in any lifecycle state. */
  versionCount: number;
  /** Lifecycle status of the currently ACTIVE version, if any. */
  activeVersionStatus?: LifecycleStatus;
  /** ID of the currently ACTIVE version, if any. */
  activeVersionId?: string;
  /** Registry version counter at last activation; monotonically increasing. */
  registryVersion?: number;
  updatedAt: string;
}

/**
 * Full version record returned by per-version endpoints.
 */
export interface ProductDefinitionVersion {
  id: string;
  definitionId: string;
  versionId: string;
  name: string;
  vendor: string;
  model: string;
  schemaVersion: string;
  lifecycleStatus: LifecycleStatus;
  validationStatus: ValidationStatus;
  uploadedFormat: UploadedFormat;
  description?: string;
  contentHash: string;
  fingerprintCount?: number;
  parameterGroupCount?: number;
  firmwareRangeMin?: string;
  firmwareRangeMax?: string;
  /** Registry version at the time of activation; null for non-active versions. */
  registryVersion?: number;
  actorUsername?: string;
  correlationId?: string;
  stagedBy?: string;
  stagedAt?: string;
  activatedBy?: string;
  activatedAt?: string;
  supersededAt?: string;
  rolledBackBy?: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Validation report types ───────────────────────────────────────────────────

/** Severity level of a validation finding. */
export type FindingSeverity = 'ERROR' | 'WARNING' | 'INFO';

/**
 * A single validation finding from schema or semantic validation.
 * Groups by field path for structured display.
 */
export interface ValidationFinding {
  /** Dot-notation field path, e.g. "fingerprints[0].oid". */
  field: string;
  severity: FindingSeverity;
  /** Human-readable explanation. */
  message: string;
  /** Machine-readable code for programmatic handling. */
  code?: string;
}

/**
 * Full validation report for a Product Definition version.
 */
export interface ValidationReport {
  definitionId: string;
  versionId: string;
  validationStatus: ValidationStatus;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: ValidationFinding[];
  validatedAt?: string;
  correlationId?: string;
}

// ── Lifecycle action response types ──────────────────────────────────────────

/**
 * Response returned by the stage / activate / rollback endpoints.
 * Includes the updated version record plus the correlation ID for support escalation.
 */
export interface LifecycleActionResult {
  version: ProductDefinitionVersion;
  correlationId: string;
  /** Machine-readable outcome code (e.g. STAGED, ACTIVATED, ROLLED_BACK). */
  outcome?: string;
}

/**
 * Response returned by the activate endpoint; may include conflict details.
 */
export interface ActivationResult extends LifecycleActionResult {
  registryVersion: number;
  /** Conflict details if the activation was rejected (HTTP 409). */
  conflict?: ConflictDetails;
}

/** Details about a conflicting Product Definition version. */
export interface ConflictDetails {
  conflictingDefinitionId: string;
  conflictingVersionId: string;
  reason: string;
  details?: string;
}

// ── Lifecycle history / audit ─────────────────────────────────────────────────

/**
 * Single lifecycle event from the audit history.
 */
export interface LifecycleEvent {
  id: string;
  productDefinitionId: string;
  versionId: string;
  eventType: string;
  actor?: string;
  actorUserId?: string;
  outcome: 'SUCCESS' | 'FAILURE';
  errorCode?: string;
  changeSummary?: string;
  registryVersion?: number;
  correlationId?: string;
  createdAt: string;
}

// ── Structured API error ──────────────────────────────────────────────────────

/**
 * Structured error envelope returned by the framework API on 4xx/5xx responses.
 */
export interface FrameworkApiError {
  status: 'error';
  error: {
    /** Machine-readable error code (e.g. INVALID_LIFECYCLE_TRANSITION, VERSION_NOT_FOUND). */
    code: string;
    message: string;
    details?: string;
    correlationId?: string;
  };
}

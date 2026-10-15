/**
 * TypeScript types for the Descriptor Registry API  (/api/descriptors)
 * Implements the 9-state lifecycle from the Unified NMS Architecture PPT.
 *
 * Security: secret parameters are never included in API responses.
 *           All audit trail values are read-only DTOs.
 */

// ── Lifecycle states (9-state machine) ──────────────────────────────────────

export type DescriptorState =
  | 'Draft'
  | 'Validating'
  | 'Valid'
  | 'Invalid'
  | 'Approved'
  | 'Active'
  | 'Deprecated'
  | 'Retired'
  | 'Purged'
  | 'Deleted'; // transient audit state for deleted drafts

// ── Identity ──────────────────────────────────────────────────────────────────

export interface MatchRule {
  priority: number;
  field:    string;
  op:       'exact' | 'regex' | 'contains' | 'prefix';
  value:    string;
}

export interface DescriptorIdentity {
  vendor:        string;
  productFamily: string;
  model:         string;
  variants:      string[];
  firmwareRange: string;
  matchRules:    MatchRule[];
}

// ── Dependency counts ──────────────────────────────────────────────────────────

export interface DependencyCounts {
  boundDevices:        number;
  preProvisionedDevices: number;
  discoveryRules:      number;
  configProfiles:      number;
  runningJobs:         number;
  openAlarms:          number;
}

// ── Lifecycle audit trail ──────────────────────────────────────────────────────

export interface LifecycleEvent {
  fromState:       DescriptorState | null;
  toState:         DescriptorState;
  actorUserId:     string;
  actorUsername:   string;
  actorRole:       string;
  reason:          string;
  dependencyCounts: DependencyCounts;
  timestamp:       string; // ISO-8601
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationFinding {
  field:    string;
  message:  string;
  path?:    string;
}

// ── Main DescriptorVersion DTO ─────────────────────────────────────────────────

export interface DescriptorVersion {
  _id:                 string;
  productDefinitionId: string;
  version:             string;
  state:               DescriptorState;
  identity:            DescriptorIdentity;
  isDefault:           boolean;
  sourceFormat:        'xml' | 'json' | 'xls' | 'xlsx';
  sourceFilename:      string | null;
  contentHash:         string;
  uploadedByUserId:    string;
  uploadedByUsername:  string;
  approvedByUserId?:   string;
  approvedByUsername?: string;
  approvedAt?:         string;
  validationErrors:    ValidationFinding[];
  validationWarnings:  ValidationFinding[];
  validatedAt?:        string;
  dependency:          DependencyCounts;
  lifecycleHistory:    LifecycleEvent[];
  retiredAt?:          string;
  purgedAt?:           string;
  purgeRetentionDays:  number;
  createdAt:           string;
  updatedAt:           string;
}

// ── List/summary DTO (canonicalJson omitted) ──────────────────────────────────

export type DescriptorSummary = Omit<DescriptorVersion, 'canonicalJson' | 'lifecycleHistory'>;

// ── Dependents response ────────────────────────────────────────────────────────

export interface BoundDeviceRecord {
  deviceId:     string;
  serialNumber: string | null;
  ipAddress:    string | null;
  status:       string;
}

export interface DependentsResponse {
  productDefinitionId: string;
  version:             string;
  state:               DescriptorState;
  counts:              DependencyCounts;
  records: {
    boundDevices: BoundDeviceRecord[];
  };
  detailsUrl: string;
}

// ── Impact report ──────────────────────────────────────────────────────────────

export interface ImpactReport {
  productDefinitionId: string;
  version:             string;
  state:               DescriptorState;
  summary: {
    totalBoundDevices:  number;
    unreachableDevices: number;
    runningJobs:        number;
    openAlarms:         number;
    configProfiles:     number;
  };
  devicesByRegion: Record<string, { total: number; unreachable: number }>;
  unreachableDevices: {
    deviceId:     string;
    serialNumber: string | null;
    ipAddress:    string;
    lastSeenAt:   string;
  }[];
  clearingPaths: {
    action: string;
    label:  string;
    url:    string;
  }[];
}

// ── Validation result ──────────────────────────────────────────────────────────

export interface ValidationResult {
  productDefinitionId: string;
  version:             string;
  state:               DescriptorState;
  isValid:             boolean;
  errors:              ValidationFinding[];
  warnings:            ValidationFinding[];
  validatedAt:         string;
}

// ── Migrate request/result ─────────────────────────────────────────────────────

export interface MigrateResult {
  dryRun:          boolean;
  sourceVersion:   string;
  targetVersion:   string;
  devicesAffected: number;
  parameterDiff?: {
    added:        string[];
    removed:      string[];
    addedCount:   number;
    removedCount: number;
  };
  total?:   number;
  results?: { deviceId: string; success: boolean; error?: string }[];
}

// ── API error envelope ────────────────────────────────────────────────────────

export interface DescriptorApiError {
  status: 'error';
  error: {
    code:       string;
    message:    string;
    dependents?: DependencyCounts;
    nextSteps?:  string[];
    detailsUrl?: string;
    [key: string]: unknown;
  };
}

// ── Upload form values ────────────────────────────────────────────────────────

export interface DescriptorUploadForm {
  productDefinitionId: string;
  version:             string;
  file:                File;
}

// ── Lifecycle action params ────────────────────────────────────────────────────

export interface LifecycleActionParams {
  reason?: string;
}

export interface MigrateParams {
  targetVersion: string;
  dryRun?:       boolean;
  batchSize?:    number;
}

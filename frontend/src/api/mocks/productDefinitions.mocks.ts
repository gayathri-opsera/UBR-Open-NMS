/**
 * Mock fixtures for Product Definition Control Plane API types (WO-003).
 *
 * Used in unit tests (vi.mock) and component development.
 * All data is synthetic — no real credentials, vendor secrets, or PII.
 */
import type {
  DefinitionSummary,
  ProductDefinitionVersion,
  ValidationReport,
  ValidationFinding,
  LifecycleActionResult,
  ActivationResult,
  LifecycleEvent,
  FrameworkApiError,
} from '../productDefinitions.types';

// ── Definition summaries ──────────────────────────────────────────────────────

export const mockDefinitionSummaries: DefinitionSummary[] = [
  {
    definitionId:        'def-001',
    name:                'Ericsson RBS 6120 NMS Definition',
    vendor:              'Ericsson',
    model:               'RBS 6120',
    versionCount:        3,
    activeVersionStatus: 'ACTIVE',
    activeVersionId:     '2.1.0',
    registryVersion:     7,
    updatedAt:           '2026-09-12T08:30:00Z',
  },
  {
    definitionId:        'def-002',
    name:                'Nokia 7210 SAS Definition',
    vendor:              'Nokia',
    model:               '7210 SAS',
    versionCount:        1,
    activeVersionStatus: undefined,
    activeVersionId:     undefined,
    updatedAt:           '2026-09-11T14:22:00Z',
  },
];

// ── Product Definition versions ───────────────────────────────────────────────

/** A DRAFT version that has passed validation and is eligible for staging. */
export const mockVersionDraft: ProductDefinitionVersion = {
  id:                'pdv-001',
  definitionId:      'def-002',
  versionId:         '1.0.0',
  name:              'Nokia 7210 SAS Definition',
  vendor:            'Nokia',
  model:             '7210 SAS',
  schemaVersion:     '1.0',
  lifecycleStatus:   'DRAFT',
  validationStatus:  'VALID',
  uploadedFormat:    'XML',
  description:       'Initial upload — Nokia 7210 SAS SNMP definition v1.0',
  contentHash:       'sha256:abc123def456',
  fingerprintCount:  4,
  parameterGroupCount: 3,
  actorUsername:     'admin@ubrnms.test',
  correlationId:     'corr-0001',
  createdAt:         '2026-09-11T14:22:00Z',
  updatedAt:         '2026-09-11T14:22:00Z',
};

/** A STAGED version ready for activation. */
export const mockVersionStaged: ProductDefinitionVersion = {
  ...mockVersionDraft,
  id:              'pdv-002',
  definitionId:    'def-001',
  versionId:       '2.2.0',
  name:            'Ericsson RBS 6120 NMS Definition',
  vendor:          'Ericsson',
  model:           'RBS 6120',
  lifecycleStatus: 'STAGED',
  stagedBy:        'usr-admin-001',
  stagedAt:        '2026-09-12T09:00:00Z',
  updatedAt:       '2026-09-12T09:00:00Z',
};

/** A currently ACTIVE version with full registry metadata. */
export const mockVersionActive: ProductDefinitionVersion = {
  ...mockVersionDraft,
  id:                  'pdv-003',
  definitionId:        'def-001',
  versionId:           '2.1.0',
  name:                'Ericsson RBS 6120 NMS Definition',
  vendor:              'Ericsson',
  model:               'RBS 6120',
  lifecycleStatus:     'ACTIVE',
  registryVersion:     7,
  activatedBy:         'usr-admin-001',
  activatedAt:         '2026-09-10T12:00:00Z',
  updatedAt:           '2026-09-10T12:00:00Z',
};

/** A SUPERSEDED version (displaced by a newer activation). */
export const mockVersionSuperseded: ProductDefinitionVersion = {
  ...mockVersionActive,
  id:              'pdv-004',
  versionId:       '2.0.0',
  lifecycleStatus: 'SUPERSEDED',
  supersededAt:    '2026-09-10T12:00:00Z',
  updatedAt:       '2026-09-10T12:00:00Z',
};

/** A DRAFT version with INVALID validation status — cannot be staged. */
export const mockVersionInvalidDraft: ProductDefinitionVersion = {
  ...mockVersionDraft,
  id:               'pdv-005',
  definitionId:     'def-003',
  versionId:        '0.9.0',
  lifecycleStatus:  'DRAFT',
  validationStatus: 'INVALID',
  description:      'Upload with schema errors',
  createdAt:        '2026-09-13T10:00:00Z',
  updatedAt:        '2026-09-13T10:00:00Z',
};

// ── Validation reports ────────────────────────────────────────────────────────

export const mockValidFindings: ValidationFinding[] = [
  { field: 'vendor',              severity: 'INFO',    message: 'Vendor name matches known OID namespace.' },
  { field: 'fingerprints[0].oid', severity: 'WARNING', message: 'OID prefix shared with 2 other definitions — confirm uniqueness.' },
];

/** Validation report for a VALID version. */
export const mockValidValidationReport: ValidationReport = {
  definitionId:     'def-002',
  versionId:        '1.0.0',
  validationStatus: 'VALID',
  errorCount:       0,
  warningCount:     1,
  infoCount:        1,
  findings:         mockValidFindings,
  validatedAt:      '2026-09-11T14:22:05Z',
  correlationId:    'corr-0001',
};

/** Validation report for an INVALID version with field errors. */
export const mockInvalidValidationReport: ValidationReport = {
  definitionId:     'def-003',
  versionId:        '0.9.0',
  validationStatus: 'INVALID',
  errorCount:       3,
  warningCount:     1,
  infoCount:        0,
  findings: [
    { field: 'fingerprints',                severity: 'ERROR',   message: 'At least one fingerprint entry is required.', code: 'FINGERPRINT_REQUIRED' },
    { field: 'parameters[0].oid',            severity: 'ERROR',   message: 'OID format invalid — expected dotted integer notation.', code: 'INVALID_OID_FORMAT' },
    { field: 'schemaVersion',               severity: 'ERROR',   message: 'Unrecognised schema version "0.x" — supported: 1.0, 2.0.', code: 'UNSUPPORTED_SCHEMA_VERSION' },
    { field: 'vendor',                      severity: 'WARNING', message: 'Vendor name contains non-ASCII characters.' },
  ],
  validatedAt:   '2026-09-13T10:00:05Z',
  correlationId: 'corr-0005',
};

// ── Lifecycle action results ───────────────────────────────────────────────────

export const mockStageResult: LifecycleActionResult = {
  version:       mockVersionStaged,
  correlationId: 'corr-stage-001',
  outcome:       'STAGED',
};

export const mockActivationResult: ActivationResult = {
  version:         { ...mockVersionStaged, lifecycleStatus: 'ACTIVE', registryVersion: 8 },
  correlationId:   'corr-activate-001',
  outcome:         'ACTIVATED',
  registryVersion: 8,
};

export const mockRollbackResult: LifecycleActionResult = {
  version:       { ...mockVersionSuperseded, lifecycleStatus: 'ACTIVE', registryVersion: 9 },
  correlationId: 'corr-rollback-001',
  outcome:       'ROLLED_BACK',
};

// ── Lifecycle history ─────────────────────────────────────────────────────────

export const mockLifecycleHistory: LifecycleEvent[] = [
  {
    id:                  'evt-001',
    productDefinitionId: 'def-001',
    versionId:           '2.1.0',
    eventType:           'ACTIVATED',
    actor:               'admin@ubrnms.test',
    actorUserId:         'usr-admin-001',
    outcome:             'SUCCESS',
    registryVersion:     7,
    correlationId:       'corr-activate-007',
    createdAt:           '2026-09-10T12:00:00Z',
  },
  {
    id:                  'evt-002',
    productDefinitionId: 'def-001',
    versionId:           '2.0.0',
    eventType:           'SUPERSEDED',
    actor:               'system',
    outcome:             'SUCCESS',
    registryVersion:     7,
    correlationId:       'corr-activate-007',
    createdAt:           '2026-09-10T12:00:01Z',
  },
];

// ── Error fixtures ────────────────────────────────────────────────────────────

/** 409 Conflict — invalid lifecycle transition. */
export const mockTransitionConflictError: FrameworkApiError = {
  status: 'error',
  error: {
    code:          'INVALID_LIFECYCLE_TRANSITION',
    message:       "Transition from 'DRAFT' to 'ACTIVE' is not allowed. Valid next states from 'DRAFT': STAGED, ARCHIVED",
    correlationId: 'corr-err-001',
  },
};

/** 409 Conflict — activation conflict between overlapping definitions. */
export const mockActivationConflictError: FrameworkApiError = {
  status: 'error',
  error: {
    code:          'ACTIVATION_CONFLICT',
    message:       'Activation blocked: OID 1.3.6.1.4.1.9.1.x conflicts with definition def-001 version 2.1.0.',
    details:       'conflictingDefinitionId=def-001, conflictingVersionId=2.1.0',
    correlationId: 'corr-err-002',
  },
};

/** 403 Forbidden — role does not have WRITE permission. */
export const mockForbiddenError: FrameworkApiError = {
  status: 'error',
  error: {
    code:    'FORBIDDEN',
    message: 'Your role does not have write access to Product Definitions.',
  },
};

/** 401 Unauthorized. */
export const mockUnauthorizedError: FrameworkApiError = {
  status: 'error',
  error: {
    code:    'UNAUTHORIZED',
    message: 'Session expired. Please log in again.',
  },
};

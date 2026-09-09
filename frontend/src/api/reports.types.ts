/**
 * Type definitions for WO-065 Release Acceptance and WO-068 CTSO/TSOC Evidence Export
 */

// ── WO-065: Release Acceptance Types ─────────────────────────────────────────

export type ReleaseStatus = 'PASSED' | 'FAILED' | 'BLOCKED';
export type ValidationStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIPPED' | 'BLOCKED';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type FailureCategory = 'P0_VALIDATION_FAILED' | 'MISSING_EVIDENCE' | 'NON_P0_VALIDATION_FAILED' | 'TIMEOUT' | 'BLOCKED';

export interface ReleaseReportRequest {
  releaseCandidate: string;
  scenarioFilter?: string[];
  priorityMapping?: Record<string, Priority>;
}

export interface ValidationResult {
  scenarioName: string;
  requirementCapability: string;
  priority: Priority;
  status: ValidationStatus;
  durationMs: number;
  deviceCount?: number;
  errorMessage?: string;
  failureCategory?: FailureCategory;
  artifactChecksum?: string;
  artifactPath?: string;
}

export interface ReleaseReportResponse {
  runId: string;
  releaseCandidate: string;
  generatedAt: string;
  overallStatus: ReleaseStatus;
  scenarios: ValidationResult[];
  fixtureVersions: Record<string, string>;
  environmentMetadata?: Record<string, unknown>;
  failureSummary?: {
    p0Failures: number;
    p0MissingEvidence: number;
    totalBlocked: number;
  };
}

export interface ReleaseReportStatus {
  reportId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  progress?: number;
  errorMessage?: string;
  overallStatus?: ReleaseStatus;
  scenarios?: ValidationResult[];
  failureSummary?: string;
}

export interface ValidationResultSummary {
  reportId: string;
  releaseCandidate: string;
  overallStatus: ReleaseStatus;
  generatedAt: string;
  scenarioCount: number;
  p0PassRate: number;
}

// ── WO-068: CTSO/TSOC Evidence Types ────────────────────────────────────────

export interface IncidentEvidenceRequest {
  scope: {
    alarmId?: string;
    correlationId?: string;
    incidentRef?: string;
    deviceId?: string;
  };
  from: string; // ISO datetime
  to: string;   // ISO datetime
}

export interface AlarmLifecycleEvent {
  state: 'RAISED' | 'ACKNOWLEDGED' | 'ESCALATED' | 'CLEARED';
  timestamp: string;
  severity?: string;
  acknowledgedBy?: string;
  escalatedTo?: string;
}

export interface AlarmTimelineEntry {
  alarmId: string;
  deviceId?: string;
  alarmType?: string;
  severity?: string;
  correlationId?: string;
  lifecycleEvents: AlarmLifecycleEvent[];
  status?: 'unavailable';
  reason?: string;
}

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  correlationId?: string;
  resourceType?: string;
  status?: 'unavailable';
  reason?: string;
}

export interface AffectedDevice {
  deviceId: string;
  deviceType?: string;
  model?: string;
  networkId?: string;
  status?: string;
  reason?: string;
}

export interface IntegrationMetadata {
  eventId: string;
  deliveryStatus: string;
  destination: string;
  timestamp: string;
  status?: 'unavailable';
  reason?: string;
}

export interface EvidenceCompleteness {
  alarmData: 'complete' | 'unavailable';
  auditData: 'complete' | 'unavailable';
  inventoryData: 'complete' | 'unavailable';
}

export interface IncidentEvidenceData {
  reportType: 'CTSO_TSOC_INCIDENT_EVIDENCE';
  generatedAt: string;
  generatedBy: string;
  lookupCriteria: {
    alarmId?: string;
    correlationId?: string;
    incidentRef?: string;
    deviceId?: string;
    timeRange: {
      from: string;
      to: string;
    };
  };
  alarmTimeline: AlarmTimelineEntry[];
  auditEvents: AuditEvent[];
  affectedDevices: AffectedDevice[];
  integrationMetadata: IntegrationMetadata[];
  evidenceCompleteness: EvidenceCompleteness;
  privacyPolicyVersion: string;
  checksum: string;
}

export interface IncidentEvidenceResponse {
  reportId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  reportType: 'CTSO_TSOC_INCIDENT_EVIDENCE';
  completedAt?: string;
  checksum?: string;
  evidenceCompleteness?: EvidenceCompleteness;
  errorMessage?: string;
  evidence?: IncidentEvidenceData;
}

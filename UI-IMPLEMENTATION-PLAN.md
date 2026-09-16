# UI Implementation Plan: WO-065 & WO-068

## Executive Summary

This document provides the implementation plan for integrating two backend features into the UBR Open NMS frontend:

- **WO-065**: Release Acceptance Report Generation
- **WO-068**: CTSO/TSOC Incident Evidence Export

Both features are backend-complete and require new UI pages, API integration, and navigation updates.

---

## 1. Architecture Overview

### 1.1 Current Frontend Structure
- **Framework**: React 18 + TypeScript + Vite
- **Routing**: React Router with lazy-loaded routes
- **API Layer**: Axios with JWT bearer token authentication
- **UI Version**: V2 interface with role-based access control
- **Component Library**: Custom components (Card, Button, Badge, MetricCard)

### 1.2 Integration Points
```
┌─────────────────────────────────────────────────────────────┐
│ V2 Shell (V2App.tsx)                                        │
│  ├─ Sidebar Navigation (V2Sidebar.tsx)                      │
│  │   └─ Operations Group                                    │
│  │       ├─ Reports (existing)                              │
│  │       ├─ Release Validation (NEW - WO-065)               │
│  │       └─ Compliance Exports (NEW - WO-068)               │
│  └─ Routes                                                   │
│      ├─ /v2/reports (existing - V2ReportsPage)              │
│      ├─ /v2/release-validation (NEW)                        │
│      └─ /v2/compliance (NEW)                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. WO-065: Release Acceptance Report UI

### 2.1 Feature Requirements
- Generate release acceptance reports for test scenarios
- Configure priority mappings (P0/P1/P2/P3)
- Display validation results with pass/fail/blocked status
- Export reports as JSON with checksums
- View historical validation runs
- Visualize P0 validation policy enforcement

### 2.2 New Files

#### 2.2.1 API Layer
**File**: `frontend/src/api/reports.api.ts`
```typescript
import { client } from './client';
import type {
  ReleaseReportRequest,
  ReleaseReportResponse,
  ReleaseReportStatus,
  ValidationResultSummary,
  IncidentEvidenceRequest,
  IncidentEvidenceResponse,
} from './reports.types';

// WO-065: Release Acceptance
export async function requestReleaseReport(req: ReleaseReportRequest): Promise<string> {
  const { data } = await client.post('/api/test-harness/release-acceptance', req);
  return data.reportId;
}

export async function getReleaseReportStatus(reportId: string): Promise<ReleaseReportStatus> {
  const { data } = await client.get(`/api/test-harness/release-acceptance/${reportId}`);
  return data;
}

export async function downloadReleaseReport(reportId: string): Promise<Blob> {
  const { data } = await client.get(`/api/test-harness/release-acceptance/${reportId}/download`, {
    responseType: 'blob',
  });
  return data;
}

export async function listReleaseReports(): Promise<ValidationResultSummary[]> {
  const { data } = await client.get('/api/test-harness/release-acceptance/history');
  return data.reports;
}

// WO-068: CTSO/TSOC Evidence
export async function requestIncidentEvidence(req: IncidentEvidenceRequest): Promise<string> {
  const { data } = await client.post('/api/reports/incident-evidence', req);
  return data.reportId;
}

export async function getIncidentEvidenceStatus(reportId: string): Promise<IncidentEvidenceResponse> {
  const { data } = await client.get(`/api/reports/incident-evidence/${reportId}`);
  return data;
}

export async function downloadIncidentEvidence(reportId: string): Promise<Blob> {
  const { data } = await client.get(`/api/reports/incident-evidence/${reportId}/download`, {
    responseType: 'blob',
  });
  return data;
}
```

**File**: `frontend/src/api/reports.types.ts`
```typescript
// WO-065 Types
export type ReleaseStatus = 'PASSED' | 'FAILED' | 'BLOCKED';
export type ValidationStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIPPED' | 'BLOCKED';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

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
  failureSummary?: {
    p0Failures: number;
    p0MissingEvidence: number;
    totalBlocked: number;
  };
}

export interface ReleaseReportStatus {
  reportId: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  progress?: number;
  data?: ReleaseReportResponse;
}

export interface ValidationResultSummary {
  reportId: string;
  releaseCandidate: string;
  overallStatus: ReleaseStatus;
  generatedAt: string;
  scenarioCount: number;
  p0PassRate: number;
}

// WO-068 Types
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

export interface IncidentEvidenceResponse {
  reportId: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  reportType: 'CTSO_TSOC_INCIDENT_EVIDENCE';
  generatedAt?: string;
  checksum?: string;
  evidenceCompleteness?: {
    alarmData: 'complete' | 'unavailable';
    auditData: 'complete' | 'unavailable';
    inventoryData: 'complete' | 'unavailable';
  };
}
```

#### 2.2.2 Page Component
**File**: `frontend/src/v2/pages/V2ReleaseValidationPage.tsx` (350 lines estimated)

```typescript
import React, { useState, useEffect } from 'react';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Badge } from '../components/common/Badge';
import { useToast } from '../hooks/useToast';
import {
  requestReleaseReport,
  getReleaseReportStatus,
  downloadReleaseReport,
  listReleaseReports,
} from '../../api/reports.api';
import type { ValidationResultSummary, ReleaseReportResponse } from '../../api/reports.types';

export default function V2ReleaseValidationPage() {
  const [activeTab, setActiveTab] = useState<'generate' | 'history'>('generate');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ValidationResultSummary[]>([]);
  const { showToast } = useToast();

  // Form state
  const [releaseCandidate, setReleaseCandidate] = useState('');
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>([]);

  // Poll for report status
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [reportData, setReportData] = useState<ReleaseReportResponse | null>(null);

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
          Release Validation
        </h1>
        <p style={{ fontSize: 14, color: 'var(--vf-text-muted)', marginTop: 8 }}>
          Generate acceptance reports and validate release candidates against test scenarios
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--vf-border-subtle)', marginBottom: 24 }}>
        <TabButton active={activeTab === 'generate'} onClick={() => setActiveTab('generate')}>
          Generate Report
        </TabButton>
        <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
          Validation History
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === 'generate' ? (
        <GenerateReportTab
          releaseCandidate={releaseCandidate}
          setReleaseCandidate={setReleaseCandidate}
          selectedScenarios={selectedScenarios}
          setSelectedScenarios={setSelectedScenarios}
          loading={loading}
          onGenerate={handleGenerate}
          reportData={reportData}
          onDownload={handleDownload}
        />
      ) : (
        <HistoryTab history={history} onView={handleViewReport} />
      )}
    </div>
  );
}
```

**Key Features**:
- **Generate Tab**: Release candidate input, scenario selection, priority mapping, generate button
- **Status Display**: Real-time progress with polling
- **Results View**: Overall status badge, P0 policy summary, scenario table with pass/fail/blocked status
- **Download**: Export JSON with SHA256 checksum
- **History Tab**: List past validation runs with status, timestamp, P0 pass rate

#### 2.2.3 Subcomponents

**File**: `frontend/src/v2/components/reports/ValidationResultTable.tsx` (150 lines)
- Table displaying validation results per scenario
- Columns: Scenario Name, Requirement, Priority, Status, Duration, Device Count
- Expandable rows for error details and artifact paths
- Color-coded status badges (PASS=green, FAIL=red, TIMEOUT=orange, SKIPPED=gray, BLOCKED=yellow)

**File**: `frontend/src/v2/components/reports/ReleaseStatusCard.tsx` (100 lines)
- Overall status card with large badge (PASSED/FAILED/BLOCKED)
- P0 validation policy summary
- Metrics: Total scenarios, P0 pass rate, failure breakdown
- Visual indicator for P0 policy enforcement

---

## 3. WO-068: CTSO/TSOC Evidence Export UI

### 3.1 Feature Requirements
- Request incident evidence by alarm ID, correlation ID, incident ref, or device ID
- Specify time range for evidence collection
- Display evidence completeness indicators
- Export evidence as JSON with SHA256 checksum
- View evidence summary (alarm timeline, audit events, affected devices)
- Show integration metadata when available

### 3.2 New Files

#### 3.2.1 Page Component
**File**: `frontend/src/v2/pages/V2CompliancePage.tsx` (400 lines estimated)

```typescript
import React, { useState, useEffect } from 'react';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Badge } from '../components/common/Badge';
import { useToast } from '../hooks/useToast';
import {
  requestIncidentEvidence,
  getIncidentEvidenceStatus,
  downloadIncidentEvidence,
} from '../../api/reports.api';
import type { IncidentEvidenceRequest, IncidentEvidenceResponse } from '../../api/reports.types';

export default function V2CompliancePage() {
  const [activeTab, setActiveTab] = useState<'request' | 'status'>('request');
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  // Form state
  const [lookupType, setLookupType] = useState<'alarmId' | 'correlationId' | 'incidentRef' | 'deviceId'>('alarmId');
  const [lookupValue, setLookupValue] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Evidence state
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [evidenceData, setEvidenceData] = useState<IncidentEvidenceResponse | null>(null);

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
          Compliance Evidence Export
        </h1>
        <p style={{ fontSize: 14, color: 'var(--vf-text-muted)', marginTop: 8 }}>
          Generate CTSO/TSOC incident evidence packages with privacy-compliant data masking
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--vf-border-subtle)', marginBottom: 24 }}>
        <TabButton active={activeTab === 'request'} onClick={() => setActiveTab('request')}>
          Request Evidence
        </TabButton>
        <TabButton active={activeTab === 'status'} onClick={() => setActiveTab('status')}>
          Evidence Status
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === 'request' ? (
        <RequestEvidenceTab
          lookupType={lookupType}
          setLookupType={setLookupType}
          lookupValue={lookupValue}
          setLookupValue={setLookupValue}
          fromDate={fromDate}
          setFromDate={setFromDate}
          toDate={toDate}
          setToDate={setToDate}
          loading={loading}
          onRequest={handleRequestEvidence}
        />
      ) : (
        <EvidenceStatusTab
          evidenceData={evidenceData}
          onDownload={handleDownload}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
```

**Key Features**:
- **Request Tab**: Lookup criteria selection (alarmId/correlationId/incidentRef/deviceId), time range picker, request button
- **Status Display**: Evidence completeness indicators (alarm data, audit data, inventory data)
- **Summary View**: Expandable sections for alarm timeline, audit events, affected devices, integration metadata
- **Download**: Export JSON with SHA256 checksum verification
- **Privacy Indicator**: Badge showing privacy policy version and masking status

#### 3.2.2 Subcomponents

**File**: `frontend/src/v2/components/compliance/EvidenceCompletenessCard.tsx` (100 lines)
- Card showing completeness status for each evidence section
- Visual indicators: complete (green checkmark), unavailable (yellow warning)
- Reason display for unavailable sections

**File**: `frontend/src/v2/components/compliance/EvidenceSummaryView.tsx` (200 lines)
- Collapsible sections for alarm timeline, audit events, affected devices
- Timeline visualization for alarm lifecycle events
- Audit trail table with actor, action, outcome, timestamp
- Inventory summary table with device details

**File**: `frontend/src/v2/components/compliance/IntegrationMetadataCard.tsx` (80 lines)
- Display northbound integration delivery status
- List of destinations (netcool, etc.) with success/failure status
- Timestamps and correlation IDs

---

## 4. Routing Updates

### 4.1 Add Routes to V2App.tsx

**File**: `frontend/src/v2/V2App.tsx`

Add imports:
```typescript
const V2ReleaseValidationPage = lazy(() => import('./pages/V2ReleaseValidationPage'));
const V2CompliancePage = lazy(() => import('./pages/V2CompliancePage'));
```

Add routes:
```typescript
<Route
  path="/v2/release-validation"
  element={
    <V2ProtectedRoute allowedRoles={['Admin', 'Operator']}>
      <Suspense fallback={<div>Loading...</div>}>
        <V2ReleaseValidationPage />
      </Suspense>
    </V2ProtectedRoute>
  }
/>
<Route
  path="/v2/compliance"
  element={
    <V2ProtectedRoute allowedRoles={['Admin', 'Operator', 'CTSO', 'TSOC']}>
      <Suspense fallback={<div>Loading...</div>}>
        <V2CompliancePage />
      </Suspense>
    </V2ProtectedRoute>
  }
/>
```

---

## 5. Navigation Updates

### 5.1 Add Nav Items to V2Sidebar.tsx

**File**: `frontend/src/v2/components/layout/V2Sidebar.tsx`

Update the Operations group in NAV_GROUPS:
```typescript
{
  label: 'Operations',
  items: [
    { path: '/v2/config',       label: 'Config',       icon: <CogIcon />,    allowedRoles: ['Admin', 'Operator'] as Role[] },
    { path: '/v2/troubleshoot', label: 'Troubleshoot', icon: <WrenchIcon />, allowedRoles: ['Admin', 'Operator'] as Role[] },
    { path: '/v2/reports',      label: 'Reports',      icon: <ReportIcon /> },
    { path: '/v2/release-validation', label: 'Release Validation', icon: <ValidationIcon />, allowedRoles: ['Admin', 'Operator'] as Role[] },  // NEW
    { path: '/v2/compliance',   label: 'Compliance',   icon: <ShieldIcon />, allowedRoles: ['Admin', 'Operator', 'CTSO', 'TSOC'] as Role[] },  // NEW
    { path: '/v2/discovery',    label: 'Discovery',    icon: <DiscoveryIcon /> },
    { path: '/v2/onboarding',   label: 'Onboarding',   icon: <OnboardIcon />, allowedRoles: ['Admin', 'Operator'] as Role[] },
  ],
}
```

Add new icons:
```typescript
function ValidationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="1" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M5 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5L3 3v4c0 3 2 5.5 5 7 3-1.5 5-4 5-7V3l-5-1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M6 7.5l1.5 1.5L10 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
```

---

## 6. Backend API Endpoints Required

### 6.1 Test Harness API (WO-065)
The test harness service needs to expose these endpoints:

```
POST   /api/test-harness/release-acceptance
       Body: { releaseCandidate, scenarioFilter?, priorityMapping? }
       Response: { reportId }

GET    /api/test-harness/release-acceptance/:reportId
       Response: { reportId, status, progress?, data? }

GET    /api/test-harness/release-acceptance/:reportId/download
       Response: JSON blob with Content-Disposition header

GET    /api/test-harness/release-acceptance/history
       Response: { reports: ValidationResultSummary[] }
```

**Implementation Location**: Create new FastAPI endpoints in `test-harness/scenario-runner/src/api.py` or similar.

### 6.2 Report Service API (WO-068)
The report service already has the backend logic. Need to expose HTTP endpoints:

```
POST   /api/reports/incident-evidence
       Body: { scope: { alarmId?, correlationId?, incidentRef?, deviceId? }, from, to }
       Response: { reportId }

GET    /api/reports/incident-evidence/:reportId
       Response: { reportId, status, reportType, generatedAt?, checksum?, evidenceCompleteness? }

GET    /api/reports/incident-evidence/:reportId/download
       Response: JSON blob with Content-Disposition header
```

**Implementation Location**: Extend `services/report-service/src/api.py` or equivalent FastAPI router.

---

## 7. Component Specifications

### 7.1 Common Patterns
All components follow existing V2 patterns:
- **Card** wrapper for content sections
- **Button** with variants (primary, secondary, ghost, danger)
- **Badge** for status indicators (success, warning, danger, info)
- **Loading states** with spinner and disabled controls
- **Toast notifications** for success/error feedback
- **Responsive layout** with max-width constraints

### 7.2 Status Badge Mapping

**Release Validation Status**:
- PASSED → success (green)
- FAILED → danger (red)
- BLOCKED → warning (yellow)

**Validation Status**:
- PASS → success (green)
- FAIL → danger (red)
- TIMEOUT → warning (orange)
- SKIPPED → info (gray)
- BLOCKED → warning (yellow)

**Evidence Completeness**:
- complete → success (green checkmark)
- unavailable → warning (yellow warning icon with reason)

### 7.3 Table Specifications

**Validation Result Table** (WO-065):
- Columns: Scenario Name (200px), Requirement (250px), Priority (80px), Status (100px), Duration (100px), Devices (80px), Actions (80px)
- Sortable by: Priority, Status, Duration
- Expandable rows showing error message and artifact checksum
- Sticky header on scroll

**Evidence Summary Tables** (WO-068):
- Alarm Timeline: AlarmId, Device, Type, Severity, Lifecycle Events (collapsible)
- Audit Events: Timestamp, Actor, Action, Resource, Outcome
- Affected Devices: DeviceId, Type, Model, Network, Status

---

## 8. Implementation Phases

### Phase 1: API Layer (2-3 hours)
1. Create `frontend/src/api/reports.api.ts`
2. Create `frontend/src/api/reports.types.ts`
3. Implement backend HTTP endpoints in test-harness and report-service

### Phase 2: WO-065 UI (4-5 hours)
1. Create `V2ReleaseValidationPage.tsx` with tab structure
2. Implement generate report form with scenario selection
3. Add polling mechanism for report status
4. Create `ValidationResultTable.tsx` component
5. Create `ReleaseStatusCard.tsx` component
6. Implement download with checksum verification
7. Build history view with summary cards

### Phase 3: WO-068 UI (4-5 hours)
1. Create `V2CompliancePage.tsx` with tab structure
2. Implement evidence request form with lookup criteria
3. Add polling mechanism for evidence status
4. Create `EvidenceCompletenessCard.tsx` component
5. Create `EvidenceSummaryView.tsx` with collapsible sections
6. Create `IntegrationMetadataCard.tsx` component
7. Implement download with checksum verification

### Phase 4: Integration (2 hours)
1. Add routes to `V2App.tsx`
2. Add navigation items to `V2Sidebar.tsx`
3. Add new icons (ValidationIcon, ShieldIcon)
4. Test role-based access control

### Phase 5: Testing & Polish (2-3 hours)
1. Test all API integrations
2. Verify polling and status updates
3. Test downloads and checksum verification
4. Validate error handling and toast notifications
5. Test responsive layout
6. Cross-browser testing

**Total Estimated Time**: 14-18 hours

---

## 9. Design Mockups (Text-Based)

### 9.1 Release Validation Page

```
┌────────────────────────────────────────────────────────────────────┐
│ Release Validation                                                 │
│ Generate acceptance reports and validate release candidates        │
├────────────────────────────────────────────────────────────────────┤
│ [Generate Report] [Validation History]                             │
├────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Configuration                                                  │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Release Candidate:  [_________________]                        │ │
│ │ Scenario Filter:    [ ] all [ ] device-onboarding [x] config   │ │
│ │                                                                 │ │
│ │                             [Generate Report]                   │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Release Status                                   [PASSED]      │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Release: v1.0.0-rc1        Generated: 2026-09-07 23:45:00     │ │
│ │                                                                 │ │
│ │ P0 Validation Policy: ✓ All P0 scenarios passed                │ │
│ │                                                                 │ │
│ │ Total Scenarios: 15   P0 Pass Rate: 100%   Failures: 0        │ │
│ │                                                                 │ │
│ │                            [Download Report]                    │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Validation Results                                             │ │
│ ├────────────┬───────────────┬──────┬────────┬──────────┬───────┤ │
│ │ Scenario   │ Requirement   │ Pri  │ Status │ Duration │ Devs  │ │
│ ├────────────┼───────────────┼──────┼────────┼──────────┼───────┤ │
│ │ device-... │ UBR Call-Home │ P0   │ [PASS] │ 1.2s     │ 3     │ │
│ │ config-... │ Config Push   │ P0   │ [PASS] │ 2.5s     │ 5     │ │
│ │ alarm-...  │ Alarm Corr    │ P1   │ [FAIL] │ 0.8s     │ 2     │ │
│ └────────────┴───────────────┴──────┴────────┴──────────┴───────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### 9.2 Compliance Evidence Page

```
┌────────────────────────────────────────────────────────────────────┐
│ Compliance Evidence Export                                         │
│ Generate CTSO/TSOC incident evidence with privacy masking          │
├────────────────────────────────────────────────────────────────────┤
│ [Request Evidence] [Evidence Status]                               │
├────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Evidence Request                                               │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Lookup Type:  ○ Alarm ID  ● Correlation ID  ○ Incident Ref    │ │
│ │               ○ Device ID                                       │ │
│ │                                                                 │ │
│ │ Value:         [CORR-2026-09-07-001_____]                      │ │
│ │                                                                 │ │
│ │ Time Range:    [2026-09-01] to [2026-09-07]                   │ │
│ │                                                                 │ │
│ │                            [Request Evidence]                   │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Evidence Completeness                    Privacy: v1.0         │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ ✓ Alarm Data: complete                                         │ │
│ │ ✓ Audit Data: complete                                         │ │
│ │ ⚠ Inventory Data: unavailable (Devices not found)             │ │
│ │                                                                 │ │
│ │ Checksum: 79c76c49...394359de                [Verify] [Copy]   │ │
│ │                                                                 │ │
│ │                        [Download Evidence Package]              │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Evidence Summary                                  [Expand All]  │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ ▼ Alarm Timeline (3 alarms)                                    │ │
│ │   ALM-001  DEV-001  DEVICE_DOWN  CRITICAL                      │ │
│ │     • RAISED:        2026-09-07 21:00:00                       │ │
│ │     • ACKNOWLEDGED:  2026-09-07 21:30:00 (admin@example.com)  │ │
│ │     • CLEARED:       2026-09-07 22:00:00                       │ │
│ │                                                                 │ │
│ │ ▶ Audit Events (15 events)                                     │ │
│ │ ▶ Affected Devices (5 devices)                                 │ │
│ │ ▶ Integration Metadata (2 deliveries)                          │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

---

## 10. Testing Strategy

### 10.1 Unit Tests
- API client functions (mocked axios responses)
- Component rendering tests
- Form validation logic
- Status badge mapping
- Checksum verification

### 10.2 Integration Tests
- Full report generation flow
- Evidence request and download
- Polling mechanism
- Error handling and retries

### 10.3 E2E Tests
- User navigates to Release Validation, generates report, downloads JSON
- User navigates to Compliance, requests evidence by alarm ID, verifies completeness

### 10.4 Manual Testing Checklist
- [ ] Generate release report with all scenarios
- [ ] Generate release report with P0 failure (verify FAILED status)
- [ ] View validation history
- [ ] Download report and verify SHA256 checksum
- [ ] Request evidence by alarm ID
- [ ] Request evidence by correlation ID
- [ ] Verify evidence completeness indicators
- [ ] Download evidence package and verify checksum
- [ ] Test with unavailable data sections
- [ ] Verify role-based access (CTSO/TSOC for compliance page)
- [ ] Test error scenarios (network failures, invalid inputs)

---

## 11. Documentation Updates

### 11.1 User Documentation
- Add Release Validation guide to user manual
- Add Compliance Evidence Export guide
- Document priority mapping for release validation
- Document evidence lookup criteria and time range selection

### 11.2 Developer Documentation
- Update API documentation with new endpoints
- Document frontend component architecture
- Add examples for backend endpoint implementation

---

## 12. Dependencies & Prerequisites

### 12.1 Backend Requirements
- **Test Harness API**: HTTP server exposing release acceptance endpoints
  - Suggested: FastAPI with async handlers
  - Integration with `test-harness/scenario-runner/src/release_acceptance.py`

- **Report Service API**: HTTP endpoints for incident evidence
  - Already has async logic in `services/report-service/src/report_service.py`
  - Need to add FastAPI routes

### 12.2 Frontend Requirements
- No new npm dependencies required (all UI components exist)
- TypeScript 5.x
- React Router 6.x
- Axios (already in use)

### 12.3 Environment Variables
- `VITE_API_BASE_URL`: Backend API base URL
- `VITE_TEST_HARNESS_URL`: Test harness service URL (if separate)

---

## 13. Security Considerations

### 13.1 Authentication
- All endpoints require JWT bearer token
- Role-based access control enforced on routes
- Compliance page restricted to Admin, Operator, CTSO, TSOC roles

### 13.2 Data Privacy (WO-068)
- Evidence packages automatically mask sensitive fields
- Privacy policy version displayed in UI
- Checksum verification prevents tampering
- Audit trail for evidence downloads

### 13.3 Input Validation
- Form inputs sanitized before API calls
- Time range validation (from < to)
- Lookup criteria validation (at least one field required)

---

## 14. Performance Considerations

### 14.1 Polling Strategy
- Initial poll: 1 second after request
- Subsequent polls: 2-second intervals
- Max polls: 60 (2 minutes timeout)
- Cancel polling on component unmount

### 14.2 Data Loading
- Lazy-load report history (pagination if needed)
- Virtualized tables for large result sets
- Progressive loading for evidence summary sections

### 14.3 Download Optimization
- Stream large JSON files directly
- Use blob URLs for download links
- Cleanup blob URLs after download

---

## 15. Rollout Plan

### Phase 1: Backend Deployment
1. Deploy test harness API endpoints
2. Deploy report service API endpoints
3. Verify endpoints with curl/Postman

### Phase 2: Frontend Development
1. Implement API layer
2. Build WO-065 UI
3. Build WO-068 UI
4. Add routing and navigation

### Phase 3: Testing
1. Internal QA testing
2. User acceptance testing with CTSO/TSOC teams
3. Bug fixes and polish

### Phase 4: Production Release
1. Merge to main branch
2. Deploy frontend
3. Update user documentation
4. Announce new features

---

## 16. Future Enhancements

### 16.1 WO-065 Enhancements
- Scheduled release validation runs
- Email notifications for validation results
- Trend analysis across release candidates
- Customizable priority mappings per environment

### 16.2 WO-068 Enhancements
- Batch evidence export for multiple incidents
- Evidence package comparison/diff view
- Automated evidence submission to external systems (Netcool)
- Evidence retention policy enforcement

---

## Appendix A: File Checklist

### New Files to Create
- [ ] `frontend/src/api/reports.api.ts`
- [ ] `frontend/src/api/reports.types.ts`
- [ ] `frontend/src/v2/pages/V2ReleaseValidationPage.tsx`
- [ ] `frontend/src/v2/pages/V2CompliancePage.tsx`
- [ ] `frontend/src/v2/components/reports/ValidationResultTable.tsx`
- [ ] `frontend/src/v2/components/reports/ReleaseStatusCard.tsx`
- [ ] `frontend/src/v2/components/compliance/EvidenceCompletenessCard.tsx`
- [ ] `frontend/src/v2/components/compliance/EvidenceSummaryView.tsx`
- [ ] `frontend/src/v2/components/compliance/IntegrationMetadataCard.tsx`
- [ ] Backend: Test harness API endpoints (Python/FastAPI)
- [ ] Backend: Report service API endpoints (Python/FastAPI)

### Files to Modify
- [ ] `frontend/src/v2/V2App.tsx` (add routes)
- [ ] `frontend/src/v2/components/layout/V2Sidebar.tsx` (add nav items + icons)

---

## Appendix B: API Contract Examples

### Example: Request Release Report
```bash
POST /api/test-harness/release-acceptance
Content-Type: application/json

{
  "releaseCandidate": "v1.0.0-rc1",
  "scenarioFilter": ["device-onboarding", "config-push"],
  "priorityMapping": {
    "device-onboarding": "P0",
    "config-push": "P0"
  }
}

Response 202 Accepted:
{
  "reportId": "123e4567-e89b-12d3-a456-426614174000"
}
```

### Example: Get Release Report Status
```bash
GET /api/test-harness/release-acceptance/123e4567-e89b-12d3-a456-426614174000

Response 200 OK:
{
  "reportId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "DONE",
  "data": {
    "runId": "test-run-001",
    "releaseCandidate": "v1.0.0-rc1",
    "generatedAt": "2026-09-07T23:45:00Z",
    "overallStatus": "PASSED",
    "scenarios": [...],
    "fixtureVersions": {...},
    "failureSummary": null
  }
}
```

### Example: Request Incident Evidence
```bash
POST /api/reports/incident-evidence
Content-Type: application/json

{
  "scope": {
    "correlationId": "CORR-2026-09-07-001"
  },
  "from": "2026-09-01T00:00:00Z",
  "to": "2026-09-07T23:59:59Z"
}

Response 202 Accepted:
{
  "reportId": "evidence-123e4567"
}
```

---

## Summary

This implementation plan provides a complete roadmap for integrating WO-065 (Release Acceptance Report) and WO-068 (CTSO/TSOC Evidence Export) into the UBR Open NMS frontend. The plan follows existing architectural patterns, reuses components where possible, and ensures role-based access control and security best practices.

**Next Steps**:
1. Review and approve this plan
2. Create backend API endpoints (test-harness and report-service)
3. Implement frontend following Phase 1-5 timeline
4. Test and deploy

**Estimated Total Effort**: 14-18 hours frontend + 4-6 hours backend = 18-24 hours total

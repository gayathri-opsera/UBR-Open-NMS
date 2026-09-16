/**
 * API apiClient for WO-065 Release Acceptance and WO-068 CTSO/TSOC Evidence Export
 */

import { apiClient } from './client';
import type {
  ReleaseReportRequest,
  ReleaseReportResponse,
  ReleaseReportStatus,
  ValidationResultSummary,
  IncidentEvidenceRequest,
  IncidentEvidenceResponse,
} from './reports.types';

// ── WO-065: Release Acceptance ───────────────────────────────────────────────

export async function requestReleaseReport(req: ReleaseReportRequest): Promise<string> {
  const { data } = await apiClient.post('/test-harness/release-acceptance', req);
  return data.reportId;
}

export async function getReleaseReportStatus(reportId: string): Promise<ReleaseReportStatus> {
  const { data } = await apiClient.get(`/test-harness/release-acceptance/${reportId}`);
  return data;
}

export async function downloadReleaseReport(reportId: string): Promise<Blob> {
  const { data } = await apiClient.get(`/test-harness/release-acceptance/${reportId}/download`, {
    responseType: 'blob',
  });
  return data;
}

export async function listReleaseReports(): Promise<ValidationResultSummary[]> {
  const { data } = await apiClient.get('/test-harness/release-acceptance/history');
  return data.reports || [];
}

// ── WO-068: CTSO/TSOC Evidence ───────────────────────────────────────────────

export async function requestIncidentEvidence(req: IncidentEvidenceRequest): Promise<string> {
  const { data } = await apiClient.post('/reports/incident-evidence', req);
  return data.reportId;
}

export async function getIncidentEvidenceStatus(reportId: string): Promise<IncidentEvidenceResponse> {
  const { data } = await apiClient.get(`/reports/incident-evidence/${reportId}`);
  return data;
}

export async function downloadIncidentEvidence(reportId: string): Promise<Blob> {
  const { data } = await apiClient.get(`/reports/incident-evidence/${reportId}/download`, {
    responseType: 'blob',
  });
  return data;
}

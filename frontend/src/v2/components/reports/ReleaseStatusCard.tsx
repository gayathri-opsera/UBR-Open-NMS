/**
 * Release Status Card for WO-065 Release Acceptance
 * Displays overall release status with P0 policy summary
 */

import React from 'react';
import { Badge } from '../common/Badge';
import type { ReleaseStatus, ReleaseReportResponse } from '../../../api/reports.types';

export interface ReleaseStatusCardProps {
  data: ReleaseReportResponse;
}

const statusVariantMap: Record<ReleaseStatus, 'success' | 'danger' | 'warning'> = {
  PASSED: 'success',
  FAILED: 'danger',
  BLOCKED: 'warning',
};

const statusIconMap: Record<ReleaseStatus, string> = {
  PASSED: '✓',
  FAILED: '✕',
  BLOCKED: '⚠',
};

export function ReleaseStatusCard({ data }: ReleaseStatusCardProps) {
  const p0Results = data.scenarios.filter((s) => s.priority === 'P0');
  const p0Passed = p0Results.filter((s) => s.status === 'PASS').length;
  const p0Total = p0Results.length;
  const p0PassRate = p0Total > 0 ? Math.round((p0Passed / p0Total) * 100) : 0;

  const totalScenarios = data.scenarios.length;
  const failedCount = data.scenarios.filter((s) => s.status === 'FAIL').length;

  const p0PolicyPassed = data.overallStatus === 'PASSED';

  return (
    <div
      style={{
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)',
        padding: 24,
        boxShadow: 'var(--vf-shadow-low)',
      }}
    >
      {/* Header with Status Badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Release Status
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
            {data.releaseCandidate}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Badge
            variant={statusVariantMap[data.overallStatus]}
            style={{
              fontSize: 16,
              fontWeight: 700,
              padding: '8px 20px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 18 }}>{statusIconMap[data.overallStatus]}</span>
            {data.overallStatus}
          </Badge>
        </div>
      </div>

      {/* Metadata */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid var(--vf-border-subtle)' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Generated</div>
          <div style={{ fontSize: 13, color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)' }}>
            {new Date(data.generatedAt).toLocaleString()}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4 }}>Run ID</div>
          <div style={{ fontSize: 13, color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)' }}>
            {data.runId}
          </div>
        </div>
      </div>

      {/* P0 Validation Policy */}
      <div
        style={{
          background: p0PolicyPassed ? 'var(--vf-success-subtle)' : 'var(--vf-danger-subtle)',
          border: `1px solid ${p0PolicyPassed ? 'var(--vf-success)' : 'var(--vf-danger)'}`,
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>{p0PolicyPassed ? '✓' : '✕'}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
              P0 Validation Policy
            </div>
            <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 2 }}>
              {p0PolicyPassed
                ? 'All P0 scenarios passed'
                : 'One or more P0 scenarios failed or missing evidence'}
            </div>
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <MetricBox label="Total Scenarios" value={totalScenarios} />
        <MetricBox label="P0 Pass Rate" value={`${p0PassRate}%`} />
        <MetricBox label="Failures" value={failedCount} variant={failedCount > 0 ? 'danger' : 'success'} />
      </div>

      {/* Failure Summary */}
      {data.failureSummary && (data.failureSummary.p0Failures > 0 || data.failureSummary.p0MissingEvidence > 0) && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: 'var(--vf-danger-bg)', borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-danger)', marginBottom: 6 }}>
            Failure Breakdown
          </div>
          <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', lineHeight: 1.6 }}>
            {data.failureSummary.p0Failures > 0 && (
              <div>• P0 Validation Failures: {data.failureSummary.p0Failures}</div>
            )}
            {data.failureSummary.p0MissingEvidence > 0 && (
              <div>• P0 Missing Evidence: {data.failureSummary.p0MissingEvidence}</div>
            )}
            {data.failureSummary.totalBlocked > 0 && (
              <div>• Blocked Scenarios: {data.failureSummary.totalBlocked}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricBox({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string | number;
  variant?: 'default' | 'success' | 'danger';
}) {
  const colorMap = {
    default: 'var(--vf-text-primary)',
    success: 'var(--vf-success)',
    danger: 'var(--vf-danger)',
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: colorMap[variant] }}>{value}</div>
    </div>
  );
}

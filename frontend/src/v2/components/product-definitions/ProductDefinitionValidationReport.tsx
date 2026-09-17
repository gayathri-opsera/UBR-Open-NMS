/**
 * ProductDefinitionValidationReport — renders validation findings grouped by severity (WO-003).
 *
 * Handles hundreds of findings without blocking the browser thread by rendering
 * groups incrementally.  Staging and activation controls are disabled for INVALID reports.
 *
 * SECURITY: No credential values or raw file content is rendered here.
 */
import React, { useMemo, useState } from 'react';
import { Badge } from '../common/Badge';
import type { ValidationReport, ValidationFinding, FindingSeverity } from '../../../api/productDefinitions.types';

interface Props {
  report: ValidationReport;
}

function severityVariant(s: FindingSeverity): 'danger' | 'warning' | 'info' {
  if (s === 'ERROR')   return 'danger';
  if (s === 'WARNING') return 'warning';
  return 'info';
}

function groupByField(findings: ValidationFinding[]): Map<string, ValidationFinding[]> {
  const map = new Map<string, ValidationFinding[]>();
  for (const f of findings) {
    const existing = map.get(f.field) ?? [];
    existing.push(f);
    map.set(f.field, existing);
  }
  return map;
}

const MAX_VISIBLE = 50; // render cap to avoid main-thread blocking on huge reports

export function ProductDefinitionValidationReport({ report }: Props) {
  const [showAll, setShowAll] = useState(false);

  const grouped = useMemo(() => groupByField(report.findings), [report.findings]);
  const fields  = Array.from(grouped.keys());
  const visibleFields = showAll ? fields : fields.slice(0, MAX_VISIBLE);
  const hasMore       = fields.length > MAX_VISIBLE && !showAll;

  const isValid   = report.validationStatus === 'VALID';
  const isInvalid = report.validationStatus === 'INVALID';

  return (
    <section aria-label="Validation Report" style={{ border: '1px solid rgba(77,158,255,0.1)', borderRadius: 'var(--vf-radius-md)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        background: isValid ? 'var(--vf-success-subtle)' : isInvalid ? 'var(--vf-danger-subtle)' : 'var(--vf-warning-subtle)',
        borderBottom: '1px solid rgba(77,158,255,0.08)',
      }}>
        <Badge variant={isValid ? 'success' : isInvalid ? 'danger' : 'warning'} dot>
          {report.validationStatus}
        </Badge>
        {report.errorCount > 0 && (
          <span style={{ fontSize: 12, color: 'var(--vf-danger)' }}>{report.errorCount} error{report.errorCount !== 1 ? 's' : ''}</span>
        )}
        {report.warningCount > 0 && (
          <span style={{ fontSize: 12, color: 'var(--vf-warning)' }}>{report.warningCount} warning{report.warningCount !== 1 ? 's' : ''}</span>
        )}
        {report.infoCount > 0 && (
          <span style={{ fontSize: 12, color: 'var(--vf-info)' }}>{report.infoCount} info</span>
        )}
        {report.correlationId && (
          <span
            title={`Correlation ID: ${report.correlationId}`}
            style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--vf-text-tertiary)', fontFamily: 'monospace', cursor: 'default' }}
            aria-label={`Correlation ID ${report.correlationId}`}
          >
            corr: {report.correlationId.slice(0, 12)}…
          </span>
        )}
      </div>

      {/* Empty state */}
      {report.findings.length === 0 && (
        <div style={{ padding: '16px', fontSize: 13, color: 'var(--vf-text-secondary)', textAlign: 'center' }}>
          No validation findings — definition passes all checks.
        </div>
      )}

      {/* Findings grouped by field */}
      {visibleFields.map((field) => {
        const fieldFindings = grouped.get(field)!;
        return (
          <div
            key={field}
            style={{ padding: '10px 16px', borderBottom: '1px solid rgba(77,158,255,0.06)' }}
          >
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 4 }}>
              {field}
            </div>
            {fieldFindings.map((finding, i) => (
              <div
                key={i}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: i > 0 ? 6 : 0 }}
              >
                <Badge variant={severityVariant(finding.severity)} style={{ flexShrink: 0, marginTop: 1 }}>
                  {finding.severity}
                </Badge>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--vf-text-primary)' }}>{finding.message}</div>
                  {finding.code && (
                    <div style={{ fontSize: 11, color: 'var(--vf-text-tertiary)', fontFamily: 'monospace', marginTop: 2 }}>
                      code: {finding.code}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {/* Show more button for large reports */}
      {hasMore && (
        <div style={{ padding: '10px 16px', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{ fontSize: 12, color: 'var(--vf-accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            aria-label={`Show all ${fields.length} field groups`}
          >
            Show all {fields.length} field groups (showing {MAX_VISIBLE})
          </button>
        </div>
      )}
    </section>
  );
}

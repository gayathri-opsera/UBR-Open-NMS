/**
 * Validation Result Table for WO-065 Release Acceptance
 * Displays scenario validation results with expandable error details
 */

import React, { useState } from 'react';
import { Badge } from '../common/Badge';
import type { ValidationResult, ValidationStatus } from '../../../api/reports.types';

export interface ValidationResultTableProps {
  results: ValidationResult[];
}

const statusVariantMap: Record<ValidationStatus, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  PASS: 'success',
  FAIL: 'danger',
  TIMEOUT: 'warning',
  SKIPPED: 'info',
  BLOCKED: 'warning',
};

const priorityColorMap: Record<string, string> = {
  P0: '#ef4444',
  P1: '#fb923c',
  P2: '#fbbf24',
  P3: '#94a3b8',
};

export function ValidationResultTable({ results }: ValidationResultTableProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const toggleRow = (scenarioName: string) => {
    setExpandedRow(expandedRow === scenarioName ? null : scenarioName);
  };

  if (results.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--vf-text-muted)' }}>
        No validation results available
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
            <th style={headerStyle}>Scenario</th>
            <th style={headerStyle}>Requirement</th>
            <th style={headerStyle}>Priority</th>
            <th style={headerStyle}>Status</th>
            <th style={headerStyle}>Duration</th>
            <th style={headerStyle}>Devices</th>
            <th style={headerStyle}></th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const isExpanded = expandedRow === result.scenarioName;
            const hasDetails = result.errorMessage || result.artifactPath;

            return (
              <React.Fragment key={result.scenarioName}>
                <tr
                  style={{
                    borderBottom: '1px solid var(--vf-border-subtle)',
                    background: isExpanded ? 'var(--vf-elevated)' : 'transparent',
                    cursor: hasDetails ? 'pointer' : 'default',
                  }}
                  onClick={() => hasDetails && toggleRow(result.scenarioName)}
                >
                  <td style={cellStyle}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{result.scenarioName}</span>
                  </td>
                  <td style={cellStyle}>
                    <span style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>
                      {result.requirementCapability}
                    </span>
                  </td>
                  <td style={cellStyle}>
                    <Badge
                      variant="default"
                      style={{
                        color: priorityColorMap[result.priority],
                        background: `${priorityColorMap[result.priority]}22`,
                        border: `1px solid ${priorityColorMap[result.priority]}44`,
                      }}
                    >
                      {result.priority}
                    </Badge>
                  </td>
                  <td style={cellStyle}>
                    <Badge variant={statusVariantMap[result.status]}>{result.status}</Badge>
                  </td>
                  <td style={cellStyle}>
                    <span style={{ fontSize: 13, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)' }}>
                      {(result.durationMs / 1000).toFixed(2)}s
                    </span>
                  </td>
                  <td style={cellStyle}>
                    <span style={{ fontSize: 13, color: 'var(--vf-text-muted)' }}>
                      {result.deviceCount ?? '-'}
                    </span>
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'center' }}>
                    {hasDetails && (
                      <span style={{ fontSize: 11, color: 'var(--vf-accent)' }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    )}
                  </td>
                </tr>
                {isExpanded && hasDetails && (
                  <tr>
                    <td colSpan={7} style={{ padding: '12px 16px', background: 'var(--vf-canvas)' }}>
                      {result.errorMessage && (
                        <div style={{ marginBottom: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            Error Message
                          </span>
                          <div style={{ marginTop: 4, padding: '8px 12px', background: 'var(--vf-danger-subtle)', borderLeft: '3px solid var(--vf-danger)', borderRadius: 4, fontSize: 13, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)' }}>
                            {result.errorMessage}
                          </div>
                        </div>
                      )}
                      {result.artifactPath && (
                        <div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            Artifact
                          </span>
                          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--vf-text-secondary)' }}>
                            Path: <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>{result.artifactPath}</span>
                            {result.artifactChecksum && (
                              <span style={{ marginLeft: 12, color: 'var(--vf-text-muted)' }}>
                                Checksum: <span style={{ fontFamily: 'var(--vf-font-mono)' }}>{result.artifactChecksum.slice(0, 16)}...</span>
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--vf-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const cellStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 13,
  color: 'var(--vf-text-primary)',
};

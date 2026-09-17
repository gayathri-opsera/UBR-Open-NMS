/**
 * ProductDefinitionVersionList — tabular list of Product Definition versions (WO-003).
 *
 * Displays vendor name, product family, model, firmware range, validation status,
 * lifecycle status, fingerprint count, parameter count, registryVersion (active),
 * updated time, and last actor.
 *
 * SECURITY: No credential values, raw file content, or secret-looking strings are rendered.
 */
import React from 'react';
import { Badge } from '../common/Badge';
import type { BadgeVariant } from '../common/Badge';
import type { ProductDefinitionVersion, LifecycleStatus, ValidationStatus } from '../../../api/productDefinitions.types';

interface Props {
  versions: ProductDefinitionVersion[];
  selectedVersionId?: string;
  onSelect: (version: ProductDefinitionVersion) => void;
  loading?: boolean;
  emptyMessage?: string;
}

function lifecycleVariant(status: LifecycleStatus): BadgeVariant {
  switch (status) {
    case 'ACTIVE':     return 'success';
    case 'STAGED':     return 'info';
    case 'DRAFT':      return 'default';
    case 'SUPERSEDED': return 'warning';
    case 'ARCHIVED':   return 'danger';
    default:           return 'default';
  }
}

function validationVariant(status: ValidationStatus): BadgeVariant {
  switch (status) {
    case 'VALID':   return 'success';
    case 'INVALID': return 'danger';
    default:        return 'warning';
  }
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

const COL: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 13,
  borderBottom: '1px solid rgba(77,158,255,0.06)',
  color: 'var(--vf-text-primary)',
  whiteSpace: 'nowrap',
};

const HEADER: React.CSSProperties = {
  ...COL,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--vf-text-secondary)',
  background: 'var(--vf-elevated)',
  borderBottom: '2px solid rgba(77,158,255,0.1)',
};

export function ProductDefinitionVersionList({
  versions,
  selectedVersionId,
  onSelect,
  loading = false,
  emptyMessage = 'No versions found.',
}: Props) {
  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading versions"
        style={{ padding: 24, textAlign: 'center', color: 'var(--vf-text-secondary)', fontSize: 13 }}
      >
        Loading…
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div
        aria-label="Empty version list"
        style={{ padding: 24, textAlign: 'center', color: 'var(--vf-text-secondary)', fontSize: 13 }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
        aria-label="Product Definition versions"
      >
        <thead>
          <tr>
            <th style={HEADER}>Version</th>
            <th style={HEADER}>Vendor</th>
            <th style={HEADER}>Model</th>
            <th style={HEADER}>Format</th>
            <th style={HEADER}>Validation</th>
            <th style={HEADER}>Lifecycle</th>
            <th style={HEADER}>Fingerprints</th>
            <th style={HEADER}>Param Groups</th>
            <th style={HEADER}>Registry Ver.</th>
            <th style={HEADER}>Updated</th>
            <th style={HEADER}>Last Actor</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const isSelected = v.versionId === selectedVersionId;
            return (
              <tr
                key={v.id}
                onClick={() => onSelect(v)}
                style={{
                  cursor: 'pointer',
                  background: isSelected ? 'var(--vf-accent-subtle)' : undefined,
                  outline: isSelected ? '1px solid var(--vf-accent)' : undefined,
                }}
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(v); } }}
              >
                <td style={{ ...COL, fontFamily: 'monospace', fontWeight: 600 }}>{v.versionId}</td>
                <td style={COL}>{v.vendor || '—'}</td>
                <td style={COL}>{v.model || '—'}</td>
                <td style={COL}>
                  <Badge variant="default">{v.uploadedFormat}</Badge>
                </td>
                <td style={COL}>
                  <Badge variant={validationVariant(v.validationStatus)} dot>
                    {v.validationStatus}
                  </Badge>
                </td>
                <td style={COL}>
                  <Badge variant={lifecycleVariant(v.lifecycleStatus)} dot>
                    {v.lifecycleStatus}
                  </Badge>
                </td>
                <td style={{ ...COL, textAlign: 'right' }}>{v.fingerprintCount ?? '—'}</td>
                <td style={{ ...COL, textAlign: 'right' }}>{v.parameterGroupCount ?? '—'}</td>
                <td style={{ ...COL, textAlign: 'right' }}>
                  {v.lifecycleStatus === 'ACTIVE' && v.registryVersion !== undefined
                    ? <Badge variant="accent">v{v.registryVersion}</Badge>
                    : '—'}
                </td>
                <td style={{ ...COL, color: 'var(--vf-text-secondary)' }}>
                  {formatDate(v.updatedAt)}
                </td>
                <td style={{ ...COL, color: 'var(--vf-text-secondary)', fontSize: 12 }}>
                  {v.actorUsername || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

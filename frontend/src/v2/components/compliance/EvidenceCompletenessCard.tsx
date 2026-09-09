/**
 * Evidence Completeness Card for WO-068 CTSO/TSOC Evidence Export
 * Displays completeness status for each evidence section
 */

import React from 'react';
import type { EvidenceCompleteness } from '../../../api/reports.types';

export interface EvidenceCompletenessCardProps {
  completeness: EvidenceCompleteness;
  privacyVersion: string;
  checksum: string;
  onCopyChecksum: () => void;
}

export function EvidenceCompletenessCard({
  completeness,
  privacyVersion,
  checksum,
  onCopyChecksum,
}: EvidenceCompletenessCardProps) {
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
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
          Evidence Completeness
        </div>
        <div
          style={{
            fontSize: 11,
            padding: '4px 10px',
            background: 'var(--vf-info-subtle)',
            color: 'var(--vf-info)',
            borderRadius: 'var(--vf-radius-full)',
            fontWeight: 600,
          }}
        >
          Privacy v{privacyVersion}
        </div>
      </div>

      {/* Completeness Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <CompletenessItem label="Alarm Data" status={completeness.alarmData} />
        <CompletenessItem label="Audit Data" status={completeness.auditData} />
        <CompletenessItem label="Inventory Data" status={completeness.inventoryData} />
      </div>

      {/* Checksum */}
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--vf-elevated)',
          borderRadius: 8,
          border: '1px solid var(--vf-border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              SHA256 Checksum
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--vf-text-secondary)',
                fontFamily: 'var(--vf-font-mono)',
                wordBreak: 'break-all',
                lineHeight: 1.5,
              }}
            >
              {checksum}
            </div>
          </div>
          <button
            onClick={onCopyChecksum}
            style={{
              marginLeft: 12,
              padding: '6px 12px',
              background: 'var(--vf-accent-subtle)',
              border: '1px solid var(--vf-accent)',
              borderRadius: 6,
              color: 'var(--vf-accent)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

function CompletenessItem({ label, status }: { label: string; status: 'complete' | 'unavailable' }) {
  const isComplete = status === 'complete';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: isComplete ? 'var(--vf-success-subtle)' : 'var(--vf-warning-subtle)',
        border: `1px solid ${isComplete ? 'var(--vf-success)' : 'var(--vf-warning)'}`,
        borderRadius: 8,
      }}
    >
      <span style={{ fontSize: 16 }}>{isComplete ? '✓' : '⚠'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
          {isComplete ? 'Complete' : 'Unavailable'}
        </div>
      </div>
    </div>
  );
}

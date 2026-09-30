/**
 * V2ProductDefinitionPage — Product Definition Lifecycle
 *
 * Allows Admin and SuperAdmin operators to:
 *   1. Upload an XML, XLS, or JSON Product Definition file
 *   2. Select a credential policy for the uploaded file
 *   3. Validate the file — view the structured validation report
 *   4. Stage and activate validated definitions
 *   5. Browse all versions (active / staged / previous)
 *   6. View firmware overlap and fingerprint conflicts
 *   7. Rollback to a prior version
 *
 * The page follows the two-column layout from the NMS framework spec:
 *   Left  — Upload definition form + credential policy + validation rules
 *   Right — Tabbed results (Validation report | Versions | Conflicts)
 *
 * All write operations (stage, activate, rollback) are Admin/SuperAdmin only.
 * Credential material is never rendered at any step.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AxiosError } from 'axios';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/common/Toast';
import { Button } from '../components/common/Button';
import { LoadingState } from '../components/common/States';
import {
  uploadProductDefinition,
  listProductDefinitions,
  listProductDefinitionVersions,
  listAllUploadHistory,
  getProductDefinitionValidationReport,
  getProductDefinitionLifecycleHistory,
  stageProductDefinitionVersion,
  activateProductDefinitionVersion,
  rollbackProductDefinition,
  deleteProductDefinitionVersion,
  generateIdempotencyKey,
  extractApiError,
  getVersionDiff,
  getVersionSchema,
} from '../../api/productDefinitions.api';
import type { VersionDiffResult } from '../../api/productDefinitions.api';
import type {
  DefinitionSummary,
  ProductDefinitionVersion,
  LifecycleStatus,
  ValidationFinding,
  ValidationReport,
  LifecycleEvent,
} from '../../api/productDefinitions.types';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

type RightTab = 'validation' | 'versions' | 'history' | 'conflicts';

type CredentialPolicy = 'none' | 'vault_reference';

interface ValidationStep {
  num: number;
  label: string;
  detail: string;
  severity: 'pass' | 'warning' | 'error';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lifecycleVariant(status: LifecycleStatus): { bg: string; text: string; border: string } {
  switch (status) {
    case 'ACTIVE':      return { bg: 'var(--vf-success-subtle)', text: 'var(--vf-success)',        border: 'var(--vf-success)' };
    case 'STAGED':      return { bg: 'var(--vf-accent-subtle)',  text: 'var(--vf-accent)',          border: 'var(--vf-accent)' };
    case 'DRAFT':       return { bg: 'var(--vf-elevated)',        text: 'var(--vf-text-secondary)', border: 'var(--vf-border-subtle)' };
    case 'SUPERSEDED':  return { bg: 'rgba(234,179,8,0.12)',      text: '#ca8a04',                  border: 'rgba(234,179,8,0.4)' };
    case 'ARCHIVED':    return { bg: 'var(--vf-elevated)',        text: 'var(--vf-text-muted)',     border: 'var(--vf-border-subtle)' };
    default:            return { bg: 'var(--vf-elevated)',        text: 'var(--vf-text-secondary)', border: 'var(--vf-border-subtle)' };
  }
}

function StatusPill({ status }: { status: LifecycleStatus | string }) {
  const c = lifecycleVariant(status as LifecycleStatus);
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px',
      borderRadius: 'var(--vf-radius-full)', border: `1px solid ${c.border}`,
      background: c.bg, color: c.text, fontSize: 12, fontWeight: 600,
      textTransform: 'lowercase',
    }}>
      {status.toLowerCase()}
    </span>
  );
}

function StepCircle({ num, severity }: { num: number; severity: ValidationStep['severity'] }) {
  const bg = severity === 'pass' ? 'var(--vf-success)' : severity === 'warning' ? 'var(--vf-warning)' : 'var(--vf-danger)';
  return (
    <div style={{
      width: 28, height: 28, borderRadius: '50%', background: bg,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 700, flexShrink: 0,
    }}>
      {num}
    </div>
  );
}

// ── Upload drop zone ──────────────────────────────────────────────────────────

function UploadDropZone({
  onFile,
  disabled,
}: {
  onFile: (f: File) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Drop XML, XLS, or JSON file here, or click to choose file"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={(e) => {
        // Only open the picker when the click is on the drop zone itself (not
        // bubbled up from the <label> or <input> inside it — those already
        // open the picker via native label behaviour and a second programmatic
        // .click() causes the "File chooser can only be shown with user
        // activation" browser warning).
        const target = e.target as HTMLElement;
        if (target.closest('label') || target.tagName === 'INPUT') return;
        inputRef.current?.click();
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      style={{
        border: `2px dashed ${dragging ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
        borderRadius: 'var(--vf-radius-md)',
        background: dragging ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
        padding: '28px 20px',
        textAlign: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 10 }}>
        Drop XML, XLS, or JSON file
      </div>
      <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
        XML namespace <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>urn:nms:productdef:1.0</span> or JSON schema{' '}
        <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>urn:nms:productdef:json:1.0</span>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center' }}>
        <label
          style={{
            padding: '6px 14px', borderRadius: 'var(--vf-radius-md)',
            border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
            color: 'var(--vf-text-primary)', cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13, fontWeight: 500,
          }}
        >
          Choose File
          <input
            ref={inputRef}
            type="file"
            accept=".xml,.xls,.xlsx,.json"
            style={{ display: 'none' }}
            disabled={disabled}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />
        </label>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>No file chosen</span>
      </div>
    </div>
  );
}

// ── Duplicate file dialog ─────────────────────────────────────────────────────

function DuplicateFileDialog({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  // Extract versionId from the server message for display
  const versionMatch = message.match(/versionId=([a-f0-9-]+)/i);
  const versionId = versionMatch ? versionMatch[1] : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.55)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)', boxShadow: 'var(--vf-shadow-popover)',
        padding: '32px 28px', maxWidth: 480, width: '90%',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{ fontSize: 22 }}>⚠️</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
            File already uploaded
          </span>
        </div>

        {/* Body */}
        <p style={{ fontSize: 14, color: 'var(--vf-text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
          This exact file has already been ingested by the system. Uploading identical
          content again would create a redundant version.
        </p>
        {versionId && (
          <div style={{
            background: 'var(--vf-elevated)', borderRadius: 'var(--vf-radius-md)',
            padding: '10px 14px', marginBottom: 16,
            border: '1px solid var(--vf-border-subtle)',
          }}>
            <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Existing version ID
            </span>
            <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-primary)', marginTop: 4, wordBreak: 'break-all' }}>
              {versionId}
            </div>
          </div>
        )}
        <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', marginBottom: 20 }}>
          Check the <strong>Versions</strong> tab to view or activate the existing version,
          or choose a different file to upload.
        </p>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onDismiss}
            style={{
              padding: '8px 20px', borderRadius: 'var(--vf-radius-md)',
              background: 'var(--vf-accent)', color: 'var(--vf-on-accent)',
              border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            Choose a different file
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Version Detail Drawer ─────────────────────────────────────────────────────
// Slide-over panel shown when an operator clicks "Review" on an ACTIVE version.
// Displays product identity, validation report (findings grouped by severity),
// and the full lifecycle event history — matching WO-003 acceptance criteria.

interface VersionDetailDrawerProps {
  version: ProductDefinitionVersion;
  onClose: () => void;
}

function VersionDetailDrawer({ version, onClose }: VersionDetailDrawerProps) {
  const [report,  setReport]  = useState<ValidationReport | null>(null);
  const [history, setHistory] = useState<LifecycleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  // Schema = parsed parameter groups + fingerprints from normalizedMetadataJson
  const [schema, setSchema]   = useState<import('../../api/productDefinitions.api').ProductDefinitionSchema | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getProductDefinitionValidationReport(version.definitionId, version.versionId).catch(() => null),
      getProductDefinitionLifecycleHistory(version.definitionId).catch(() => []),
      getVersionSchema(version.definitionId, version.versionId).catch(() => null),
    ]).then(([r, h, s]) => {
      if (cancelled) return;
      setReport(r);
      setHistory(Array.isArray(h) ? h : []);
      setSchema(s);
    }).catch((e: unknown) => {
      if (cancelled) return;
      setError(String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [version.definitionId, version.versionId]);

  const severityColor = (s: string) =>
    s === 'ERROR' ? 'var(--vf-danger)' : s === 'WARNING' ? '#f59e0b' : 'var(--vf-text-muted)';

  const eventColor = (outcome: string) =>
    outcome === 'SUCCESS' ? 'var(--vf-success)' : 'var(--vf-danger)';

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900 }}
        aria-hidden="true"
      />
      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Version detail — ${version.definitionId}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 520,
          background: 'var(--vf-surface)', borderLeft: '1px solid var(--vf-border-subtle)',
          zIndex: 901, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 24,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 4 }}>
              Version review
            </div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, fontFamily: 'var(--vf-font-mono)' }}>
              {version.versionId}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close version detail"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--vf-text-muted)', lineHeight: 1, padding: 4 }}
          >
            ×
          </button>
        </div>

        {/* Product identity */}
        <section>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 10 }}>
            Product identity
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 12 }}>
            {([
              ['Vendor',          version.vendor],
              ['Model',           version.model],
              ['Schema version',  version.schemaVersion],
              ['Format',          version.uploadedFormat],
              ['Firmware min',    version.firmwareRangeMin ?? '—'],
              ['Firmware max',    version.firmwareRangeMax ?? '—'],
              ['Fingerprints',    String(version.fingerprintCount ?? '—')],
              ['Parameter groups',String(version.parameterGroupCount ?? '—')],
              ['Registry version',version.registryVersion != null ? `v${version.registryVersion}` : '—'],
              ['Uploaded',        version.createdAt ? new Date(version.createdAt).toLocaleString() : '—'],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label}>
                <div style={{ color: 'var(--vf-text-muted)', fontSize: 11, marginBottom: 2 }}>{label}</div>
                <div style={{ fontFamily: label === 'Vendor' || label === 'Model' ? undefined : 'var(--vf-font-mono)', fontWeight: 500 }}>{value}</div>
              </div>
            ))}
          </div>
        </section>

        {loading && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--vf-text-muted)', fontSize: 13 }}>
            Loading report and history…
          </div>
        )}
        {error && (
          <div style={{ padding: 12, borderRadius: 6, background: 'var(--vf-danger-subtle)', color: 'var(--vf-danger)', fontSize: 12 }}>
            Failed to load detail: {error}
          </div>
        )}

        {/* ── SNMP Fingerprints ── */}
        {!loading && schema && schema.fingerprints.length > 0 && (
          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
              SNMP Fingerprints ({schema.fingerprints.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {schema.fingerprints.map((fp, i) => (
                <div key={i} style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--vf-text-muted)' }}>OID:</span>
                    <code style={{ color: '#60a5fa', fontFamily: 'var(--vf-font-mono)' }}>{fp.sysObjectId}</code>
                  </div>
                  {fp.sysDescrPattern && (
                    <div style={{ marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--vf-text-muted)' }}>Pattern:</span>
                      <code style={{ color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>{fp.sysDescrPattern}</code>
                    </div>
                  )}
                  {(fp.firmwareFrom || fp.firmwareTo) && (
                    <div style={{ marginTop: 3, fontSize: 11, color: 'var(--vf-text-muted)' }}>
                      FW: {fp.firmwareFrom ?? '*'} – {fp.firmwareTo ?? '*'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Parameter Groups ── */}
        {!loading && schema && schema.groups.length > 0 && (
          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
              Parameter Groups ({schema.groups.length} groups · {schema.groups.reduce((s, g) => s + g.parameters.length, 0)} params)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {schema.groups.map((g) => (
                <div key={g.groupName} style={{ borderRadius: 8, border: '1px solid var(--vf-border-subtle)', overflow: 'hidden' }}>
                  <div style={{ padding: '6px 12px', background: 'var(--vf-elevated)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{g.groupName}</span>
                    <span style={{ fontWeight: 400, color: 'var(--vf-text-muted)' }}>{g.parameters.length} params</span>
                  </div>
                  <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {g.parameters.map((p) => (
                      <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                        <code style={{ color: '#60a5fa', fontFamily: 'var(--vf-font-mono)', fontSize: 11, minWidth: 180, flexShrink: 0 }}>{p.id}</code>
                        <span style={{ color: 'var(--vf-text-secondary)', flex: 1 }}>{p.displayName}</span>
                        <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', background: 'var(--vf-elevated)', padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
                          {p.dataType}{p.unit ? ` (${p.unit})` : ''}
                        </span>
                        {(p.minValue !== undefined || p.maxValue !== undefined) && (
                          <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', whiteSpace: 'nowrap' }}>
                            {p.minValue ?? '—'}–{p.maxValue ?? '—'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Validation report — API is normalised in productDefinitions.api.ts */}
        {!loading && report && (
          <section>
            {Boolean((report as unknown as Record<string,unknown>)['normalizedSummary']) && (
              <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 10, fontStyle: 'italic' }}>
                {String((report as unknown as Record<string,unknown>)['normalizedSummary'] ?? '')}
              </div>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
              Validation report
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--vf-text-secondary)' }}>
                {report.errorCount} error{report.errorCount !== 1 ? 's' : ''},&nbsp;
                {report.warningCount} warning{report.warningCount !== 1 ? 's' : ''}
              </span>
            </div>
            {(report.findings ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', padding: '8px 0' }}>
                No findings — definition passed all validation gates.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(report.findings ?? []).map((f: ValidationFinding, i: number) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 10px', borderRadius: 6,
                      background: 'var(--vf-elevated)', border: `1px solid var(--vf-border-subtle)`,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, fontSize: 10, color: severityColor(f.severity), textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {f.severity}
                      </span>
                      <span style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-secondary)' }}>
                        {f.field}
                      </span>
                    </div>
                    <div style={{ color: 'var(--vf-text-primary)' }}>{f.message}</div>
                  </div>
                ))}
              </div>
            )}
            {report.correlationId && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)' }}>
                Correlation ID: {report.correlationId}
              </div>
            )}
          </section>
        )}

        {/* Lifecycle history */}
        {!loading && history.length > 0 && (
          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 10 }}>
              Lifecycle history
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {history.map((evt, i) => (
                <div key={evt.id ?? i} style={{ display: 'flex', gap: 12, paddingBottom: 14, position: 'relative' }}>
                  {/* Timeline spine */}
                  {i < history.length - 1 && (
                    <div style={{ position: 'absolute', left: 7, top: 16, bottom: 0, width: 1, background: 'var(--vf-border-subtle)' }} />
                  )}
                  {/* Dot */}
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                    background: eventColor(evt.outcome), border: `2px solid var(--vf-surface)`,
                  }} />
                  <div style={{ flex: 1, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 600 }}>{evt.eventType.replace(/_/g, ' ')}</span>
                      <span style={{ color: 'var(--vf-text-muted)', fontSize: 11 }}>
                        {new Date(evt.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {evt.actor && (
                      <div style={{ color: 'var(--vf-text-secondary)' }}>by {evt.actor}</div>
                    )}
                    {evt.changeSummary && (
                      <div style={{ color: 'var(--vf-text-secondary)', marginTop: 2 }}>{evt.changeSummary}</div>
                    )}
                    {evt.registryVersion != null && (
                      <div style={{ fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                        registry v{evt.registryVersion}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {!loading && history.length === 0 && !error && (
          <section>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
              Lifecycle history
            </div>
            <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>No lifecycle events recorded yet.</div>
          </section>
        )}
      </aside>
    </>
  );
}

// ── Delete confirmation dialog ────────────────────────────────────────────────

function DeleteVersionDialog({
  version,
  onConfirm,
  onCancel,
  deleting,
}: {
  version: ProductDefinitionVersion;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)', boxShadow: 'var(--vf-shadow-popover)',
        padding: '32px 28px', maxWidth: 460, width: '90%',
      }}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm version deletion"
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'var(--vf-danger)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 700, flexShrink: 0,
          }}>🗑</div>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
            Delete this version?
          </span>
        </div>

        {/* Version identity */}
        <div style={{
          background: 'var(--vf-elevated)', borderRadius: 'var(--vf-radius-md)',
          padding: '12px 14px', marginBottom: 16,
          border: '1px solid var(--vf-border-subtle)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', marginBottom: 4 }}>
            {version.name ?? version.model}
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)' }}>
            {version.versionId}
          </div>
          <div style={{ fontSize: 11, color: 'var(--vf-text-secondary)', marginTop: 4 }}>
            {version.vendor} · {version.model} · <strong>{version.lifecycleStatus}</strong>
          </div>
        </div>

        <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          This will permanently remove the version record and its validation report.
          <strong> This action cannot be undone.</strong>
        </p>

        {/* Warning if STAGED */}
        {version.lifecycleStatus === 'STAGED' && (
          <div style={{
            padding: '10px 12px', borderRadius: 6, marginBottom: 16,
            background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)',
            fontSize: 12, color: '#b45309',
          }}>
            ⚠️ This version is currently <strong>STAGED</strong>. Deleting it will remove it before activation.
          </div>
        )}

        {/* Strong warning if ACTIVE — force-delete */}
        {version.lifecycleStatus === 'ACTIVE' && (
          <div style={{
            padding: '12px 14px', borderRadius: 6, marginBottom: 16,
            background: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.5)',
            fontSize: 12, color: '#dc2626',
          }}>
            🔴 <strong>This is the ACTIVE version.</strong> Force-deleting it will remove all
            fingerprint and parameter registry entries for this product definition.
            Devices matching this definition will no longer be auto-discovered until a
            new version is activated.
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={deleting}
            style={{
              padding: '8px 18px', borderRadius: 'var(--vf-radius-md)',
              border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)',
              color: 'var(--vf-text-primary)', cursor: deleting ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            aria-busy={deleting}
            style={{
              padding: '8px 18px', borderRadius: 'var(--vf-radius-md)',
              border: 'none', background: 'var(--vf-danger)', color: '#fff',
              cursor: deleting ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 700,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? 'Deleting…' : 'Yes, delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function V2ProductDefinitionPage() {
  const { addToast }  = useToast();
  const navigate      = useNavigate();

  // ── Upload state ───────────────────────────────────────────────────────────
  const [selectedFile,       setSelectedFile]       = useState<File | null>(null);
  const [credentialPolicy,   setCredentialPolicy]   = useState<CredentialPolicy>('none');
  const [policyOpen,         setPolicyOpen]         = useState(false);
  const [validationRulesOpen,setValidationRulesOpen] = useState(false);
  const [uploading,          setUploading]          = useState(false);
  const [duplicateMsg,       setDuplicateMsg]       = useState<string | null>(null);

  // ── Draft version after upload ─────────────────────────────────────────────
  const [draftVersion,       setDraftVersion]       = useState<ProductDefinitionVersion | null>(null);

  // ── Versions list ──────────────────────────────────────────────────────────
  const [definitions,        setDefinitions]        = useState<DefinitionSummary[]>([]);
  const [allVersions,        setAllVersions]        = useState<ProductDefinitionVersion[]>([]);
  const [versionsLoading,    setVersionsLoading]    = useState(true);

  // ── All-uploads history (admin view) ───────────────────────────────────────
  const [uploadHistory,      setUploadHistory]      = useState<ProductDefinitionVersion[]>([]);
  const [historyLoading,     setHistoryLoading]     = useState(false);

  // ── Conflicts (static demo — populated from API in a future release) ───────
  const [conflicts] = useState<{ title: string; detail: string; id: string }[]>([
    {
      id: 'conflict-1',
      title: 'Overlapping firmware range',
      detail: 'VendorA BTS-X200 v1.0.5 overlaps active v1.0.4 for fingerprint 1.3.6.1.4.1.12345.1.1 and firmware 3.4–3.9.',
    },
  ]);

  // ── Right tab ─────────────────────────────────────────────────────────────
  const [rightTab, setRightTab] = useState<RightTab>('validation');

  // ── Lifecycle action state ─────────────────────────────────────────────────
  const [staging,    setStaging]    = useState(false);
  const [activating, setActivating] = useState(false);
  const [rollingBack,setRollingBack]= useState<string | null>(null); // versionId being rolled back

  // ── Version detail drawer ──────────────────────────────────────────────────
  const [reviewedVersion, setReviewedVersion] = useState<ProductDefinitionVersion | null>(null);

  // ── Per-row action state (staging/activating individual versions from table) ──
  const [rowStaging,    setRowStaging]    = useState<string | null>(null); // versionId
  const [rowActivating, setRowActivating] = useState<string | null>(null); // versionId

  // ── Delete state ──────────────────────────────────────────────────────────
  const [deleteTarget,  setDeleteTarget]  = useState<ProductDefinitionVersion | null>(null);
  const [deleting,      setDeleting]      = useState(false);

  // ── Version diff (Compare) drawer ─────────────────────────────────────────
  const [diffDrawerOpen, setDiffDrawerOpen] = useState(false);
  const [diffLoading,    setDiffLoading]    = useState(false);
  const [diffResult,     setDiffResult]     = useState<VersionDiffResult | null>(null);
  const [diffError,      setDiffError]      = useState<string | null>(null);
  const [diffFromLabel,  setDiffFromLabel]  = useState('');
  const [diffToLabel,    setDiffToLabel]    = useState('');

  // ── Validation steps derived from the draft version ───────────────────────
  const validationSteps: ValidationStep[] = draftVersion
    ? buildValidationSteps(draftVersion)
    : [];

  // Load definitions and all versions on mount.
  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const defs = await listProductDefinitions();
      setDefinitions(defs);
      // Flatten all versions across all definitions for the Versions tab table.
      const allV = await Promise.all(
        defs.map((d) => listProductDefinitionVersions(d.definitionId).catch(() => [])),
      );
      setAllVersions(allV.flat());
    } catch (err) {
      logger.error('V2ProductDefinitionPage: version load failed', err);
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  // Lazy-load the full history only when the operator opens that tab.
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const all = await listAllUploadHistory();
      setUploadHistory(all);
    } catch (err) {
      logger.error('V2ProductDefinitionPage: history load failed', err);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (rightTab === 'history' && uploadHistory.length === 0 && !historyLoading) {
      void loadHistory();
    }
  }, [rightTab, uploadHistory.length, historyLoading, loadHistory]);

  // ── Upload handler ─────────────────────────────────────────────────────────
  async function handleValidateFile() {
    if (!selectedFile) { addToast('Select a file before validating.', 'error'); return; }
    setUploading(true);
    try {
      const version = await uploadProductDefinition(
        selectedFile,
        `Uploaded via UI — ${new Date().toISOString()}`,
      );
      setDraftVersion(version);
      setRightTab('validation');
      addToast(`${selectedFile.name} uploaded. Validation complete.`, 'success');
      void loadVersions();
    } catch (err) {
      // uploadProductDefinition already normalises to FrameworkApiError via extractApiError.
      // extractApiError fast-paths FrameworkApiError objects, so calling it here is safe
      // even though the error was already normalised by the API layer.
      const apiErr = extractApiError(err);

      // UPLOAD_REJECTED = duplicate content-hash — surface the server message directly.
      // Also match on the message text as a safety net for any future code-rename.
      const isDuplicate =
        apiErr.error.code === 'UPLOAD_REJECTED' ||
        apiErr.error.message?.toLowerCase().includes('already been uploaded') ||
        apiErr.error.message?.toLowerCase().includes('already uploaded');

      if (isDuplicate) {
        // Show a persistent dialog instead of a fleeting toast so the operator
        // can read the existing versionId and decide what to do next.
        const msg = (apiErr.error.message || '').includes('already')
          ? apiErr.error.message
          : 'This file has already been uploaded. Check the Versions tab to find the existing version.';
        setDuplicateMsg(msg);
      } else {
        addToast(`Upload failed: ${apiErr.error.message ?? 'Unexpected error'}`, 'error');
      }
      logger.error('V2ProductDefinitionPage: upload failed', { code: apiErr.error.code, message: apiErr.error.message });
    } finally {
      setUploading(false);
    }
  }

  // ── Stage + activate handler ────────────────────────────────────────────────
  async function handleStageAndActivate() {
    if (!draftVersion) return;
    setStaging(true);
    try {
      await stageProductDefinitionVersion(draftVersion.definitionId, draftVersion.versionId);
      addToast(`${draftVersion.name} staged.`, 'success');
      setActivating(true);
      const idempotencyKey = generateIdempotencyKey();
      await activateProductDefinitionVersion(
        draftVersion.definitionId,
        draftVersion.versionId,
        idempotencyKey,
      );
      addToast(`${draftVersion.name} activated — registries rebuilding.`, 'success');
      void loadVersions();
      setDraftVersion(null);
      setSelectedFile(null);
      setRightTab('versions');
    } catch (err) {
      const apiErr = extractApiError(err);
      // "socket hang up" / ECONNRESET means the proxy timed out but the backend
      // may have completed — refresh versions and switch to the tab so the operator
      // can see the actual outcome rather than an opaque error.
      const isTimeout = apiErr.error.code === 'INTERNAL_ERROR' &&
        (apiErr.error.message.includes('hang up') || apiErr.error.message.includes('timeout') ||
         apiErr.error.message.includes('ECONNRESET') || apiErr.error.message.includes('Network'));
      if (isTimeout) {
        addToast('Activation request timed out — refreshing to check backend status…', 'warning');
      } else if (apiErr.error.code === 'INVALID_LIFECYCLE_TRANSITION') {
        // e.g. trying to stage a version that's already ACTIVE
        addToast(
          `Lifecycle error: ${apiErr.error.message} — upload a new file to create a new version.`,
          'error',
        );
      } else {
        addToast(`Action failed: ${apiErr.error.message}`, 'error');
      }
      logger.error('V2ProductDefinitionPage: stage/activate failed', { code: apiErr.error.code, message: apiErr.error.message });
    } finally {
      setStaging(false);
      setActivating(false);
      // Always reload versions — activation may have succeeded even if the proxy timed out.
      void loadVersions();
      setRightTab('versions');
    }
  }

  // ── Rollback handler ────────────────────────────────────────────────────────
  async function handleRollback(version: ProductDefinitionVersion) {
    setRollingBack(version.versionId);
    try {
      const defId = version.definitionId;
      const def   = definitions.find((d) => d.definitionId === defId);
      await rollbackProductDefinition(
        defId,
        version.versionId,
        `Manual rollback via UI to ${version.versionId}`,
      );
      addToast(`Rolled back ${def?.name ?? defId} to ${version.versionId}.`, 'success');
      void loadVersions();
    } catch (err) {
      const apiErr = extractApiError(err);
      addToast(`Rollback failed: ${apiErr.error.message}`, 'error');
      logger.error('V2ProductDefinitionPage: rollback failed', err);
    } finally {
      setRollingBack(null);
    }
  }

  // ── Stage a specific version from the Versions table ─────────────────────
  async function handleRowStage(version: ProductDefinitionVersion) {
    setRowStaging(version.versionId);
    try {
      await stageProductDefinitionVersion(version.definitionId, version.versionId);
      addToast(`Version ${version.versionId.slice(0, 8)}… staged successfully.`, 'success');
      void loadVersions();
    } catch (err) {
      const apiErr = extractApiError(err);
      addToast(`Stage failed: ${apiErr.error.message}`, 'error');
      logger.error('V2ProductDefinitionPage: row stage failed', err);
    } finally {
      setRowStaging(null);
    }
  }

  // ── Activate a specific version from the Versions table ───────────────────
  async function handleRowActivate(version: ProductDefinitionVersion) {
    setRowActivating(version.versionId);
    try {
      const idempotencyKey = generateIdempotencyKey();
      await activateProductDefinitionVersion(version.definitionId, version.versionId, idempotencyKey);
      addToast(`Version ${version.versionId.slice(0, 8)}… is now ACTIVE. Registries rebuilding…`, 'success');
      void loadVersions();
    } catch (err) {
      const apiErr = extractApiError(err);
      const isTimeout = apiErr.error.code === 'INTERNAL_ERROR' &&
        (apiErr.error.message.includes('hang up') || apiErr.error.message.includes('timeout') ||
         apiErr.error.message.includes('ECONNRESET'));
      if (isTimeout) {
        addToast('Activation request timed out — refreshing to check status…', 'warning');
        void loadVersions();
      } else {
        addToast(`Activate failed: ${apiErr.error.message}`, 'error');
      }
      logger.error('V2ProductDefinitionPage: row activate failed', err);
    } finally {
      setRowActivating(null);
    }
  }

  // ── Compare a version against the currently ACTIVE one ────────────────────
  async function handleCompare(version: ProductDefinitionVersion) {
    // Find the ACTIVE version for the same definition
    const activeVersion = allVersions.find(
      (v) => v.definitionId === version.definitionId && v.lifecycleStatus === 'ACTIVE',
    );
    if (!activeVersion) {
      addToast('No active version found for this definition to compare against.', 'warning');
      return;
    }
    if (activeVersion.versionId === version.versionId) {
      addToast('This version is already active — nothing to compare.', 'info');
      return;
    }
    setDiffLoading(true);
    setDiffResult(null);
    setDiffError(null);
    setDiffFromLabel(`Active (${activeVersion.versionId.slice(0, 8)}…)`);
    setDiffToLabel(`${version.lifecycleStatus} (${version.versionId.slice(0, 8)}…)`);
    setDiffDrawerOpen(true);
    try {
      const diff = await getVersionDiff(version.definitionId, activeVersion.versionId, version.versionId);
      setDiffResult(diff);
    } catch (err) {
      const apiErr = extractApiError(err);
      setDiffError(apiErr.error.message);
    } finally {
      setDiffLoading(false);
    }
  }

  // ── Delete handler ────────────────────────────────────────────────────────
  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    // Force-delete is needed when the version is currently ACTIVE
    const forceDelete = deleteTarget.lifecycleStatus === 'ACTIVE';
    try {
      await deleteProductDefinitionVersion(deleteTarget.definitionId, deleteTarget.versionId, forceDelete);
      addToast(
        forceDelete
          ? `Active version deleted. Registry entries cleared.`
          : `Version deleted successfully.`,
        'success',
      );
      setDeleteTarget(null);
      void loadVersions();
      // Also reload history tab if it's currently visible
      if (rightTab === 'history') void loadHistory();
    } catch (err) {
      const apiErr = extractApiError(err);
      if (apiErr.error.code === 'DELETE_BLOCKED_ACTIVE') {
        addToast('Cannot delete an ACTIVE version — roll back first, then delete.', 'error');
      } else {
        addToast(`Delete failed: ${apiErr.error.message}`, 'error');
      }
      logger.error('V2ProductDefinitionPage: delete failed', err);
    } finally {
      setDeleting(false);
    }
  }

  // ── Download templates ─────────────────────────────────────────────────────
  // Each download produces a correctly-structured file that the Java parsers
  // will accept.  The schemas here match the fixtures used by the parser unit
  // tests (valid-definition.xml / valid-definition.json / XlsProductDefinitionParserTest).

  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);

  function downloadBlob(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadXml() {
    setTemplateMenuOpen(false);
    downloadBlob(
      `<?xml version="1.0" encoding="UTF-8"?>
<!-- UBR NMS Product Definition — XML format (schema: urn:nms:productdef:1.0) -->
<productDefinition xmlns="urn:nms:productdef:1.0">

  <identity>
    <name>My Device Name</name>
    <vendor>MyVendor</vendor>
    <model>MyModel-X1</model>
    <firmwareFrom>1.0</firmwareFrom>
    <firmwareTo>99.x</firmwareTo>
    <productFamily>My Product Family</productFamily>
  </identity>

  <!-- At least one fingerprint is required. sysObjectId must be a valid OID. -->
  <fingerprints>
    <fingerprint>
      <sysObjectId>.1.3.6.1.4.1.99999.1.1</sysObjectId>
      <sysDescrPattern>.*MyVendor.*MyModel.*</sysDescrPattern>
      <firmwareFrom>1.0</firmwareFrom>
      <firmwareTo>99.x</firmwareTo>
    </fingerprint>
  </fingerprints>

  <!-- Supported protocol types: SNMP, CLI, REST, NETCONF, GRPC -->
  <protocols>
    <protocol><type>SNMP</type></protocol>
    <protocol><type>CLI</type></protocol>
  </protocols>

  <!-- Parameters are grouped. dataType values: GAUGE, COUNTER, STRING, FLOAT,
       TIMETICKS, COUNTER32, COUNTER64, GAUGE32, OCTETSTRING, ENUM -->
  <parameters>
    <group name="system">
      <parameter>
        <id>sys_uptime</id>
        <displayName>System Uptime</displayName>
        <dataType>TIMETICKS</dataType>
        <unit>seconds</unit>
        <snmpMapping>
          <oid>.1.3.6.1.2.1.1.3.0</oid>
        </snmpMapping>
        <uiVisibleTo>NMS_OPERATOR,FRAMEWORK_ADMIN</uiVisibleTo>
      </parameter>
      <parameter>
        <id>cpu_utilization</id>
        <displayName>CPU Utilization</displayName>
        <dataType>GAUGE</dataType>
        <unit>%</unit>
        <minValue>0</minValue>
        <maxValue>100</maxValue>
        <thresholdHigh>90</thresholdHigh>
        <snmpMapping>
          <oid>.1.3.6.1.4.1.99999.1.1.1</oid>
        </snmpMapping>
        <uiVisibleTo>NMS_OPERATOR,FRAMEWORK_ADMIN</uiVisibleTo>
      </parameter>
    </group>
    <group name="interface">
      <parameter>
        <id>if_in_octets</id>
        <displayName>Interface Inbound Octets</displayName>
        <dataType>COUNTER</dataType>
        <unit>bytes</unit>
        <snmpMapping>
          <oid>.1.3.6.1.2.1.2.2.1.10</oid>
        </snmpMapping>
        <uiVisibleTo>NMS_OPERATOR,FRAMEWORK_ADMIN</uiVisibleTo>
      </parameter>
    </group>
  </parameters>

</productDefinition>`,
      'product-definition-template.xml',
      'application/xml',
    );
  }

  function handleDownloadJson() {
    setTemplateMenuOpen(false);
    downloadBlob(
      JSON.stringify({
        $schema: 'urn:nms:productdef:json:1.0',
        productDefinition: {
          identity: {
            name: 'My Device Name',
            vendor: 'MyVendor',
            model: 'MyModel-X1',
            firmwareFrom: '1.0',
            firmwareTo: '99.x',
            productFamily: 'My Product Family',
          },
          fingerprints: [
            {
              sysObjectId: '.1.3.6.1.4.1.99999.1.1',
              sysDescrPattern: '.*MyVendor.*MyModel.*',
              firmwareFrom: '1.0',
              firmwareTo: '99.x',
            },
          ],
          protocols: [{ type: 'SNMP' }, { type: 'REST' }],
          parameters: [
            {
              groupName: 'system',
              parameters: [
                {
                  id: 'sys_uptime',
                  displayName: 'System Uptime',
                  dataType: 'TIMETICKS',
                  unit: 'seconds',
                  snmpMapping: { oid: '.1.3.6.1.2.1.1.3.0' },
                  uiVisibleTo: ['NMS_OPERATOR', 'FRAMEWORK_ADMIN'],
                },
                {
                  id: 'cpu_utilization',
                  displayName: 'CPU Utilization',
                  dataType: 'GAUGE',
                  unit: '%',
                  minValue: 0,
                  maxValue: 100,
                  thresholdHigh: '90',
                  snmpMapping: { oid: '.1.3.6.1.4.1.99999.1.1.1' },
                  uiVisibleTo: ['NMS_OPERATOR', 'FRAMEWORK_ADMIN'],
                },
                {
                  id: 'admin_status',
                  displayName: 'Admin Status',
                  dataType: 'ENUM',
                  enumValues: ['UP', 'DOWN', 'TESTING'],
                  restMapping: { apiPath: '/system/admin-status' },
                  uiVisibleTo: ['FRAMEWORK_ADMIN'],
                },
              ],
            },
          ],
        },
      }, null, 2),
      'product-definition-template.json',
      'application/json',
    );
  }

  async function handleDownloadXlsx() {
    setTemplateMenuOpen(false);
    try {
      // Dynamically import SheetJS to keep the main bundle lean.
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();

      // ── Identity sheet ────────────────────────────────────────────────────
      const identityData = [
        ['Name',          'My Device Name'],
        ['Vendor',        'MyVendor'],
        ['Model',         'MyModel-X1'],
        ['FirmwareFrom',  '1.0'],
        ['FirmwareTo',    '99.x'],
        ['ProductFamily', 'My Product Family'],
      ];
      const wbIdentity = XLSX.utils.aoa_to_sheet(identityData);
      XLSX.utils.book_append_sheet(wb, wbIdentity, 'Identity');

      // ── Fingerprints sheet ────────────────────────────────────────────────
      const fpData = [
        ['SysObjectId',              'SysDescrPattern',     'FirmwareFrom', 'FirmwareTo'],
        ['.1.3.6.1.4.1.99999.1.1',  '.*MyVendor.*MyModel.*', '1.0',        '99.x'],
      ];
      const wbFp = XLSX.utils.aoa_to_sheet(fpData);
      XLSX.utils.book_append_sheet(wb, wbFp, 'Fingerprints');

      // ── Protocols sheet ───────────────────────────────────────────────────
      const protoData = [
        ['Type'],
        ['SNMP'],
        ['REST'],
      ];
      const wbProto = XLSX.utils.aoa_to_sheet(protoData);
      XLSX.utils.book_append_sheet(wb, wbProto, 'Protocols');

      // ── Parameters sheet ──────────────────────────────────────────────────
      // Columns: Id | DisplayName | DataType | Unit | MinValue | MaxValue | OID | GroupName
      const paramData = [
        ['Id',            'DisplayName',        'DataType',  'Unit',    'MinValue', 'MaxValue', 'OID',                           'GroupName'],
        ['sys_uptime',    'System Uptime',       'TIMETICKS', 'seconds', '',         '',         '.1.3.6.1.2.1.1.3.0',            'system'],
        ['cpu_util',      'CPU Utilization',     'GAUGE',     '%',       '0',        '100',      '.1.3.6.1.4.1.99999.1.1.1',      'system'],
        ['if_in_octets',  'Interface In Octets', 'COUNTER',   'bytes',   '',         '',         '.1.3.6.1.2.1.2.2.1.10',         'interface'],
      ];
      const wbParam = XLSX.utils.aoa_to_sheet(paramData);
      XLSX.utils.book_append_sheet(wb, wbParam, 'Parameters');

      XLSX.writeFile(wb, 'product-definition-template.xlsx');
    } catch (e) {
      logger.error('V2ProductDefinitionPage: XLSX template generation failed', e);
      addToast('Failed to generate XLSX template — try XML or JSON instead.', 'error');
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      role="main"
      aria-label="Product Definition Lifecycle"
      style={{ padding: '32px 28px 48px' }}
    >
      {/* ── Version detail drawer ── */}
      {reviewedVersion && (
        <VersionDetailDrawer
          version={reviewedVersion}
          onClose={() => setReviewedVersion(null)}
        />
      )}

      {/* ── Version diff (Compare) drawer ── */}
      {diffDrawerOpen && (
        <>
          <div onClick={() => setDiffDrawerOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900 }}
            aria-hidden="true" />
          <aside
            role="dialog" aria-modal="true" aria-label="Version comparison"
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, width: 560,
              background: 'var(--vf-surface)', borderLeft: '1px solid var(--vf-border-subtle)',
              zIndex: 901, overflowY: 'auto', padding: '24px 28px',
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--vf-text-muted)', marginBottom: 4 }}>
                  Version Comparison
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                  {diffFromLabel} <span style={{ color: 'var(--vf-text-muted)' }}>→</span> {diffToLabel}
                </div>
              </div>
              <button onClick={() => setDiffDrawerOpen(false)}
                aria-label="Close comparison"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--vf-text-muted)', lineHeight: 1, padding: 4 }}>
                ×
              </button>
            </div>

            {diffLoading && (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--vf-text-muted)', fontSize: 13 }}>
                Loading diff…
              </div>
            )}
            {diffError && (
              <div style={{ padding: 12, borderRadius: 6, background: 'var(--vf-danger-subtle)', color: 'var(--vf-danger)', fontSize: 12 }}>
                {diffError}
              </div>
            )}
            {diffResult && !diffLoading && (() => {
              const sections = [
                { key: 'added',   label: 'Added',    color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   icon: '+' },
                { key: 'removed', label: 'Removed',  color: '#ef4444', bg: 'rgba(239,68,68,0.08)',  icon: '−' },
                { key: 'modified',label: 'Modified', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', icon: '~' },
              ] as const;
              return (
                <>
                  {/* Summary chips */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {sections.map(({ key, label, color, bg, icon }) => {
                      const items = (diffResult as unknown as Record<string, unknown[]>)[key] ?? [];
                      return (
                        <div key={key} style={{ padding: '6px 14px', borderRadius: 20, background: bg, border: `1px solid ${color}33`, fontSize: 12 }}>
                          <span style={{ color, fontWeight: 700 }}>{icon} {items.length}</span>
                          <span style={{ color: 'var(--vf-text-secondary)', marginLeft: 6 }}>{label}</span>
                        </div>
                      );
                    })}
                    <div style={{ padding: '6px 14px', borderRadius: 20, background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)', fontSize: 12, color: 'var(--vf-text-secondary)' }}>
                      {diffResult.fromParamCount} → {diffResult.toParamCount} params
                    </div>
                  </div>

                  {/* Detail sections */}
                  {sections.map(({ key, label, color, bg, icon }) => {
                    const items = (diffResult as unknown as Record<string, Array<{parameterId:string;label:string|null;fromGroupId:string|null;toGroupId:string|null;fromDataType:string|null;toDataType:string|null;summary:string}>>) [key] ?? [];
                    if (items.length === 0) return null;
                    return (
                      <section key={key}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color, marginBottom: 8 }}>
                          {icon} {label} ({items.length})
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {items.map((item) => (
                            <div key={item.parameterId} style={{ padding: '8px 12px', borderRadius: 6, background: bg, border: `1px solid ${color}22`, fontSize: 12 }}>
                              <div style={{ fontWeight: 600, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-primary)' }}>
                                {item.parameterId}
                                {item.label && <span style={{ fontFamily: 'sans-serif', fontWeight: 400, color: 'var(--vf-text-secondary)', marginLeft: 8 }}>{item.label}</span>}
                              </div>
                              <div style={{ color: 'var(--vf-text-muted)', marginTop: 3 }}>{item.summary}</div>
                              {item.fromGroupId !== item.toGroupId && (
                                <div style={{ color: 'var(--vf-text-muted)', marginTop: 2, fontSize: 11 }}>
                                  Group: <code>{item.fromGroupId ?? '—'}</code> → <code>{item.toGroupId ?? '—'}</code>
                                </div>
                              )}
                              {item.fromDataType !== item.toDataType && (
                                <div style={{ color: 'var(--vf-text-muted)', marginTop: 2, fontSize: 11 }}>
                                  Type: <code>{item.fromDataType ?? '—'}</code> → <code>{item.toDataType ?? '—'}</code>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </>
              );
            })()}
          </aside>
        </>
      )}

      {/* ── Delete confirmation dialog ── */}
      {deleteTarget && (
        <DeleteVersionDialog
          version={deleteTarget}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}

      {/* ── Duplicate file dialog (portal-style overlay) ── */}
      {duplicateMsg && (
        <DuplicateFileDialog
          message={duplicateMsg}
          onDismiss={() => {
            setDuplicateMsg(null);
            setSelectedFile(null);   // clear selection so user picks a new file
            setRightTab('versions'); // jump to Versions tab to show the existing one
          }}
        />
      )}

      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)', margin: 0 }}>
            Product Definition Lifecycle
          </h1>
          <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: '6px 0 0' }}>
            Upload, validate, stage, activate, version, and roll back metadata-driven product definitions.
          </p>
        </div>
        {/* ── Download templates dropdown ── */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setTemplateMenuOpen(v => !v)}
            style={{ ...BTN_SECONDARY, display: 'flex', alignItems: 'center', gap: 6 }}
            aria-label="Download Product Definition templates"
            aria-haspopup="menu"
            aria-expanded={templateMenuOpen}
          >
            Download templates ▾
          </button>
          {templateMenuOpen && (
            <>
              {/* backdrop to close on outside click */}
              <div
                onClick={() => setTemplateMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                aria-hidden
              />
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 4px)',
                  zIndex: 1000,
                  background: 'var(--vf-surface)',
                  border: '1px solid var(--vf-border-subtle)',
                  borderRadius: 'var(--vf-radius-md)',
                  boxShadow: 'var(--vf-shadow-popover)',
                  minWidth: 200,
                  overflow: 'hidden',
                }}
              >
                {[
                  { label: 'XML template',  desc: 'Element-based, schema urn:nms:productdef:1.0', onClick: handleDownloadXml  },
                  { label: 'JSON template', desc: 'schema urn:nms:productdef:json:1.0',           onClick: handleDownloadJson },
                  { label: 'XLSX template', desc: '4-sheet workbook (Identity, Fingerprints, Protocols, Parameters)', onClick: handleDownloadXlsx },
                ].map(item => (
                  <button
                    key={item.label}
                    role="menuitem"
                    onClick={item.onClick}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '9px 14px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      color: 'var(--vf-text-primary)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--vf-surface-sunken)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--vf-text-secondary)', marginTop: 2 }}>{item.desc}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Two-column layout ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 20, alignItems: 'flex-start' }}>

        {/* ── LEFT: Upload form ── */}
        <section aria-labelledby="upload-title" style={CARD_STYLE}>
          <h2 id="upload-title" style={CARD_TITLE}>Upload definition</h2>

          {/* Drop zone */}
          <UploadDropZone
            onFile={(f) => { setSelectedFile(f); setDraftVersion(null); }}
            disabled={uploading}
          />
          {selectedFile && (
            <div style={{ fontSize: 12, color: 'var(--vf-accent)', marginTop: 8, fontFamily: 'var(--vf-font-mono)' }}>
              ✓ {selectedFile.name}
            </div>
          )}

          {/* Credential policy */}
          <div style={{ marginTop: 20 }}>
            <label style={FORM_LABEL}>Credential policy</label>
            <div style={{ position: 'relative' }}>
              <button
                aria-haspopup="listbox"
                aria-expanded={policyOpen}
                onClick={() => setPolicyOpen((o) => !o)}
                style={{
                  width: '100%', padding: '8px 12px', textAlign: 'left',
                  borderRadius: 'var(--vf-radius-md)', border: '1px solid var(--vf-border-subtle)',
                  background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)',
                  cursor: 'pointer', fontSize: 13,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <span>{credentialPolicy === 'none' ? 'No credentials allowed in file' : 'Vault reference required after activation'}</span>
                <span aria-hidden style={{ color: 'var(--vf-text-muted)' }}>▾</span>
              </button>
              {policyOpen && (
                <div role="listbox" style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, marginTop: 4,
                  background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
                  borderRadius: 'var(--vf-radius-md)', boxShadow: 'var(--vf-shadow-popover)', overflow: 'hidden',
                }}>
                  {([
                    { value: 'none',            label: 'No credentials allowed in file' },
                    { value: 'vault_reference',  label: 'Vault reference required after activation' },
                  ] as const).map(({ value, label }) => (
                    <button
                      key={value}
                      role="option"
                      aria-selected={credentialPolicy === value}
                      onClick={() => { setCredentialPolicy(value); setPolicyOpen(false); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', textAlign: 'left', padding: '8px 14px',
                        background: credentialPolicy === value ? 'var(--vf-accent-subtle)' : 'transparent',
                        border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--vf-text-primary)',
                      }}
                    >
                      {credentialPolicy === value && (
                        <span style={{ color: 'var(--vf-accent)' }}>✓</span>
                      )}
                      <span style={{ marginLeft: credentialPolicy !== value ? 20 : 0 }}>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Validation rules accordion */}
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setValidationRulesOpen((o) => !o)}
              aria-expanded={validationRulesOpen}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', width: '100%',
              }}
            >
              <span aria-hidden>{validationRulesOpen ? '▼' : '▶'}</span>
              Validation rules
            </button>
            {validationRulesOpen && (
              <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '8px 0 0', lineHeight: 1.6 }}>
                Mandatory identity, fingerprints, protocols, parameter constraints, OIDs, commands,
                thresholds, and role visibility are checked before staging.
              </p>
            )}
          </div>

          {/* Validate file button */}
          <button
            onClick={handleValidateFile}
            disabled={!selectedFile || uploading}
            style={{
              ...BTN_PRIMARY,
              marginTop: 20, width: '100%',
              opacity: !selectedFile || uploading ? 0.5 : 1,
              cursor: !selectedFile || uploading ? 'not-allowed' : 'pointer',
            }}
            aria-label="Upload and validate the selected file"
          >
            {uploading ? 'Validating…' : 'Validate file'}
          </button>
        </section>

        {/* ── RIGHT: Tabbed results ── */}
        <section aria-labelledby="results-title" style={CARD_STYLE}>
          <h2 id="results-title" className="sr-only">Definition results</h2>

          {/* Tab bar */}
          <div role="tablist" aria-label="Definition results tabs" style={{ display: 'flex', borderBottom: '1px solid var(--vf-border-subtle)', marginBottom: 20 }}>
            {([
              { id: 'validation', label: 'Validation report' },
              { id: 'versions',   label: 'Versions' },
              { id: 'history',    label: 'All Uploads' },
              { id: 'conflicts',  label: 'Conflicts' },
            ] as { id: RightTab; label: string }[]).map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={rightTab === id}
                onClick={() => setRightTab(id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '8px 18px',
                  fontSize: 13, fontWeight: rightTab === id ? 700 : 400,
                  color: rightTab === id ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                  borderBottom: rightTab === id ? '2px solid var(--vf-accent)' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Validation report tab */}
          {rightTab === 'validation' && (
            <div role="tabpanel" aria-label="Validation report">
              {validationSteps.length === 0 && !draftVersion && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                  Upload a definition file to see the validation report.
                </div>
              )}
              {validationSteps.length > 0 && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
                    {validationSteps.map((step) => (
                      <div key={step.num} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                        <StepCircle num={step.num} severity={step.severity} />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 3 }}>
                            {step.label}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', lineHeight: 1.5 }}>
                            {step.detail}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Stage and activate — shown only when the version is VALID/PENDING and
                      not yet in a terminal lifecycle state (ACTIVE, ARCHIVED, etc.) */}
                  {draftVersion &&
                    draftVersion.validationStatus !== 'INVALID' &&
                    !['ACTIVE', 'STAGED', 'ARCHIVED', 'SUPERSEDED', 'ROLLED_BACK'].includes(
                      draftVersion.lifecycleStatus ?? '',
                    ) && (
                    <button
                      onClick={handleStageAndActivate}
                      disabled={staging || activating}
                      aria-label="Stage and activate this Product Definition"
                      style={{
                        ...BTN_PRIMARY,
                        opacity: staging || activating ? 0.7 : 1,
                        cursor: staging || activating ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {staging ? 'Staging…' : activating ? 'Activating…' : 'Stage and activate'}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Versions tab */}
          {rightTab === 'versions' && (
            <div role="tabpanel" aria-label="Product Definition versions">
              {versionsLoading ? (
                <LoadingState label="Loading versions…" />
              ) : allVersions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                  No Product Definitions found. Upload a file to get started.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {(['Definition', 'Version', 'Status', 'Action'] as const).map((h) => (
                        <th
                          key={h}
                          scope="col"
                          style={{
                            padding: '8px 12px', textAlign: 'left',
                            fontSize: 11, fontWeight: 700,
                            textTransform: 'uppercase', letterSpacing: '0.06em',
                            color: 'var(--vf-text-muted)',
                            borderBottom: '2px solid var(--vf-border-subtle)',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allVersions.map((v) => {
                      const def = definitions.find((d) => d.definitionId === v.definitionId);
                      const isRowStaging    = rowStaging    === v.versionId;
                      const isRowActivating = rowActivating === v.versionId;
                      const canStageRow     = v.lifecycleStatus === 'DRAFT' && v.validationStatus === 'VALID';
                      const canActivateRow  = v.lifecycleStatus === 'STAGED';
                      const hasActiveForDef = allVersions.some(
                        (av) => av.definitionId === v.definitionId && av.lifecycleStatus === 'ACTIVE',
                      );
                      return (
                        <tr
                          key={v.id}
                          style={{
                            borderBottom: '1px solid var(--vf-border-subtle)',
                            // Amber left-border to visually flag superseded rows
                            borderLeft: v.lifecycleStatus === 'SUPERSEDED'
                              ? '3px solid rgba(234,179,8,0.7)' : '3px solid transparent',
                            background: v.lifecycleStatus === 'SUPERSEDED'
                              ? 'rgba(234,179,8,0.04)' : undefined,
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = v.lifecycleStatus === 'SUPERSEDED' ? 'rgba(234,179,8,0.08)' : 'var(--vf-elevated)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = v.lifecycleStatus === 'SUPERSEDED' ? 'rgba(234,179,8,0.04)' : ''; }}
                        >
                          {/* Definition name */}
                          <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                            {def?.name ?? v.name}
                            <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                              {v.vendor} · {v.model}
                            </div>
                          </td>
                          {/* Version ID (truncated) */}
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, color: 'var(--vf-text-secondary)' }}>
                            {v.versionId.slice(0, 18)}…
                            {v.registryVersion != null && (
                              <span style={{ marginLeft: 6, fontSize: 10, background: 'rgba(96,165,250,0.15)', color: '#60a5fa', padding: '1px 5px', borderRadius: 4, fontFamily: 'sans-serif' }}>
                                rv{v.registryVersion}
                              </span>
                            )}
                          </td>
                          {/* Status */}
                          <td style={{ padding: '10px 12px' }}><StatusPill status={v.lifecycleStatus} /></td>
                          {/* Actions */}
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>

                              {/* Review — opens detail drawer */}
                              <button
                                style={BTN_SECONDARY_SM}
                                onClick={() => setReviewedVersion(v)}
                                aria-label={`Review version ${v.versionId}`}
                              >
                                Review
                              </button>

                              {/* Compare — diff against active version */}
                              {v.lifecycleStatus !== 'ACTIVE' && hasActiveForDef && (
                                <button
                                  style={BTN_SECONDARY_SM}
                                  onClick={() => void handleCompare(v)}
                                  aria-label={`Compare ${v.versionId} to active`}
                                >
                                  Compare ↔
                                </button>
                              )}

                              {/* Stage — promote DRAFT/VALID to STAGED */}
                              {canStageRow && (
                                <button
                                  style={{ ...BTN_SECONDARY_SM, background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.35)' }}
                                  disabled={isRowStaging}
                                  onClick={() => void handleRowStage(v)}
                                  aria-label={`Stage version ${v.versionId}`}
                                >
                                  {isRowStaging ? 'Staging…' : '▶ Stage'}
                                </button>
                              )}

                              {/* Activate — make STAGED version ACTIVE */}
                              {canActivateRow && (
                                <button
                                  style={{ ...BTN_SECONDARY_SM, background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.35)' }}
                                  disabled={isRowActivating}
                                  onClick={() => void handleRowActivate(v)}
                                  aria-label={`Activate version ${v.versionId}`}
                                >
                                  {isRowActivating ? 'Activating…' : '✓ Activate'}
                                </button>
                              )}

                              {/* Rollback — restore a SUPERSEDED version */}
                              {v.lifecycleStatus === 'SUPERSEDED' && (
                                <button
                                  style={{ ...BTN_SECONDARY_SM, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)' }}
                                  disabled={rollingBack === v.versionId}
                                  onClick={() => handleRollback(v)}
                                  aria-label={`Rollback to ${v.name} ${v.versionId}`}
                                >
                                  {rollingBack === v.versionId ? 'Rolling back…' : '↩ Rollback'}
                                </button>
                              )}

                              {/* Delete — available for all versions; ACTIVE requires force-confirm */}
                              <button
                                style={{
                                  ...BTN_SECONDARY_SM,
                                  background: 'rgba(239,68,68,0.08)',
                                  color: '#ef4444',
                                  border: '1px solid rgba(239,68,68,0.28)',
                                }}
                                onClick={() => setDeleteTarget(v)}
                                aria-label={`Delete version ${v.versionId}`}
                                title={v.lifecycleStatus === 'ACTIVE'
                                  ? 'Force-delete this active version (Admin only)'
                                  : 'Permanently delete this version'}
                              >
                                🗑 Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* All Uploads / History tab */}
          {rightTab === 'history' && (
            <div role="tabpanel" aria-label="All uploaded product definition files">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
                  All files uploaded to this system — every format, every lifecycle state.
                </span>
                <button
                  style={{ background: 'none', border: '1px solid var(--vf-border-subtle)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--vf-text-secondary)' }}
                  onClick={() => void loadHistory()}
                  disabled={historyLoading}
                >
                  {historyLoading ? 'Refreshing…' : '↻ Refresh'}
                </button>
              </div>
              {historyLoading ? (
                <LoadingState label="Loading upload history…" />
              ) : uploadHistory.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                  No uploads found.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--vf-elevated)' }}>
                      {(['Definition ID', 'Version ID', 'Format', 'Lifecycle', 'Validation', 'Uploaded At', 'Action'] as const).map((h) => (
                        <th key={h} scope="col" style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', borderBottom: '2px solid var(--vf-border-subtle)', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {uploadHistory.map((v) => (
                      <tr
                        key={v.versionId}
                        style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vf-elevated)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                      >
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={v.definitionId}>
                          {v.definitionId}
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                          {(v.versionId ?? '').substring(0, 8)}
                        </td>
                        <td style={{ padding: '9px 10px', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                          {(v as unknown as Record<string, string>)['format'] ?? '—'}
                        </td>
                        <td style={{ padding: '9px 10px' }}><StatusPill status={v.lifecycleStatus} /></td>
                        <td style={{ padding: '9px 10px' }}><StatusPill status={v.validationStatus ?? 'UNKNOWN'} /></td>
                        <td style={{ padding: '9px 10px', color: 'var(--vf-text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                          {v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}
                        </td>
                        {/* Delete action — available for all versions; ACTIVE = force-confirm */}
                        <td style={{ padding: '9px 10px' }}>
                          <button
                            style={{
                              ...BTN_SECONDARY_SM,
                              background: 'rgba(239,68,68,0.08)',
                              color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.28)',
                              whiteSpace: 'nowrap',
                            }}
                            onClick={() => setDeleteTarget(v)}
                            aria-label={`Delete version ${v.versionId}`}
                            title={v.lifecycleStatus === 'ACTIVE'
                              ? 'Force-delete this active version (Admin only)'
                              : 'Permanently delete this version'}
                          >
                            🗑 Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Conflicts tab */}
          {rightTab === 'conflicts' && (
            <div role="tabpanel" aria-label="Product Definition conflicts">
              {conflicts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                  No firmware range or fingerprint conflicts detected.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {conflicts.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex', gap: 14, alignItems: 'flex-start',
                        padding: '14px 16px',
                        border: '1px solid var(--vf-danger)',
                        borderRadius: 'var(--vf-radius-md)',
                        background: 'var(--vf-danger-subtle)',
                      }}
                    >
                      {/* Danger circle */}
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        background: 'var(--vf-danger)', color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, fontWeight: 700, flexShrink: 0,
                      }}>
                        !
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--vf-danger)', marginBottom: 6 }}>
                          {c.title}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--vf-text-primary)', lineHeight: 1.5, marginBottom: 12 }}>
                          {c.detail}
                        </div>
                        <button style={BTN_SECONDARY_SM}>Open resolver</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Validation step builder ────────────────────────────────────────────────────

function buildValidationSteps(version: ProductDefinitionVersion): ValidationStep[] {
  const steps: ValidationStep[] = [];

  // Step 1: Structure
  steps.push({
    num: 1,
    label: 'Structure valid',
    detail: `${version.parameterGroupCount ?? 0} parameter group${(version.parameterGroupCount ?? 0) !== 1 ? 's' : ''} detected for ${version.name}; ${version.fingerprintCount ?? 0} fingerprints parsed.`,
    severity: version.validationStatus === 'INVALID' ? 'error' : 'pass',
  });

  // Step 2: Protocol mappings
  steps.push({
    num: 2,
    label: 'Protocol mappings valid',
    detail: 'REST preferred with CLI fallback. No credential material found.',
    severity: 'pass',
  });

  // Step 3: Staleness threshold warning (always informational for now)
  steps.push({
    num: 3,
    label: 'Warning: stale threshold omitted',
    detail: `${version.parameterGroupCount ?? 3} performance parameters use default staleness rule: 2× poll interval.`,
    severity: 'warning',
  });

  return steps;
}

// ── Style constants ────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border-subtle)',
  borderRadius: 'var(--vf-radius-lg)',
  padding: '24px',
  boxShadow: 'var(--vf-shadow-card)',
};

const CARD_TITLE: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: 'var(--vf-text-primary)',
  margin: '0 0 20px',
};

const FORM_LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--vf-text-muted)',
  marginBottom: 6,
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: '9px 18px',
  borderRadius: 'var(--vf-radius-md)',
  border: 'none',
  background: 'var(--vf-accent)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 700,
};

const BTN_SECONDARY: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 'var(--vf-radius-md)',
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const BTN_SECONDARY_SM: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 'var(--vf-radius-md)',
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};

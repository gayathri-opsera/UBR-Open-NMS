/**
 * ProductDefinitionAdminPage — administrator Product Definition lifecycle workspace (WO-003).
 *
 * Accessible only to Admin and SuperAdmin-equivalent roles (enforced client-side
 * for usability; backend authorization is always authoritative).
 *
 * SECURITY: Does not display or store southbound credential values, raw uploaded
 * file content after submission, or any write/provisioning controls beyond
 * lifecycle state management.  Product parameters are shown as read-only metadata.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { ProductDefinitionUploadPanel } from '../components/product-definitions/ProductDefinitionUploadPanel';
import { ProductDefinitionVersionList } from '../components/product-definitions/ProductDefinitionVersionList';
import { ProductDefinitionValidationReport } from '../components/product-definitions/ProductDefinitionValidationReport';
import { ProductDefinitionLifecycleActions } from '../components/product-definitions/ProductDefinitionLifecycleActions';
import {
  listProductDefinitions,
  listProductDefinitionVersions,
  getProductDefinitionValidationReport,
  getVersionDiff,
  extractApiError,
} from '../../api/productDefinitions.api';
import type {
  DefinitionSummary,
  ProductDefinitionVersion,
  ValidationReport,
  FrameworkApiError,
} from '../../api/productDefinitions.types';
import type { VersionDiffResult, VersionDiffParamChange } from '../../api/productDefinitions.api';

const WRITE_ROLES = ['admin', 'super_admin', 'superadmin'];

function canWrite(role: string | undefined): boolean {
  return WRITE_ROLES.includes((role ?? '').toLowerCase());
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: 'var(--vf-text-secondary)', marginBottom: onRetry ? 16 : 0 }}>
        {message}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ── Error banner ──────────────────────────────────────────────────────────────

function ErrorBanner({ error, onRetry }: { error: FrameworkApiError; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        padding: '12px 16px', background: 'var(--vf-danger-subtle)',
        border: '1px solid var(--vf-danger)', borderRadius: 'var(--vf-radius-md)', marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-danger)' }}>
            {error.error.code}
          </div>
          <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 3 }}>
            {error.error.message}
          </div>
          {error.error.correlationId && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-tertiary)', marginTop: 3 }}>
              Correlation ID: {error.error.correlationId}
            </div>
          )}
        </div>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Definition summary card ───────────────────────────────────────────────────

function DefinitionCard({
  def,
  selected,
  onClick,
}: {
  def: DefinitionSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px',
        background: selected ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
        border: selected ? '1px solid var(--vf-accent)' : '1px solid rgba(77,158,255,0.1)',
        borderRadius: 'var(--vf-radius-sm)', cursor: 'pointer', marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
          {def.name}
        </span>
        {def.activeVersionStatus && (
          <Badge variant={def.activeVersionStatus === 'ACTIVE' ? 'success' : 'default'} dot>
            {def.activeVersionStatus}
          </Badge>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)' }}>
        {def.vendor} · {def.model} · {def.versionCount} version{def.versionCount !== 1 ? 's' : ''}
        {def.registryVersion !== undefined && (
          <> · <span style={{ color: 'var(--vf-accent)' }}>reg v{def.registryVersion}</span></>
        )}
      </div>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ProductDefinitionAdminPage() {
  const { user } = useAuth();
  const role      = (user as { role?: string })?.role;
  const writeOk   = canWrite(role);

  const [definitions, setDefinitions]   = useState<DefinitionSummary[]>([]);
  const [loadingDefs, setLoadingDefs]   = useState(true);
  const [defsError, setDefsError]       = useState<FrameworkApiError | null>(null);

  const [selectedDef, setSelectedDef]           = useState<DefinitionSummary | null>(null);
  const [versions, setVersions]                 = useState<ProductDefinitionVersion[]>([]);
  const [loadingVersions, setLoadingVersions]   = useState(false);
  const [versionsError, setVersionsError]       = useState<FrameworkApiError | null>(null);

  const [selectedVersion, setSelectedVersion]   = useState<ProductDefinitionVersion | null>(null);
  const [report, setReport]                     = useState<ValidationReport | null>(null);
  const [loadingReport, setLoadingReport]       = useState(false);

  // ── Version diff state ──────────────────────────────────────────────────────
  const [diffTarget, setDiffTarget]     = useState<ProductDefinitionVersion | null>(null);
  const [diff, setDiff]                 = useState<VersionDiffResult | null>(null);
  const [loadingDiff, setLoadingDiff]   = useState(false);
  const [diffError, setDiffError]       = useState<string | null>(null);
  const [diffOpen, setDiffOpen]         = useState(false);

  // ── Load definition list ────────────────────────────────────────────────────

  const loadDefinitions = useCallback(async () => {
    setLoadingDefs(true);
    setDefsError(null);
    try {
      const defs = await listProductDefinitions();
      setDefinitions(defs);
    } catch (err) {
      setDefsError(extractApiError(err));
    } finally {
      setLoadingDefs(false);
    }
  }, []);

  useEffect(() => { void loadDefinitions(); }, [loadDefinitions]);

  // ── Load versions when a definition is selected ────────────────────────────

  const loadVersions = useCallback(async (def: DefinitionSummary) => {
    setLoadingVersions(true);
    setVersionsError(null);
    setVersions([]);
    setSelectedVersion(null);
    setReport(null);
    try {
      const vs = await listProductDefinitionVersions(def.definitionId);
      setVersions(vs);
    } catch (err) {
      setVersionsError(extractApiError(err));
    } finally {
      setLoadingVersions(false);
    }
  }, []);

  function handleSelectDefinition(def: DefinitionSummary) {
    setSelectedDef(def);
    void loadVersions(def);
  }

  // ── Load validation report when a version is selected ─────────────────────

  const loadReport = useCallback(async (version: ProductDefinitionVersion) => {
    setLoadingReport(true);
    setReport(null);
    try {
      const r = await getProductDefinitionValidationReport(version.definitionId, version.versionId);
      setReport(r);
    } catch {
      // Validation report is optional — not all versions have one (e.g. SUPERSEDED with no report stored)
      setReport(null);
    } finally {
      setLoadingReport(false);
    }
  }, []);

  function handleSelectVersion(version: ProductDefinitionVersion) {
    setSelectedVersion(version);
    void loadReport(version);
  }

  // ── Version diff ───────────────────────────────────────────────────────────

  async function handleOpenDiff(baseVersion: ProductDefinitionVersion) {
    if (!selectedDef) return;
    // Determine the active version in the current list to compare against
    const activeVersion = versions.find((v) => v.lifecycleStatus === 'ACTIVE');
    if (!activeVersion) {
      setDiffError('No ACTIVE version found to compare against.');
      setDiffOpen(true);
      return;
    }
    if (activeVersion.versionId === baseVersion.versionId) {
      setDiffError('Selected version is already the active version — nothing to diff.');
      setDiffOpen(true);
      return;
    }
    setDiffTarget(baseVersion);
    setDiff(null);
    setDiffError(null);
    setDiffOpen(true);
    setLoadingDiff(true);
    try {
      const result = await getVersionDiff(
        selectedDef.definitionId,
        activeVersion.versionId,  // from = current active
        baseVersion.versionId,    // to   = selected version
      );
      setDiff(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDiffError(`Failed to load diff: ${msg}`);
    } finally {
      setLoadingDiff(false);
    }
  }

  // ── After a lifecycle action, refresh the definition + version list ────────

  const handleActionComplete = useCallback(async (definitionId: string) => {
    // Refresh version list for the affected definition
    const matchingDef = definitions.find((d) => d.definitionId === definitionId) ?? selectedDef;
    if (matchingDef) {
      await loadVersions(matchingDef);
    }
    // Refresh definition summaries to pick up new active version / registry version
    void loadDefinitions();
  }, [definitions, selectedDef, loadVersions, loadDefinitions]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', gap: 24, minHeight: 400 }}>
      {/* Left sidebar: definition list + upload */}
      <div style={{ width: 280, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Definitions</h2>
          <Button variant="ghost" size="sm" onClick={loadDefinitions} aria-label="Refresh definitions list">
            ↺ Refresh
          </Button>
        </div>

        {loadingDefs && (
          <div role="status" aria-busy="true" aria-label="Loading definitions" style={{ fontSize: 13, color: 'var(--vf-text-secondary)', padding: 12 }}>
            Loading…
          </div>
        )}

        {defsError && !loadingDefs && (
          <ErrorBanner error={defsError} onRetry={loadDefinitions} />
        )}

        {!loadingDefs && !defsError && definitions.length === 0 && (
          <EmptyState message="No product definitions found. Upload one to get started." />
        )}

        {definitions.map((def) => (
          <DefinitionCard
            key={def.definitionId}
            def={def}
            selected={selectedDef?.definitionId === def.definitionId}
            onClick={() => handleSelectDefinition(def)}
          />
        ))}

        {/* Upload panel — only for write-capable roles */}
        {writeOk && (
          <div style={{ marginTop: 20 }}>
            <ProductDefinitionUploadPanel
              onUploadComplete={({ version }) => {
                void loadDefinitions();
                // Auto-select the new definition
                void loadVersions({ definitionId: version.definitionId, name: version.name, vendor: version.vendor, model: version.model, versionCount: 1, updatedAt: version.updatedAt });
              }}
            />
          </div>
        )}
      </div>

      {/* Right panel: version list + detail */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!selectedDef && (
          <EmptyState message="Select a Product Definition to view its versions." />
        )}

        {selectedDef && (
          <>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{selectedDef.name}</h2>
              <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 4 }}>
                {selectedDef.vendor} · {selectedDef.model}
              </div>
            </div>

            {versionsError && (
              <ErrorBanner error={versionsError} onRetry={() => loadVersions(selectedDef)} />
            )}

            <ProductDefinitionVersionList
              versions={versions}
              selectedVersionId={selectedVersion?.versionId}
              onSelect={handleSelectVersion}
              loading={loadingVersions}
              emptyMessage="No versions uploaded for this definition."
            />

            {/* Version detail panel */}
            {selectedVersion && (
              <div style={{ marginTop: 20, background: 'var(--vf-surface)', borderRadius: 'var(--vf-radius-md)', padding: '16px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
                    Version {selectedVersion.versionId}
                  </h3>
                  <Badge variant={selectedVersion.lifecycleStatus === 'ACTIVE' ? 'success' : selectedVersion.lifecycleStatus === 'STAGED' ? 'info' : 'default'} dot>
                    {selectedVersion.lifecycleStatus}
                  </Badge>
                </div>

                {/* Read-only metadata — no credentials, no raw file content */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px 16px', fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 14 }}>
                  <div><span style={{ color: 'var(--vf-text-tertiary)' }}>Format:</span> {selectedVersion.uploadedFormat}</div>
                  <div><span style={{ color: 'var(--vf-text-tertiary)' }}>Fingerprints:</span> {selectedVersion.fingerprintCount ?? '—'}</div>
                  <div><span style={{ color: 'var(--vf-text-tertiary)' }}>Param Groups:</span> {selectedVersion.parameterGroupCount ?? '—'}</div>
                  {selectedVersion.registryVersion !== undefined && (
                    <div><span style={{ color: 'var(--vf-text-tertiary)' }}>Registry Ver.:</span> {selectedVersion.registryVersion}</div>
                  )}
                  {selectedVersion.correlationId && (
                    <div style={{ gridColumn: '1 / -1', fontFamily: 'monospace', fontSize: 11, color: 'var(--vf-text-tertiary)' }}>
                      corr: {selectedVersion.correlationId}
                    </div>
                  )}
                </div>

                {/* Compare to Active button (show for non-active versions) */}
                {selectedVersion.lifecycleStatus !== 'ACTIVE' && versions.some((v) => v.lifecycleStatus === 'ACTIVE') && (
                  <div style={{ marginBottom: 12 }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleOpenDiff(selectedVersion)}
                      style={{ fontSize: 12 }}
                    >
                      Compare to Active Version
                    </Button>
                  </div>
                )}

                {/* Lifecycle actions */}
                <ProductDefinitionLifecycleActions
                  version={selectedVersion}
                  allVersions={versions}
                  canWrite={writeOk}
                  onActionComplete={handleActionComplete}
                />

                {/* Validation report */}
                {(loadingReport || report) && (
                  <div style={{ marginTop: 16 }}>
                    <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 10px' }}>Validation Report</h4>
                    {loadingReport && (
                      <div role="status" aria-busy="true" style={{ fontSize: 13, color: 'var(--vf-text-secondary)' }}>Loading report…</div>
                    )}
                    {!loadingReport && report && (
                      <ProductDefinitionValidationReport report={report} />
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Version diff slide-over drawer ── */}
      {diffOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Version diff"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', justifyContent: 'flex-end',
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setDiffOpen(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }}
            aria-hidden="true"
          />
          {/* Panel */}
          <div style={{
            position: 'relative', zIndex: 1,
            width: '580px', maxWidth: '95vw',
            height: '100%', overflowY: 'auto',
            background: 'var(--vf-background)',
            borderLeft: '1px solid var(--vf-border-subtle)',
            boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
            padding: '24px 24px 40px',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Version Diff</h2>
                {diffTarget && (
                  <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '4px 0 0' }}>
                    Active → {diffTarget.versionId.slice(0, 12)}…
                  </p>
                )}
              </div>
              <button
                onClick={() => setDiffOpen(false)}
                aria-label="Close diff panel"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--vf-text-secondary)', padding: 4 }}
              >
                ×
              </button>
            </div>

            {loadingDiff && (
              <div style={{ fontSize: 13, color: 'var(--vf-text-secondary)', textAlign: 'center', padding: 32 }}>
                Computing diff…
              </div>
            )}

            {diffError && (
              <div style={{ padding: 14, background: 'var(--vf-danger-subtle)', border: '1px solid var(--vf-danger)', borderRadius: 8, fontSize: 13, color: 'var(--vf-danger)' }}>
                {diffError}
              </div>
            )}

            {!loadingDiff && !diffError && diff && (
              <>
                {/* Summary chips */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {[
                    { label: `${diff.added.length} Added`,   color: 'var(--vf-success)',  bg: 'var(--vf-success-subtle)'  },
                    { label: `${diff.removed.length} Removed`, color: 'var(--vf-danger)',  bg: 'var(--vf-danger-subtle)'   },
                    { label: `${diff.modified.length} Modified`, color: 'var(--vf-warning)', bg: 'var(--vf-warning-subtle)'  },
                    { label: `${diff.moved.length} Moved`,    color: 'var(--vf-accent)',   bg: 'var(--vf-elevated)'        },
                    { label: `${diff.permissionChanged.length} Permission`, color: 'var(--vf-text-secondary)', bg: 'var(--vf-surface)' },
                  ].map(({ label, color, bg }) => (
                    <span key={label} style={{
                      padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                      background: bg, color,
                    }}>
                      {label}
                    </span>
                  ))}
                </div>

                {/* Change sections */}
                {([
                  { title: '➕ Added', items: diff.added,             color: 'var(--vf-success)' },
                  { title: '➖ Removed', items: diff.removed,          color: 'var(--vf-danger)'  },
                  { title: '✏️ Modified', items: diff.modified,        color: 'var(--vf-warning)' },
                  { title: '↕ Moved', items: diff.moved,              color: 'var(--vf-accent)'  },
                  { title: '🔐 Permission Changed', items: diff.permissionChanged, color: 'var(--vf-text-secondary)' },
                ] as { title: string; items: VersionDiffParamChange[]; color: string }[]).map(({ title, items, color }) => items.length > 0 && (
                  <div key={title}>
                    <h3 style={{ fontSize: 13, fontWeight: 700, color, margin: '0 0 8px' }}>{title}</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {items.map((change) => (
                        <div key={change.parameterId} style={{
                          background: 'var(--vf-surface)',
                          border: '1px solid var(--vf-border-subtle)',
                          borderRadius: 8, padding: '10px 14px',
                        }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {change.label ?? change.parameterId}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--vf-text-secondary)', fontFamily: 'monospace', marginTop: 2 }}>
                            {change.parameterId}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 4 }}>
                            {change.summary}
                          </div>
                          {change.fromGroupId !== change.toGroupId && change.fromGroupId && change.toGroupId && (
                            <div style={{ fontSize: 11, color: 'var(--vf-text-tertiary)', marginTop: 2 }}>
                              Group: {change.fromGroupId} → {change.toGroupId}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0
                  && diff.moved.length === 0 && diff.permissionChanged.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--vf-text-muted)', fontSize: 13 }}>
                    ✓ No parameter changes between these versions.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

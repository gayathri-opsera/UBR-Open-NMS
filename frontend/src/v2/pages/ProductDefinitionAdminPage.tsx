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
  extractApiError,
} from '../../api/productDefinitions.api';
import type {
  DefinitionSummary,
  ProductDefinitionVersion,
  ValidationReport,
  FrameworkApiError,
} from '../../api/productDefinitions.types';

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
    </div>
  );
}

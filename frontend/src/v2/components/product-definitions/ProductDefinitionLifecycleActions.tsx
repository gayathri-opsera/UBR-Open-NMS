/**
 * ProductDefinitionLifecycleActions — stage / activate / rollback actions (WO-003).
 *
 * Provides confirmation dialogs, reason capture for rollback, idempotency key
 * generation, success toasts, and failure toasts that include structured backend
 * error messages and correlationId.
 *
 * SECURITY: Does not display or store southbound credential values, raw file
 * content, or write/provisioning controls.
 */
import React, { useState } from 'react';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import type { ProductDefinitionVersion, FrameworkApiError } from '../../../api/productDefinitions.types';
import {
  stageProductDefinitionVersion,
  activateProductDefinitionVersion,
  rollbackProductDefinition,
  generateIdempotencyKey,
  extractApiError,
  getVersionDiff,
} from '../../../api/productDefinitions.api';
import type { VersionDiffResult } from '../../../api/productDefinitions.api';

// ── Action result toast ───────────────────────────────────────────────────────

type ToastKind = 'success' | 'error';

interface Toast {
  kind: ToastKind;
  title: string;
  message: string;
  correlationId?: string;
}

function ToastBanner({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: '12px 16px',
        borderRadius: 'var(--vf-radius-md)',
        background: toast.kind === 'success' ? 'var(--vf-success-subtle)' : 'var(--vf-danger-subtle)',
        border: `1px solid ${toast.kind === 'success' ? 'var(--vf-success)' : 'var(--vf-danger)'}`,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: toast.kind === 'success' ? 'var(--vf-success)' : 'var(--vf-danger)' }}>
          {toast.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 3 }}>{toast.message}</div>
        {toast.correlationId && (
          <div style={{ fontSize: 11, color: 'var(--vf-text-tertiary)', marginTop: 3 }}>
            Correlation ID: {toast.correlationId}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        style={{ background: 'none', border: 'none', color: 'var(--vf-text-secondary)', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

// ── Confirmation modal ────────────────────────────────────────────────────────

interface ConfirmModalProps {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

function ConfirmModal({ title, body, confirmLabel, destructive, onConfirm, onCancel, busy }: ConfirmModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--vf-surface)', borderRadius: 'var(--vf-radius-lg)', padding: 28,
          maxWidth: 480, width: '90%', boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
      >
        <h2 id="modal-title" style={{ fontSize: 16, fontWeight: 700, marginTop: 0, marginBottom: 12 }}>
          {title}
        </h2>
        <div style={{ fontSize: 13, color: 'var(--vf-text-secondary)', marginBottom: 20 }}>
          {body}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  version: ProductDefinitionVersion;
  /** All versions for this definition — used to select rollback candidates. */
  allVersions: ProductDefinitionVersion[];
  /** Whether the current user has write access. If false, buttons are hidden. */
  canWrite: boolean;
  onActionComplete: (refreshDefinitionId: string) => void;
}

type ModalState =
  | { type: 'none' }
  | { type: 'stage' }
  | { type: 'activate'; diff: VersionDiffResult | null; loadingDiff: boolean }
  | { type: 'rollback'; reason: string; targetVersionId: string };

export function ProductDefinitionLifecycleActions({ version, allVersions, canWrite, onActionComplete }: Props) {
  const [modal, setModal]   = useState<ModalState>({ type: 'none' });
  const [busy, setBusy]     = useState(false);
  const [toast, setToast]   = useState<Toast | null>(null);

  if (!canWrite) return null;

  const canStage    = version.lifecycleStatus === 'DRAFT' && version.validationStatus === 'VALID';
  const canActivate = version.lifecycleStatus === 'STAGED';
  const rollbackCandidates = allVersions.filter(
    (v) => v.definitionId === version.definitionId && v.lifecycleStatus === 'SUPERSEDED',
  );
  const canRollback = version.lifecycleStatus === 'ACTIVE' && rollbackCandidates.length > 0;

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function doStage() {
    setBusy(true);
    try {
      await stageProductDefinitionVersion(version.definitionId, version.versionId);
      setModal({ type: 'none' });
      setToast({ kind: 'success', title: 'Version staged', message: `${version.versionId} is now STAGED and ready for activation.` });
      onActionComplete(version.definitionId);
    } catch (err) {
      const e = err as FrameworkApiError;
      setModal({ type: 'none' });
      setToast({
        kind: 'error',
        title: `Stage failed — ${e.error?.code ?? 'ERROR'}`,
        message: e.error?.message ?? 'An unexpected error occurred.',
        correlationId: e.error?.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  async function doActivate() {
    setBusy(true);
    const idempotencyKey = generateIdempotencyKey();
    try {
      const result = await activateProductDefinitionVersion(
        version.definitionId,
        version.versionId,
        idempotencyKey,
      );
      setModal({ type: 'none' });
      setToast({
        kind: 'success',
        title: 'Version activated',
        message: `${version.versionId} is now ACTIVE. Registry version: ${result.registryVersion}.`,
        correlationId: result.correlationId,
      });
      onActionComplete(version.definitionId);
    } catch (err) {
      const e = err as FrameworkApiError;
      setModal({ type: 'none' });
      setToast({
        kind: 'error',
        title: `Activation failed — ${e.error?.code ?? 'ERROR'}`,
        message: e.error?.message ?? 'An unexpected error occurred.',
        correlationId: e.error?.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  async function doRollback(targetVersionId: string, reason: string) {
    setBusy(true);
    try {
      const result = await rollbackProductDefinition(version.definitionId, targetVersionId, reason);
      setModal({ type: 'none' });
      setToast({
        kind: 'success',
        title: 'Rollback complete',
        message: `Definition rolled back to ${result.version.versionId}.`,
        correlationId: result.correlationId,
      });
      onActionComplete(version.definitionId);
    } catch (err) {
      const e = err as FrameworkApiError;
      setModal({ type: 'none' });
      setToast({
        kind: 'error',
        title: `Rollback failed — ${e.error?.code ?? 'ERROR'}`,
        message: e.error?.message ?? 'An unexpected error occurred.',
        correlationId: e.error?.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {toast && (
        <ToastBanner toast={toast} onClose={() => setToast(null)} />
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Stage */}
        <Button
          variant="secondary"
          size="sm"
          disabled={!canStage}
          onClick={() => setModal({ type: 'stage' })}
          aria-label={canStage ? 'Stage this version' : version.validationStatus !== 'VALID' ? 'Cannot stage: validation status is not VALID' : `Cannot stage: lifecycle status is ${version.lifecycleStatus}`}
          title={!canStage ? `Stage requires DRAFT + VALID (current: ${version.lifecycleStatus}, ${version.validationStatus})` : undefined}
        >
          Stage
        </Button>

        {/* Activate */}
        <Button
          variant="primary"
          size="sm"
          disabled={!canActivate}
          onClick={async () => {
            // Show the modal immediately with loading diff
            setModal({ type: 'activate', diff: null, loadingDiff: true });
            // Try to find the currently active version in allVersions for diff
            const activeVersion = allVersions.find(
              (v) => v.definitionId === version.definitionId && v.lifecycleStatus === 'ACTIVE',
            );
            if (activeVersion) {
              try {
                const diffResult = await getVersionDiff(
                  version.definitionId,
                  activeVersion.versionId,
                  version.versionId,
                );
                setModal({ type: 'activate', diff: diffResult, loadingDiff: false });
              } catch {
                // Diff failed — show modal without diff (non-blocking)
                setModal({ type: 'activate', diff: null, loadingDiff: false });
              }
            } else {
              // No current active version (first activation) — skip diff
              setModal({ type: 'activate', diff: null, loadingDiff: false });
            }
          }}
          aria-label={canActivate ? 'Activate this version' : `Cannot activate: lifecycle status is ${version.lifecycleStatus}`}
          title={!canActivate ? `Activate requires STAGED (current: ${version.lifecycleStatus})` : undefined}
        >
          Activate
        </Button>

        {/* Rollback */}
        {canRollback && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setModal({ type: 'rollback', reason: '', targetVersionId: rollbackCandidates[0]?.versionId ?? '' })}
            aria-label="Roll back to a prior version"
          >
            Rollback
          </Button>
        )}
      </div>

      {/* Stage modal */}
      {modal.type === 'stage' && (
        <ConfirmModal
          title="Stage this version?"
          body={
            <>
              <p style={{ margin: 0 }}>
                Version <strong>{version.versionId}</strong> of <strong>{version.name}</strong> will be
                moved to <Badge variant="info">STAGED</Badge> status and held for activation review.
              </p>
              <p style={{ margin: '10px 0 0' }}>This action cannot be undone without manual retraction.</p>
            </>
          }
          confirmLabel="Stage Version"
          onConfirm={doStage}
          onCancel={() => setModal({ type: 'none' })}
          busy={busy}
        />
      )}

      {/* Activate modal with change-impact diff */}
      {modal.type === 'activate' && (
        <ConfirmModal
          title="Activate this version?"
          body={
            <>
              <p style={{ margin: 0 }}>
                Version <strong>{version.versionId}</strong> will become <Badge variant="success">ACTIVE</Badge>.
                The fingerprint and parameter registries will be rebuilt from this version.
              </p>
              <p style={{ margin: '10px 0 0' }}>
                The currently active version (if any) will be marked <Badge variant="warning">SUPERSEDED</Badge>.
              </p>

              {/* ── Change-impact summary ── */}
              {modal.loadingDiff && (
                <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--vf-elevated)', borderRadius: 8, fontSize: 12, color: 'var(--vf-text-secondary)' }}>
                  Computing parameter change impact…
                </div>
              )}

              {!modal.loadingDiff && modal.diff && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
                    Parameter Change Impact
                  </div>
                  {/* Summary chips */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    {modal.diff.added.length > 0 && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--vf-success-subtle)', color: 'var(--vf-success)' }}>
                        +{modal.diff.added.length} added
                      </span>
                    )}
                    {modal.diff.removed.length > 0 && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--vf-danger-subtle)', color: 'var(--vf-danger)' }}>
                        -{modal.diff.removed.length} removed
                      </span>
                    )}
                    {modal.diff.modified.length > 0 && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--vf-warning-subtle)', color: 'var(--vf-warning)' }}>
                        {modal.diff.modified.length} modified
                      </span>
                    )}
                    {modal.diff.moved.length > 0 && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--vf-elevated)', color: 'var(--vf-accent)' }}>
                        {modal.diff.moved.length} moved
                      </span>
                    )}
                    {modal.diff.permissionChanged.length > 0 && (
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)' }}>
                        {modal.diff.permissionChanged.length} permission
                      </span>
                    )}
                    {modal.diff.added.length === 0 && modal.diff.removed.length === 0 &&
                     modal.diff.modified.length === 0 && modal.diff.moved.length === 0 &&
                     modal.diff.permissionChanged.length === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--vf-success)' }}>
                        ✓ No parameter changes from active version
                      </span>
                    )}
                  </div>
                  {/* List of changes (capped to 8 for modal brevity) */}
                  {[...modal.diff.removed, ...modal.diff.added, ...modal.diff.modified].slice(0, 8).map((ch) => (
                    <div key={ch.parameterId} style={{ fontSize: 11, color: 'var(--vf-text-secondary)', padding: '3px 0', borderBottom: '1px solid var(--vf-border-subtle)' }}>
                      {ch.summary}
                    </div>
                  ))}
                  {modal.diff.removed.length + modal.diff.added.length + modal.diff.modified.length > 8 && (
                    <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 4 }}>
                      … and {modal.diff.removed.length + modal.diff.added.length + modal.diff.modified.length - 8} more changes
                    </div>
                  )}
                </div>
              )}

              {!modal.loadingDiff && !modal.diff && (
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--vf-text-muted)' }}>
                  This will be the first active version — no previous parameters to compare.
                </p>
              )}
            </>
          }
          confirmLabel={modal.loadingDiff ? 'Loading diff…' : 'Activate'}
          destructive
          onConfirm={modal.loadingDiff ? async () => {} : doActivate}
          onCancel={() => setModal({ type: 'none' })}
          busy={busy}
        />
      )}

      {/* Rollback modal */}
      {modal.type === 'rollback' && (
        <ConfirmModal
          title="Roll back to a prior version?"
          body={
            <div>
              <p style={{ margin: '0 0 12px' }}>
                This will replace <Badge variant="success">ACTIVE</Badge> version <strong>{version.versionId}</strong> with
                the selected prior version.
              </p>
              <label htmlFor="rollback-target" style={{ display: 'block', fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 4 }}>
                Target version *
              </label>
              <select
                id="rollback-target"
                value={modal.targetVersionId}
                onChange={(e) => setModal({ ...modal, targetVersionId: e.target.value })}
                style={{ width: '100%', padding: '6px 8px', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', border: '1px solid rgba(77,158,255,0.2)', borderRadius: 'var(--vf-radius-sm)', marginBottom: 12 }}
                aria-label="Select rollback target version"
              >
                {rollbackCandidates.map((v) => (
                  <option key={v.versionId} value={v.versionId}>
                    {v.versionId} (superseded {v.supersededAt ? new Date(v.supersededAt).toLocaleDateString() : ''})
                  </option>
                ))}
              </select>
              <label htmlFor="rollback-reason" style={{ display: 'block', fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 4 }}>
                Reason for rollback *
              </label>
              <textarea
                id="rollback-reason"
                value={modal.reason}
                onChange={(e) => setModal({ ...modal, reason: e.target.value })}
                placeholder="Describe why you are rolling back this definition…"
                rows={3}
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', border: '1px solid rgba(77,158,255,0.2)', borderRadius: 'var(--vf-radius-sm)', resize: 'vertical' }}
                aria-required="true"
              />
            </div>
          }
          confirmLabel="Roll Back"
          destructive
          onConfirm={() => {
            if (!modal.reason.trim()) return; // require reason
            doRollback(modal.targetVersionId, modal.reason.trim());
          }}
          onCancel={() => setModal({ type: 'none' })}
          busy={busy}
        />
      )}
    </div>
  );
}

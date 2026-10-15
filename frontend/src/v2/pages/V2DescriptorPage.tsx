/**
 * V2DescriptorPage — Device Descriptor Registry
 *
 * Full 9-state lifecycle management for Device Descriptors per the
 * Unified NMS Architecture (PPT Slides 3, 9):
 *
 *   Draft → Validating → Valid/Invalid → Approved → Active
 *         → Deprecated → Retired → Purged
 *
 * Features:
 *   • Upload descriptor (XML / JSON / XLS/XLSX)
 *   • Lint validation (errors + warnings)
 *   • Maker-checker approve (different user from uploader)
 *   • Activate (builds wireframe for all bound devices)
 *   • Deprecate / Retire (server-side delete guard → 409 DEFINITION_IN_USE)
 *   • Purge (90-day retention check)
 *   • Delete Draft/Invalid
 *   • Dependency counts + Impact report
 *   • Bulk migrate to target version
 *
 * RBAC:
 *   descriptor_admin  — all lifecycle actions (approve, activate, deprecate, retire, purge)
 *   descriptor_author — upload + validate + delete draft
 *   All other roles   — read-only (list + view)
 *
 * Security: secret parameters are never displayed. File contents are
 * sent once to the server and never stored in React state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/common/Toast';
import { Button } from '../components/common/Button';
import { LoadingState } from '../components/common/States';
import {
  listDescriptors,
  uploadDescriptor,
  listVersions,
  getVersion,
  getDependents,
  getImpactReport,
  validateDescriptor,
  approveDescriptor,
  activateDescriptor,
  deprecateDescriptor,
  retireDescriptor,
  purgeDescriptor,
  deleteDescriptorDraft,
  migrateDescriptor,
  extractDescriptorError,
} from '../../api/descriptors.api';
import type {
  DescriptorSummary,
  DescriptorVersion,
  DependentsResponse,
  ImpactReport,
  ValidationResult,
  DescriptorState,
} from '../../api/descriptors.types';
import { useAuth } from '../../contexts/AuthContext';

// ── Types ─────────────────────────────────────────────────────────────────────

type RightTab = 'versions' | 'validation' | 'dependents' | 'impact' | 'history';

// ── State badge helpers ────────────────────────────────────────────────────────

function stateStyle(state: DescriptorState): React.CSSProperties {
  switch (state) {
    case 'Active':      return { background: 'var(--vf-success-subtle)', color: 'var(--vf-success)',      border: '1px solid var(--vf-success)' };
    case 'Approved':    return { background: 'rgba(99,102,241,0.12)',     color: '#6366f1',                border: '1px solid rgba(99,102,241,0.4)' };
    case 'Valid':       return { background: 'rgba(34,197,94,0.10)',      color: '#16a34a',                border: '1px solid rgba(34,197,94,0.3)' };
    case 'Validating':  return { background: 'rgba(234,179,8,0.12)',      color: '#ca8a04',                border: '1px solid rgba(234,179,8,0.3)' };
    case 'Draft':       return { background: 'var(--vf-elevated)',        color: 'var(--vf-text-secondary)', border: '1px solid var(--vf-border-subtle)' };
    case 'Invalid':     return { background: 'rgba(239,68,68,0.10)',      color: 'var(--vf-danger)',       border: '1px solid rgba(239,68,68,0.3)' };
    case 'Deprecated':  return { background: 'rgba(234,179,8,0.10)',      color: '#d97706',                border: '1px solid rgba(234,179,8,0.25)' };
    case 'Retired':     return { background: 'var(--vf-elevated)',        color: 'var(--vf-text-muted)',   border: '1px solid var(--vf-border-subtle)' };
    case 'Purged':      return { background: 'rgba(107,114,128,0.10)',    color: '#9ca3af',                border: '1px solid rgba(107,114,128,0.3)' };
    default:            return { background: 'var(--vf-elevated)',        color: 'var(--vf-text-secondary)', border: '1px solid var(--vf-border-subtle)' };
  }
}

function StatePill({ state }: { state: DescriptorState }) {
  return (
    <span style={{
      ...stateStyle(state),
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      {state}
    </span>
  );
}

// ── Lifecycle flow helpers ─────────────────────────────────────────────────────

/** States from which a specific action is allowed on the current version */
const ACTION_ALLOWED_FROM: Record<string, DescriptorState[]> = {
  validate:   ['Draft', 'Invalid'],
  approve:    ['Valid'],
  activate:   ['Approved'],
  deprecate:  ['Active'],
  retire:     ['Deprecated'],
  purge:      ['Retired'],
  deleteDraft:['Draft', 'Invalid'],
};

function canTakeAction(action: string, state: DescriptorState): boolean {
  return (ACTION_ALLOWED_FROM[action] ?? []).includes(state);
}

// ── Dependency counter badge ───────────────────────────────────────────────────

function DepCount({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{
        fontSize: 20, fontWeight: 700,
        color: warn && value > 0 ? 'var(--vf-danger)' : 'var(--vf-text-primary)',
      }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ── Reason modal ──────────────────────────────────────────────────────────────

function ReasonModal({
  title, placeholder, onConfirm, onCancel, confirmLabel = 'Confirm', danger = false,
}: {
  title: string;
  placeholder: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--vf-surface)', border: '1px solid var(--vf-border)',
        borderRadius: 'var(--vf-radius)', padding: 24, minWidth: 360, maxWidth: 480, width: '90%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>{title}</h3>
        <textarea
          placeholder={placeholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{
            width: '100%', resize: 'vertical', padding: '8px 10px',
            border: '1px solid var(--vf-border)', borderRadius: 'var(--vf-radius-sm)',
            background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)',
            fontSize: 13, lineHeight: 1.5, boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'} size="sm"
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

export default function V2DescriptorPage() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Upload form ────────────────────────────────────────────────────────────
  const [productId, setProductId] = useState('');
  const [version, setVersion]     = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // ── OID → vendor/model lookup table ───────────────────────────────────────
  const ENTERPRISE_OID_MAP: Record<string, { vendor: string; model: string }> = {
    '52619': { vendor: 'ubr-networks', model: 'ubr-650' },
    '4413':  { vendor: 'ubiquiti',     model: 'airmax'  },
    '41112': { vendor: 'cambium',      model: 'epmp'    },
  };

  /** Sniff a file selection: auto-populate productId and version. */
  const handleFileSelect = useCallback((file: File | null) => {
    setSelectedFile(file);
    if (!file) return;

    // Auto-fill version with 1.0.0 if empty
    setVersion((v) => v.trim() || '1.0.0');

    const lname = file.name.toLowerCase();
    const isXml  = lname.endsWith('.xml');
    const isXlsx = lname.endsWith('.xlsx') || lname.endsWith('.xls');

    if (!isXml && !isXlsx) return;

    // Read first 8 KB to sniff OID prefix and derive product ID
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const snippet = (ev.target?.result as string) || '';

        // Look for enterprise OID pattern: .1.3.6.1.4.1.<enterprise>
        const oidMatch = snippet.match(/1\.3\.6\.1\.4\.1\.(\d+)/);
        const enterprise = oidMatch ? oidMatch[1] : null;
        const known = enterprise ? ENTERPRISE_OID_MAP[enterprise] : null;

        if (known) {
          setProductId((p) => p.trim() || `${known.vendor}.${known.model}`);
        } else {
          // Fallback: slugify filename (strip extension, lowercase, spaces→hyphens)
          const slug = file.name
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          setProductId((p) => p.trim() || slug);
        }
      } catch (_) { /* skip */ }
    };
    // Read first 8 KB as text to find OIDs
    reader.readAsText(file.slice(0, 8192));
  }, []);

  // ── Descriptor list ────────────────────────────────────────────────────────
  const [descriptors, setDescriptors]     = useState<DescriptorSummary[]>([]);
  const [loadingList, setLoadingList]     = useState(true);
  const [listError, setListError]         = useState<string | null>(null);

  // ── Selected descriptor for actions ───────────────────────────────────────
  const [selected, setSelected]           = useState<DescriptorSummary | null>(null);
  const [fullVersion, setFullVersion]     = useState<DescriptorVersion | null>(null);
  const [versionsForProduct, setVersionsForProduct] = useState<DescriptorSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId]   = useState<string>('');

  // ── Right panel tabs ───────────────────────────────────────────────────────
  const [rightTab, setRightTab] = useState<RightTab>('versions');
  const [dependents, setDependents]       = useState<DependentsResponse | null>(null);
  const [impactReport, setImpactReport]   = useState<ImpactReport | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loadingRight, setLoadingRight]   = useState(false);

  // ── Busy overlay per-action ────────────────────────────────────────────────
  const [busyAction, setBusyAction]       = useState<string | null>(null);

  // ── Migrate panel ──────────────────────────────────────────────────────────
  const [showMigrate, setShowMigrate]     = useState(false);
  const [migrateTarget, setMigrateTarget] = useState('');
  const [migrating, setMigrating]         = useState(false);

  // ── Reason modal ──────────────────────────────────────────────────────────
  const [reasonModal, setReasonModal] = useState<{
    title: string; placeholder: string; confirmLabel: string; danger: boolean;
    resolve: (r: string) => void;
  } | null>(null);

  // ── RBAC helpers ───────────────────────────────────────────────────────────
  const role     = String(user?.role || '').toLowerCase();
  const isAdmin  = role === 'admin' || role === 'descriptor_admin';
  const isAuthor = isAdmin || role === 'descriptor_author';

  // ── Helpers ────────────────────────────────────────────────────────────────

  function askReason(title: string, placeholder: string, confirmLabel = 'Confirm', danger = false): Promise<string> {
    return new Promise((resolve) => setReasonModal({ title, placeholder, confirmLabel, danger, resolve }));
  }

  // ── Load descriptor list ───────────────────────────────────────────────────

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const data = await listDescriptors();
      setDescriptors(data);
    } catch (err) {
      const e = extractDescriptorError(err);
      setListError(e.error.message);
      addToast(e.error.message, 'error');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // ── Select a descriptor row ────────────────────────────────────────────────

  const selectRow = useCallback(async (row: DescriptorSummary) => {
    setSelected(row);
    setFullVersion(null);
    setValidationResult(null);
    setDependents(null);
    setImpactReport(null);
    setRightTab('versions');
    setLoadingRight(true);
    try {
      const versions = await listVersions(row.productDefinitionId);
      setVersionsForProduct(versions);
      // Pick latest non-purged version
      const latest = versions.find((v) => v.state !== 'Purged') || versions[0];
      if (latest) {
        setSelectedVersionId(latest.version);
        const full = await getVersion(row.productDefinitionId, latest.version);
        setFullVersion(full);
      }
    } catch (err) {
      addToast('Failed to load descriptor versions', 'error');
    } finally {
      setLoadingRight(false);
    }
  }, [addToast]);

  // ── Select a specific version ──────────────────────────────────────────────

  const selectVersion = useCallback(async (version: string) => {
    if (!selected) return;
    setSelectedVersionId(version);
    setLoadingRight(true);
    setValidationResult(null);
    setDependents(null);
    setImpactReport(null);
    try {
      const full = await getVersion(selected.productDefinitionId, version);
      setFullVersion(full);
    } catch (err) {
      addToast('Failed to load version details', 'error');
    } finally {
      setLoadingRight(false);
    }
  }, [selected, addToast]);

  // ── Upload ─────────────────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    if (!selectedFile) { addToast('Select a descriptor file first', 'warning'); return; }
    if (!productId.trim()) { addToast('Product Definition ID is required', 'warning'); return; }
    if (!/^\d+\.\d+\.\d+$/.test(version.trim())) {
      addToast('Version must be semver format (e.g. 1.0.0)', 'warning');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadDescriptor({ productDefinitionId: productId.trim(), version: version.trim(), file: selectedFile });

      // Handle server-side duplicate/re-upload intelligence
      const note = (result as unknown as Record<string, unknown>)?.note as string | undefined;
      const msg  = (result as unknown as Record<string, unknown>)?.message as string | undefined;

      if (note === 'DUPLICATE_REACTIVATED') {
        // Same content, previous version was Deprecated/Retired — new Draft auto-created
        addToast(msg || `New Draft v${result.version} created from deprecated content — validate → approve → activate`, 'info');
      } else if (note === 'DUPLICATE_IN_PROGRESS') {
        addToast(msg || `Existing ${result.state} version resumed`, 'info');
      } else if (note === 'ALREADY_ACTIVE') {
        addToast(`${productId} v${version} is already Active`, 'info');
      } else {
        addToast(`Descriptor ${productId} v${result.version} uploaded as Draft`, 'success');
      }

      setSelectedFile(null);
      setProductId('');
      setVersion('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadList();
    } catch (err) {
      const e = extractDescriptorError(err);
      // Provide actionable messages for common duplicate scenarios
      if (e.error.code === 'DUPLICATE_CONTENT') {
        const detail = e.error.details as Record<string, unknown> | undefined;
        addToast(
          `Duplicate file detected — already exists as v${detail?.existingVersion ?? '?'} (${detail?.existingState ?? '?'}). Navigate to that version to continue.`,
          'warning',
        );
      } else if (e.error.code === 'ALREADY_ACTIVE') {
        addToast(`${productId} v${version} is already Active — no upload needed`, 'info');
      } else {
        addToast(e.error.message, 'error');
      }
    } finally {
      setUploading(false);
    }
  }, [selectedFile, productId, version, addToast, loadList]);

  // ── Lifecycle actions ──────────────────────────────────────────────────────

  async function runAction(actionKey: string, fn: () => Promise<unknown>) {
    setBusyAction(actionKey);
    try {
      await fn();
      // Refresh
      if (selected && selectedVersionId) {
        const full = await getVersion(selected.productDefinitionId, selectedVersionId);
        setFullVersion(full);
        const versions = await listVersions(selected.productDefinitionId);
        setVersionsForProduct(versions);
      }
      await loadList();
    } catch (err) {
      const e = extractDescriptorError(err);
      if (e.error.code === 'DEFINITION_IN_USE' && e.error.dependents) {
        const d = e.error.dependents as unknown as Record<string, number>;
        addToast(
          `Cannot retire — still in use: ${d['boundDevices'] ?? 0} devices, ${d['runningJobs'] ?? 0} jobs, ${d['openAlarms'] ?? 0} alarms`,
          'error',
        );
      } else if (e.error.code === 'MAKER_CHECKER_VIOLATION') {
        addToast(e.error.message, 'error');
      } else if (e.error.code === 'RETENTION_NOT_MET') {
        addToast(e.error.message, 'error');
      } else {
        addToast(e.error.message, 'error');
      }
    } finally {
      setBusyAction(null);
    }
  }

  const handleValidate = () => {
    if (!fullVersion) return;
    runAction('validate', async () => {
      const result = await validateDescriptor(fullVersion.productDefinitionId, fullVersion.version);
      setValidationResult(result);
      setRightTab('validation');
      addToast(
        result.isValid
          ? `Validation passed (${result.warnings.length} warnings)`
          : `Validation failed — ${result.errors.length} error(s)`,
        result.isValid ? 'success' : 'error',
      );
    });
  };

  const handleApprove = async () => {
    if (!fullVersion) return;
    const reason = await askReason('Approve Descriptor', 'Reason for approval (optional)', 'Approve');
    setReasonModal(null);
    runAction('approve', () => approveDescriptor(fullVersion.productDefinitionId, fullVersion.version, { reason }));
  };

  const handleActivate = async () => {
    if (!fullVersion) return;
    const reason = await askReason('Activate Descriptor', 'Reason for activation (optional)', 'Activate');
    setReasonModal(null);
    runAction('activate', () => activateDescriptor(fullVersion.productDefinitionId, fullVersion.version, { reason }));
  };

  const handleDeprecate = async () => {
    if (!fullVersion) return;
    const reason = await askReason(
      'Deprecate Descriptor',
      'Reason for deprecation (required — this prevents new device bindings)',
      'Deprecate', true,
    );
    setReasonModal(null);
    runAction('deprecate', () => deprecateDescriptor(fullVersion.productDefinitionId, fullVersion.version, { reason }));
  };

  const handleRetire = async () => {
    if (!fullVersion) return;
    const reason = await askReason(
      'Retire Descriptor',
      'Reason for retirement. All bound devices must be migrated or deprovisioned first.',
      'Retire', true,
    );
    setReasonModal(null);
    runAction('retire', () => retireDescriptor(fullVersion.productDefinitionId, fullVersion.version, { reason }));
  };

  const handlePurge = async () => {
    if (!fullVersion) return;
    const reason = await askReason(
      '⚠ Purge Descriptor',
      `This permanently removes derived artifacts after the ${fullVersion.purgeRetentionDays}-day retention period. Type reason:`,
      'Purge', true,
    );
    setReasonModal(null);
    runAction('purge', () => purgeDescriptor(fullVersion.productDefinitionId, fullVersion.version, { reason }));
  };

  const handleDeleteDraft = async () => {
    if (!fullVersion) return;
    const reason = await askReason('Delete Draft', 'Reason for deletion', 'Delete', true);
    setReasonModal(null);
    runAction('deleteDraft', async () => {
      await deleteDescriptorDraft(fullVersion.productDefinitionId, fullVersion.version, reason);
      setFullVersion(null);
      setSelectedVersionId('');
      addToast('Draft deleted', 'success');
    });
  };

  // ── Load dependents/impact ─────────────────────────────────────────────────

  const loadDependents = async () => {
    if (!fullVersion) return;
    setRightTab('dependents');
    setLoadingRight(true);
    try {
      const dep = await getDependents(fullVersion.productDefinitionId, fullVersion.version);
      setDependents(dep);
    } catch (err) {
      addToast('Failed to load dependents', 'error');
    } finally {
      setLoadingRight(false);
    }
  };

  const loadImpact = async () => {
    if (!fullVersion) return;
    setRightTab('impact');
    setLoadingRight(true);
    try {
      const report = await getImpactReport(fullVersion.productDefinitionId, fullVersion.version);
      setImpactReport(report);
    } catch (err) {
      addToast('Failed to load impact report', 'error');
    } finally {
      setLoadingRight(false);
    }
  };

  // ── Migrate ────────────────────────────────────────────────────────────────

  const handleMigrateDryRun = async () => {
    if (!fullVersion || !migrateTarget.trim()) return;
    setMigrating(true);
    try {
      const result = await migrateDescriptor(
        fullVersion.productDefinitionId, fullVersion.version,
        { targetVersion: migrateTarget.trim(), dryRun: true },
      );
      addToast(
        `Dry-run: ${result.devicesAffected} device(s) would be migrated. ` +
        `+${result.parameterDiff?.addedCount ?? 0} params / -${result.parameterDiff?.removedCount ?? 0} params`,
        'success',
      );
    } catch (err) {
      const e = extractDescriptorError(err);
      addToast(e.error.message, 'error');
    } finally {
      setMigrating(false);
    }
  };

  const handleMigrateLive = async () => {
    if (!fullVersion || !migrateTarget.trim()) return;
    setMigrating(true);
    try {
      const result = await migrateDescriptor(
        fullVersion.productDefinitionId, fullVersion.version,
        { targetVersion: migrateTarget.trim(), dryRun: false },
      );
      addToast(`Migrated ${result.total} device(s) to v${migrateTarget}`, 'success');
      setShowMigrate(false);
      await loadList();
    } catch (err) {
      const e = extractDescriptorError(err);
      addToast(e.error.message, 'error');
    } finally {
      setMigrating(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', boxSizing: 'border-box',
    background: 'var(--vf-elevated)', border: '1px solid var(--vf-border)',
    borderRadius: 'var(--vf-radius-sm)', color: 'var(--vf-text-primary)',
    fontSize: 13, outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', marginBottom: 4,
    fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)',
    letterSpacing: '0.04em', textTransform: 'uppercase',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--vf-surface)', border: '1px solid var(--vf-border)',
    borderRadius: 'var(--vf-radius)', padding: 16, marginBottom: 12,
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
    textTransform: 'uppercase', color: 'var(--vf-text-muted)', marginBottom: 10,
  };

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0, padding: '16px' }}>
      {/* Reason modal */}
      {reasonModal && (
        <ReasonModal
          title={reasonModal.title}
          placeholder={reasonModal.placeholder}
          confirmLabel={reasonModal.confirmLabel}
          danger={reasonModal.danger}
          onConfirm={(r) => { reasonModal.resolve(r); }}
          onCancel={() => { reasonModal.resolve(''); setReasonModal(null); }}
        />
      )}

      {/* ── LEFT PANEL: upload + descriptor list ── */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>

        {/* Upload card */}
        <div style={cardStyle}>
          <div style={sectionTitle}>Upload Descriptor</div>

          <label style={labelStyle}>Product Definition ID</label>
          <input
            style={{ ...inputStyle, marginBottom: 2 }}
            placeholder="e.g. ubr-networks.ubr-650"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          />
          <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginBottom: 8 }}>
            Auto-detected from file — edit if needed
          </div>

          <label style={labelStyle}>Version (semver)</label>
          <input
            style={{ ...inputStyle, marginBottom: 8 }}
            placeholder="e.g. 1.0.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />

          <label style={labelStyle}>Descriptor File</label>
          <div style={{
            border: '2px dashed var(--vf-border)', borderRadius: 'var(--vf-radius-sm)',
            padding: '14px 12px', textAlign: 'center', cursor: 'pointer',
            background: selectedFile ? 'var(--vf-success-subtle)' : 'var(--vf-elevated)',
            transition: 'background 0.15s',
            marginBottom: 10,
          }}
            onClick={() => fileInputRef.current?.click()}
          >
            {selectedFile ? (
              <div style={{ fontSize: 12, color: 'var(--vf-success)', fontWeight: 600 }}>
                ✓ {selectedFile.name}
                <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
                Click to select XML / JSON / XLS / XLSX
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.json,.xls,.xlsx"
            style={{ display: 'none' }}
            onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
          />

          <Button
            variant="primary" size="sm" fullWidth
            onClick={handleUpload}
            disabled={!isAuthor || uploading || !selectedFile}
            loading={uploading}
          >
            Upload Descriptor
          </Button>
          {!isAuthor && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 6, textAlign: 'center' }}>
              Requires descriptor_author role
            </div>
          )}
        </div>

        {/* Descriptor list */}
        <div style={{ ...cardStyle, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px 0' }}>
          <div style={{ ...sectionTitle, padding: '0 14px' }}>
            Descriptors ({descriptors.length})
            <button
              onClick={loadList}
              style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-accent)', fontSize: 10 }}
            >
              ↻ Refresh
            </button>
          </div>

          {loadingList && <div style={{ padding: 20 }}><LoadingState label="Loading…" /></div>}
          {listError && (
            <div style={{ padding: 12, color: 'var(--vf-danger)', fontSize: 12 }}>{listError}</div>
          )}
          {!loadingList && !listError && descriptors.length === 0 && (
            <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 12 }}>
              No descriptors uploaded yet.<br/>Upload the first one above.
            </div>
          )}

          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
            {descriptors.map((desc) => {
              const isSelected = selected?.productDefinitionId === desc.productDefinitionId &&
                                 selected?.version === desc.version;
              return (
                <li key={`${desc.productDefinitionId}-${desc.version}`} role="listitem">
                  <button
                    onClick={() => selectRow(desc)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
                      width: '100%', padding: '9px 14px', textAlign: 'left', cursor: 'pointer',
                      border: 'none', borderRadius: 0,
                      background: isSelected ? 'var(--vf-accent-subtle)' : 'transparent',
                      borderLeft: `3px solid ${isSelected ? 'var(--vf-accent)' : 'transparent'}`,
                      transition: 'background 0.12s',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(desc.identity as { vendor?: string } | null)?.vendor || '—'}
                        {' / '}
                        {(desc.identity as { model?: string } | null)?.model || desc.productDefinitionId}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 1 }}>
                        {desc.productDefinitionId} · v{desc.version}
                      </div>
                    </div>
                    <StatePill state={desc.state} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto' }}>
        {!selected && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--vf-text-muted)', fontSize: 13,
          }}>
            Select a descriptor to view details and lifecycle actions.
          </div>
        )}

        {selected && (
          <>
            {/* Header */}
            <div style={{ ...cardStyle, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
                    {(fullVersion?.identity?.vendor || selected.productDefinitionId)}
                    {' — '}
                    {(fullVersion?.identity?.model || '')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                    {selected.productDefinitionId}
                  </div>
                </div>
                {fullVersion && <StatePill state={fullVersion.state} />}
              </div>

              {/* Version selector */}
              {versionsForProduct.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>Version:</span>
                  <select
                    value={selectedVersionId}
                    onChange={(e) => selectVersion(e.target.value)}
                    style={{ ...inputStyle, width: 'auto', padding: '4px 8px', fontSize: 12 }}
                  >
                    {versionsForProduct.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version} — {v.state}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Action toolbar */}
            {fullVersion && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {canTakeAction('validate', fullVersion.state) && (
                  <Button size="sm" variant="secondary"
                    disabled={!!busyAction} loading={busyAction === 'validate'}
                    onClick={handleValidate}
                  >
                    Validate
                  </Button>
                )}
                {canTakeAction('approve', fullVersion.state) && isAdmin && (
                  <Button size="sm" variant="secondary"
                    disabled={!!busyAction} loading={busyAction === 'approve'}
                    onClick={handleApprove}
                  >
                    Approve
                  </Button>
                )}
                {canTakeAction('activate', fullVersion.state) && isAdmin && (
                  <Button size="sm" variant="primary"
                    disabled={!!busyAction} loading={busyAction === 'activate'}
                    onClick={handleActivate}
                  >
                    Activate
                  </Button>
                )}
                {canTakeAction('deprecate', fullVersion.state) && isAdmin && (
                  <Button size="sm" variant="warning"
                    disabled={!!busyAction} loading={busyAction === 'deprecate'}
                    onClick={handleDeprecate}
                  >
                    Deprecate
                  </Button>
                )}
                {canTakeAction('retire', fullVersion.state) && isAdmin && (
                  <Button size="sm" variant="danger"
                    disabled={!!busyAction} loading={busyAction === 'retire'}
                    onClick={handleRetire}
                  >
                    Retire
                  </Button>
                )}
                {canTakeAction('purge', fullVersion.state) && isAdmin && (
                  <Button size="sm" variant="danger"
                    disabled={!!busyAction} loading={busyAction === 'purge'}
                    onClick={handlePurge}
                  >
                    Purge
                  </Button>
                )}
                {canTakeAction('deleteDraft', fullVersion.state) && isAuthor && (
                  <Button size="sm" variant="ghost"
                    disabled={!!busyAction} loading={busyAction === 'deleteDraft'}
                    onClick={handleDeleteDraft}
                  >
                    Delete Draft
                  </Button>
                )}
                {['Active', 'Deprecated'].includes(fullVersion.state) && (
                  <>
                    <Button size="sm" variant="ghost" onClick={loadDependents} disabled={!!busyAction}>
                      Dependents
                    </Button>
                    <Button size="sm" variant="ghost" onClick={loadImpact} disabled={!!busyAction}>
                      Impact Report
                    </Button>
                    {isAdmin && (
                      <Button size="sm" variant="ghost" onClick={() => setShowMigrate((prev) => !prev)} disabled={!!busyAction}>
                        Migrate Devices
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Migrate panel */}
            {showMigrate && fullVersion && (
              <div style={{ ...cardStyle, marginBottom: 12, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.25)' }}>
                <div style={sectionTitle}>Bulk Device Migration</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Target version:</span>
                  <input
                    placeholder="e.g. 1.1.0"
                    value={migrateTarget}
                    onChange={(e) => setMigrateTarget(e.target.value)}
                    style={{ ...inputStyle, width: 120 }}
                  />
                  <Button size="sm" variant="secondary" disabled={migrating || !migrateTarget.trim()} onClick={handleMigrateDryRun}>
                    Dry Run
                  </Button>
                  <Button size="sm" variant="danger" disabled={migrating || !migrateTarget.trim()} onClick={handleMigrateLive}>
                    Migrate Live
                  </Button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 6 }}>
                  Dry Run shows the parameter diff without making changes. Migrate Live rebinds all active devices.
                </div>
              </div>
            )}

            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--vf-border)', marginBottom: 12 }}>
              {(['versions', 'validation', 'dependents', 'impact', 'history'] as RightTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setRightTab(tab);
                    if (tab === 'dependents' && !dependents && fullVersion) loadDependents();
                    if (tab === 'impact' && !impactReport && fullVersion) loadImpact();
                  }}
                  style={{
                    padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: rightTab === tab ? 700 : 400,
                    color: rightTab === tab ? 'var(--vf-accent)' : 'var(--vf-text-muted)',
                    borderBottom: rightTab === tab ? '2px solid var(--vf-accent)' : '2px solid transparent',
                    marginBottom: -1, transition: 'color 0.12s',
                    textTransform: 'capitalize',
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {loadingRight && <LoadingState label="Loading…" />}

            {!loadingRight && rightTab === 'versions' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {versionsForProduct.map((v) => (
                  <div key={v.version} style={{
                    ...cardStyle,
                    border: v.version === selectedVersionId ? '1px solid var(--vf-accent)' : '1px solid var(--vf-border)',
                    cursor: 'pointer',
                  }}
                    onClick={() => selectVersion(v.version)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>v{v.version}</span>
                        {v.isDefault && (
                          <span style={{ marginLeft: 6, fontSize: 10, background: 'var(--vf-accent-subtle)', color: 'var(--vf-accent)', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>
                            DEFAULT
                          </span>
                        )}
                      </div>
                      <StatePill state={v.state} />
                    </div>
                    <div style={{ display: 'flex', gap: 24, marginTop: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                        Uploaded by: <strong>{(v as unknown as DescriptorVersion).uploadedByUsername || '—'}</strong>
                      </div>
                      {(v as unknown as DescriptorVersion).approvedByUsername && (
                        <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                          Approved by: <strong>{(v as unknown as DescriptorVersion).approvedByUsername}</strong>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                        Bound devices: <strong>{(v.dependency as { boundDevices?: number } | null)?.boundDevices ?? 0}</strong>
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 4 }}>
                      {new Date(v.updatedAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loadingRight && rightTab === 'validation' && validationResult && (
              <div>
                <div style={{
                  ...cardStyle,
                  borderColor: validationResult.isValid ? 'var(--vf-success)' : 'var(--vf-danger)',
                  marginBottom: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{validationResult.isValid ? '✅' : '❌'}</span>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      {validationResult.isValid ? 'Validation Passed' : 'Validation Failed'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginTop: 6 }}>
                    {validationResult.errors.length} error(s) · {validationResult.warnings.length} warning(s) ·{' '}
                    {new Date(validationResult.validatedAt).toLocaleString()}
                  </div>
                </div>

                {validationResult.errors.length > 0 && (
                  <div style={cardStyle}>
                    <div style={{ ...sectionTitle, color: 'var(--vf-danger)' }}>Errors</div>
                    {validationResult.errors.map((e, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', gap: 8 }}>
                        <span style={{ color: 'var(--vf-danger)', fontWeight: 700, flexShrink: 0 }}>✗</span>
                        <div>
                          <strong>{e.field}</strong>: {e.message}
                          {e.path && <div style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>{e.path}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {validationResult.warnings.length > 0 && (
                  <div style={cardStyle}>
                    <div style={{ ...sectionTitle, color: '#d97706' }}>Warnings</div>
                    {validationResult.warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', gap: 8 }}>
                        <span style={{ color: '#d97706', fontWeight: 700, flexShrink: 0 }}>⚠</span>
                        <div>
                          <strong>{w.field}</strong>: {w.message}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!validationResult.errors.length && !validationResult.warnings.length && (
                  <div style={{ ...cardStyle, textAlign: 'center', color: 'var(--vf-success)', fontSize: 13 }}>
                    No issues found — descriptor is valid.
                  </div>
                )}
              </div>
            )}

            {!loadingRight && rightTab === 'validation' && !validationResult && (
              <div style={{ ...cardStyle, textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                Click <strong>Validate</strong> above to run the lint check.
              </div>
            )}

            {!loadingRight && rightTab === 'dependents' && dependents && (
              <div>
                <div style={{ ...cardStyle, display: 'flex', gap: 0, flexWrap: 'wrap' }}>
                  <DepCount label="Bound Devices"        value={dependents.counts.boundDevices}        warn />
                  <DepCount label="Pre-Provisioned"      value={dependents.counts.preProvisionedDevices} warn />
                  <DepCount label="Discovery Rules"      value={dependents.counts.discoveryRules}      warn />
                  <DepCount label="Config Profiles"      value={dependents.counts.configProfiles}      warn />
                  <DepCount label="Running Jobs"         value={dependents.counts.runningJobs}         warn />
                  <DepCount label="Open Alarms"          value={dependents.counts.openAlarms}          warn />
                </div>
                {dependents.records.boundDevices.length > 0 && (
                  <div style={cardStyle}>
                    <div style={sectionTitle}>Bound Devices (first 100)</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--vf-border)' }}>
                          {['Device ID', 'Serial', 'IP Address', 'Status'].map((h) => (
                            <th key={h} style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--vf-text-muted)', fontWeight: 600, fontSize: 10 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dependents.records.boundDevices.map((d) => (
                          <tr key={d.deviceId} style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}>
                            <td style={{ padding: '5px 6px', color: 'var(--vf-text-muted)', fontSize: 10, fontFamily: 'monospace' }}>{d.deviceId.slice(-8)}</td>
                            <td style={{ padding: '5px 6px' }}>{d.serialNumber || '—'}</td>
                            <td style={{ padding: '5px 6px' }}>{d.ipAddress || '—'}</td>
                            <td style={{ padding: '5px 6px' }}>{d.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {!loadingRight && rightTab === 'impact' && impactReport && (
              <div>
                <div style={{ ...cardStyle, display: 'flex', gap: 0, flexWrap: 'wrap', marginBottom: 12 }}>
                  <DepCount label="Total Devices"    value={impactReport.summary.totalBoundDevices}  />
                  <DepCount label="Unreachable"      value={impactReport.summary.unreachableDevices}  warn />
                  <DepCount label="Running Jobs"     value={impactReport.summary.runningJobs}         warn />
                  <DepCount label="Open Alarms"      value={impactReport.summary.openAlarms}          warn />
                  <DepCount label="Config Profiles"  value={impactReport.summary.configProfiles}      />
                </div>
                {Object.keys(impactReport.devicesByRegion).length > 0 && (
                  <div style={cardStyle}>
                    <div style={sectionTitle}>By Region</div>
                    {Object.entries(impactReport.devicesByRegion).map(([region, info]) => (
                      <div key={region} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 12 }}>
                        <span style={{ fontWeight: 600 }}>{region}</span>
                        <span style={{ color: 'var(--vf-text-muted)' }}>
                          {info.total} device(s)
                          {info.unreachable > 0 && <span style={{ color: 'var(--vf-danger)', marginLeft: 6 }}>({info.unreachable} unreachable)</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={cardStyle}>
                  <div style={sectionTitle}>Clearing Paths</div>
                  {impactReport.clearingPaths.map((p) => (
                    <div key={p.action} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--vf-border-subtle)' }}>
                      <span style={{ fontSize: 11, color: 'var(--vf-accent)', fontWeight: 600 }}>{p.action.toUpperCase()}</span>
                      <span style={{ fontSize: 12, color: 'var(--vf-text-secondary)' }}>{p.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!loadingRight && rightTab === 'history' && fullVersion && (
              <div style={cardStyle}>
                <div style={sectionTitle}>Lifecycle History</div>
                {fullVersion.lifecycleHistory.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', textAlign: 'center', padding: 16 }}>No events yet</div>
                ) : (
                  <div style={{ position: 'relative', paddingLeft: 20 }}>
                    {[...fullVersion.lifecycleHistory].reverse().map((event, i) => (
                      <div key={i} style={{ position: 'relative', paddingBottom: 16, paddingLeft: 16 }}>
                        {/* Vertical line */}
                        {i < fullVersion.lifecycleHistory.length - 1 && (
                          <div style={{
                            position: 'absolute', left: 5, top: 16, width: 2, height: '100%',
                            background: 'var(--vf-border-subtle)',
                          }} />
                        )}
                        {/* Dot */}
                        <div style={{
                          position: 'absolute', left: 0, top: 6, width: 10, height: 10,
                          borderRadius: '50%', background: 'var(--vf-accent)', border: '2px solid var(--vf-surface)',
                        }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <StatePill state={event.toState} />
                          <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>
                            {new Date(event.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--vf-text-secondary)' }}>
                          by <strong>{event.actorUsername}</strong> ({event.actorRole})
                          {event.reason && <span style={{ marginLeft: 6, color: 'var(--vf-text-muted)' }}>— {event.reason}</span>}
                        </div>
                        {(event.dependencyCounts?.boundDevices != null) && (
                          <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                            At time: {event.dependencyCounts.boundDevices} devices bound
                          </div>
                        )}
                      </div>
                    ))}
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

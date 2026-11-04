/**
 * V2NodeViewDesignerPage — Pre-MIB Node View Designer (PV-01 → PV-12)
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../components/common/Toast';
import { Button } from '../components/common/Button';
import { LoadingState } from '../components/common/States';
import {
  listNodeViewDesigns,
  createNodeViewDesign,
  getNodeViewDesign,
  updateNodeViewDesign,
  deleteNodeViewDesign,
  copyNodeViewDesign,
  toggleNodeViewLock,
} from '../../api/nodeViewDesign.api';
import type {
  NodeViewDesign,
  NodeViewDesignSummary,
  NvdSection,
  NvdLabel,
} from '../../api/nodeViewDesign.api';

// ── Constants ─────────────────────────────────────────────────────────────────

const INDEX_LEVEL_OPTIONS: {
  value: NvdSection['indexLevel'];
  label: string;
}[] = [
  { value: 'scalar', label: 'Scalar (single value)' },
  { value: 'single', label: 'Single-indexed (e.g. radio)' },
  { value: 'double', label: 'Double-indexed (e.g. radio + client)' },
  { value: 'triple', label: 'Triple-indexed' },
];

const LEFT_WIDTH = 320;
const INDENT_PX = 24;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

// ── Helpers ───────────────────────────────────────────────────────────────────

function canAdminEdit(role: string | undefined): boolean {
  const r = (role ?? '').toLowerCase();
  return r === 'admin' || r === 'descriptor_admin' || r === 'superadmin';
}

function indexLevelLabel(level: NvdSection['indexLevel']): string {
  return INDEX_LEVEL_OPTIONS.find((o) => o.value === level)?.label ?? level;
}

function sortSections(sections: NvdSection[]): NvdSection[] {
  return [...sections].sort((a, b) => a.order - b.order);
}

function sortLabels(labels: NvdLabel[]): NvdLabel[] {
  return [...labels].sort((a, b) => a.order - b.order);
}

function nextOrder(items: { order: number }[]): number {
  if (items.length === 0) return 0;
  return Math.max(...items.map((i) => i.order)) + 1;
}

function collectDescendantIds(
  sectionId: string,
  sections: NvdSection[],
): Set<string> {
  const set = new Set<string>();
  const walk = (id: string) => {
    set.add(id);
    sections
      .filter((s) => s.parentSectionId === id)
      .forEach((s) => walk(s.sectionId));
  };
  walk(sectionId);
  return set;
}

function isValidParent(
  sectionId: string,
  parentId: string | null,
  sections: NvdSection[],
): boolean {
  if (parentId === null) return true;
  if (parentId === sectionId) return false;
  const blocked = collectDescendantIds(sectionId, sections);
  return !blocked.has(parentId);
}

function newSection(partial?: Partial<NvdSection>, order = 0): NvdSection {
  return {
    sectionId: crypto.randomUUID(),
    title: partial?.title ?? 'New section',
    parentSectionId: partial?.parentSectionId ?? null,
    indexLevel: partial?.indexLevel ?? 'scalar',
    order,
    position: partial?.position ?? { x: 0, y: 0 },
    size: partial?.size ?? { width: 400, height: 200 },
    frozen: false,
    labels: partial?.labels ?? [],
  };
}

function newLabel(order = 0): NvdLabel {
  return {
    labelId: crypto.randomUUID(),
    text: 'New label',
    unit: null,
    order,
    position: { x: 0, y: 0 },
    frozen: false,
    mappedField: null,
  };
}

function statusPillStyle(status: NodeViewDesign['status']): React.CSSProperties {
  if (status === 'ready') {
    return {
      background: 'rgba(34,197,94,0.12)',
      color: '#16a34a',
      border: '1px solid rgba(34,197,94,0.35)',
    };
  }
  return {
    background: 'var(--vf-elevated)',
    color: 'var(--vf-text-muted)',
    border: '1px solid var(--vf-border)',
  };
}

function StatusPill({ status }: { status: NodeViewDesign['status'] }) {
  return (
    <span
      style={{
        ...statusPillStyle(status),
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {status}
    </span>
  );
}

// ── Inline edit ───────────────────────────────────────────────────────────────

interface InlineEditProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  placeholder?: string;
}

function InlineEdit({
  value,
  onChange,
  disabled,
  style,
  placeholder,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (disabled) {
    return (
      <span style={{ ...style, color: 'var(--vf-text-primary)' }}>{value || placeholder}</span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          ...style,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--vf-text-primary)',
          textAlign: 'left',
          font: 'inherit',
        }}
        title="Click to edit"
      >
        {value || placeholder || '—'}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const trimmed = draft.trim();
        if (trimmed && trimmed !== value) onChange(trimmed);
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      style={{
        ...style,
        border: '1px solid var(--vf-accent)',
        borderRadius: 'var(--vf-radius-sm)',
        padding: '2px 6px',
        background: 'var(--vf-surface)',
        color: 'var(--vf-text-primary)',
        outline: 'none',
      }}
    />
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: { name: string; deviceFamily: string; description: string }) => void;
  busy: boolean;
}

function CreateDesignModal({ open, onClose, onCreate, busy }: CreateModalProps) {
  const [name, setName] = useState('');
  const [deviceFamily, setDeviceFamily] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setDeviceFamily('');
      setDescription('');
    }
  }, [open]);

  if (!open) return null;

  const valid = name.trim().length > 0;

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 420,
          maxWidth: '92vw',
          background: 'var(--vf-surface)',
          border: '1px solid var(--vf-border)',
          borderRadius: 'var(--vf-radius)',
          padding: 24,
          boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: 18, color: 'var(--vf-text-primary)' }}>
          New node view design
        </h2>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase' }}>
            Name *
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              display: 'block',
              width: '100%',
              marginTop: 4,
              padding: '8px 10px',
              borderRadius: 'var(--vf-radius-sm)',
              border: '1px solid var(--vf-border)',
              background: 'var(--vf-elevated)',
              color: 'var(--vf-text-primary)',
            }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase' }}>
            Device family
          </span>
          <input
            value={deviceFamily}
            onChange={(e) => setDeviceFamily(e.target.value)}
            placeholder='e.g. "Senao AP"'
            style={{
              display: 'block',
              width: '100%',
              marginTop: 4,
              padding: '8px 10px',
              borderRadius: 'var(--vf-radius-sm)',
              border: '1px solid var(--vf-border)',
              background: 'var(--vf-elevated)',
              color: 'var(--vf-text-primary)',
            }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 20 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase' }}>
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{
              display: 'block',
              width: '100%',
              marginTop: 4,
              padding: '8px 10px',
              borderRadius: 'var(--vf-radius-sm)',
              border: '1px solid var(--vf-border)',
              background: 'var(--vf-elevated)',
              color: 'var(--vf-text-primary)',
              resize: 'vertical',
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!valid || busy}
            loading={busy}
            onClick={() =>
              onCreate({
                name: name.trim(),
                deviceFamily: deviceFamily.trim(),
                description: description.trim(),
              })
            }
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

export default function V2NodeViewDesignerPage() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canEdit = canAdminEdit(user?.role);

  const [summaries, setSummaries] = useState<NodeViewDesignSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [design, setDesign] = useState<NodeViewDesign | null>(null);
  const [loadingDesign, setLoadingDesign] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteSectionId, setDeleteSectionId] = useState<string | null>(null);
  const [deleteLabelKey, setDeleteLabelKey] = useState<string | null>(null);
  const [hoverLabelMove, setHoverLabelMove] = useState<string | null>(null);

  const skipAutosaveRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const data = await listNodeViewDesigns();
      setSummaries(data);
    } catch (e) {
      addToast('Failed to load node view designs', 'error');
    } finally {
      setListLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const loadDesign = useCallback(
    async (id: string) => {
      setLoadingDesign(true);
      skipAutosaveRef.current = true;
      try {
        const full = await getNodeViewDesign(id);
        setDesign(full);
        setPreviewMode(false);
        setSaveStatus('saved');
      } catch {
        addToast('Failed to load design', 'error');
      } finally {
        setLoadingDesign(false);
        window.setTimeout(() => {
          skipAutosaveRef.current = false;
        }, 0);
      }
    },
    [addToast],
  );

  const patchDesign = useCallback((updater: (d: NodeViewDesign) => NodeViewDesign) => {
    setDesign((prev) => (prev ? updater(prev) : prev));
  }, []);

  // ── Auto-save (PV-10) ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!design || skipAutosaveRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');

    saveTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const updated = await updateNodeViewDesign(design.nodeViewId, {
            name: design.name,
            deviceFamily: design.deviceFamily,
            description: design.description,
            sections: design.sections,
          });
          setDesign(updated);
          setSaveStatus('saved');
          void refreshList();
        } catch {
          setSaveStatus('failed');
        }
      })();
    }, 600);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [design?.nodeViewId, design?.name, design?.deviceFamily, design?.description, design?.sections, refreshList]);

  const layoutLocked = design?.locked ?? false;
  const canMutate = canEdit && !layoutLocked && !previewMode;

  const sectionsSorted = useMemo(
    () => (design ? sortSections(design.sections) : []),
    [design?.sections],
  );

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, NvdSection[]>();
    for (const s of sectionsSorted) {
      const p = s.parentSectionId;
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(s);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.order - b.order);
    return map;
  }, [sectionsSorted]);

  const handleCreate = async (payload: {
    name: string;
    deviceFamily: string;
    description: string;
  }) => {
    setCreating(true);
    try {
      const created = await createNodeViewDesign({
        name: payload.name,
        deviceFamily: payload.deviceFamily,
        description: payload.description,
        sections: [],
      });
      setCreateOpen(false);
      await refreshList();
      await loadDesign(created.nodeViewId);
      addToast('Node view design created', 'success');
    } catch {
      addToast('Create failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteDesign = async (id: string) => {
    if (!canEdit) return;
    try {
      await deleteNodeViewDesign(id);
      if (design?.nodeViewId === id) setDesign(null);
      setDeleteConfirmId(null);
      await refreshList();
      addToast('Design deleted', 'success');
    } catch {
      addToast('Delete failed', 'error');
    }
  };

  const handleDuplicate = async (summary: NodeViewDesignSummary) => {
    if (!canEdit) return;
    const suggested = `${summary.name} (copy)`;
    const name = window.prompt('Name for duplicate', suggested);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      addToast('Name is required', 'warning');
      return;
    }
    try {
      const copy = await copyNodeViewDesign(summary.nodeViewId, trimmed);
      await refreshList();
      await loadDesign(copy.nodeViewId);
      addToast('Design duplicated', 'success');
    } catch {
      addToast('Duplicate failed', 'error');
    }
  };

  const handleToggleLock = async () => {
    if (!design || !canEdit) return;
    try {
      const next = !design.locked;
      const res = await toggleNodeViewLock(design.nodeViewId, next);
      patchDesign((d) => ({ ...d, locked: res.locked }));
      addToast(res.locked ? 'Layout locked' : 'Layout unlocked', 'success');
    } catch {
      addToast('Lock toggle failed', 'error');
    }
  };

  const addSection = () => {
    if (!design || !canMutate) return;
    const order = nextOrder(design.sections);
    const section = newSection({}, order);
    patchDesign((d) => ({ ...d, sections: [...d.sections, section] }));
  };

  const updateSection = (sectionId: string, patch: Partial<NvdSection>) => {
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.sectionId === sectionId ? { ...s, ...patch } : s,
      ),
    }));
  };

  const removeSection = (sectionId: string) => {
    if (!design || !canMutate) return;
    const toRemove = collectDescendantIds(sectionId, design.sections);
    patchDesign((d) => ({
      ...d,
      sections: d.sections
        .filter((s) => !toRemove.has(s.sectionId))
        .map((s) =>
          s.parentSectionId && toRemove.has(s.parentSectionId)
            ? { ...s, parentSectionId: null }
            : s,
        ),
    }));
    setDeleteSectionId(null);
  };

  const moveSection = (sectionId: string, dir: -1 | 1) => {
    if (!design || !canMutate) return;
    const section = design.sections.find((s) => s.sectionId === sectionId);
    if (!section || section.frozen) return;

    const siblings = sortSections(
      design.sections.filter((s) => s.parentSectionId === section.parentSectionId),
    );
    const idx = siblings.findIndex((s) => s.sectionId === sectionId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;

    const a = siblings[idx];
    const b = siblings[swapIdx];
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId === a.sectionId) return { ...s, order: b.order };
        if (s.sectionId === b.sectionId) return { ...s, order: a.order };
        return s;
      }),
    }));
  };

  const addLabel = (sectionId: string) => {
    if (!canMutate) return;
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== sectionId) return s;
        const order = nextOrder(s.labels);
        return { ...s, labels: [...s.labels, newLabel(order)] };
      }),
    }));
  };

  const updateLabel = (
    sectionId: string,
    labelId: string,
    patch: Partial<NvdLabel>,
  ) => {
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== sectionId) return s;
        return {
          ...s,
          labels: s.labels.map((l) =>
            l.labelId === labelId ? { ...l, ...patch } : l,
          ),
        };
      }),
    }));
  };

  const removeLabel = (sectionId: string, labelId: string) => {
    if (!canMutate) return;
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.sectionId === sectionId
          ? { ...s, labels: s.labels.filter((l) => l.labelId !== labelId) }
          : s,
      ),
    }));
    setDeleteLabelKey(null);
  };

  const moveLabel = (sectionId: string, labelId: string, dir: -1 | 1) => {
    if (!design || !canMutate) return;
    const section = design.sections.find((s) => s.sectionId === sectionId);
    const label = section?.labels.find((l) => l.labelId === labelId);
    if (!section || !label || label.frozen) return;

    const labels = sortLabels(section.labels);
    const idx = labels.findIndex((l) => l.labelId === labelId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= labels.length) return;

    const a = labels[idx];
    const b = labels[swapIdx];
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== sectionId) return s;
        return {
          ...s,
          labels: s.labels.map((l) => {
            if (l.labelId === a.labelId) return { ...l, order: b.order };
            if (l.labelId === b.labelId) return { ...l, order: a.order };
            return l;
          }),
        };
      }),
    }));
  };

  const moveLabelToSection = (
    fromSectionId: string,
    labelId: string,
    toSectionId: string,
  ) => {
    if (!design || !canMutate || fromSectionId === toSectionId) return;
    const from = design.sections.find((s) => s.sectionId === fromSectionId);
    const label = from?.labels.find((l) => l.labelId === labelId);
    if (!from || !label || label.frozen) return;

    const to = design.sections.find((s) => s.sectionId === toSectionId);
    if (!to) return;

    const newOrder = nextOrder(to.labels);
    patchDesign((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId === fromSectionId) {
          return { ...s, labels: s.labels.filter((l) => l.labelId !== labelId) };
        }
        if (s.sectionId === toSectionId) {
          return {
            ...s,
            labels: [...s.labels, { ...label, order: newOrder }],
          };
        }
        return s;
      }),
    }));
  };

  const toggleCollapsed = (sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  const saveStatusLabel = (): string => {
    switch (saveStatus) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'failed':
        return 'Save failed';
      default:
        return '';
    }
  };

  const renderPreviewTree = (parentId: string | null, depth: number): React.ReactNode => {
    const nodes = childrenByParent.get(parentId) ?? [];
    return nodes.map((section) => {
      const labelCount = section.labels.length;
      const childNodes = childrenByParent.get(section.sectionId) ?? [];
      const hasChildren = childNodes.length > 0;
      const isCollapsed = collapsed.has(section.sectionId);

      return (
        <div key={section.sectionId} style={{ marginLeft: depth * INDENT_PX, marginBottom: 12 }}>
          <div
            style={{
              background: 'var(--vf-elevated)',
              border: '1px solid var(--vf-border)',
              borderRadius: 'var(--vf-radius-sm)',
              padding: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {hasChildren && (
                <button
                  type="button"
                  onClick={() => toggleCollapsed(section.sectionId)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--vf-text-muted)',
                    fontSize: 12,
                  }}
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
              )}
              <strong style={{ color: 'var(--vf-text-primary)' }}>{section.title}</strong>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--vf-surface)',
                  border: '1px solid var(--vf-border)',
                  color: 'var(--vf-accent)',
                  fontWeight: 600,
                }}
              >
                {indexLevelLabel(section.indexLevel)}
              </span>
              <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
                {labelCount} label{labelCount === 1 ? '' : 's'}
              </span>
            </div>
            {!isCollapsed && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sortLabels(section.labels).map((label) => (
                  <div
                    key={label.labelId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '6px 10px',
                      borderRadius: 'var(--vf-radius-sm)',
                      background: 'var(--vf-surface)',
                      border: '1px solid var(--vf-border)',
                    }}
                  >
                    <span style={{ color: 'var(--vf-text-primary)', fontWeight: 500 }}>
                      {label.text}
                    </span>
                    <span style={{ color: 'var(--vf-text-muted)', fontSize: 13 }}>
                      {label.unit ? `${label.unit}` : '—'}
                    </span>
                    <span style={{ color: 'var(--vf-text-muted)', fontSize: 13, minWidth: 24, textAlign: 'right' }}>
                      —
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isCollapsed && renderPreviewTree(section.sectionId, depth + 1)}
        </div>
      );
    });
  };

  const renderSectionEditor = (parentId: string | null, depth: number): React.ReactNode => {
    const nodes = childrenByParent.get(parentId) ?? [];
    return nodes.map((section) => {
      const childNodes = childrenByParent.get(section.sectionId) ?? [];
      const hasChildren = childNodes.length > 0;
      const isCollapsed = collapsed.has(section.sectionId);
      const sectionFrozen = section.frozen;
      const canEditSection = canMutate && !sectionFrozen;
      const parentOptions = sectionsSorted.filter(
        (s) =>
          s.sectionId !== section.sectionId &&
          isValidParent(section.sectionId, s.sectionId, design!.sections),
      );

      return (
        <div key={section.sectionId} style={{ marginLeft: depth * INDENT_PX, marginBottom: 12 }}>
          <div
            style={{
              background: 'var(--vf-surface)',
              border: '1px solid var(--vf-border)',
              borderRadius: 'var(--vf-radius)',
              padding: 14,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              {hasChildren && (
                <button
                  type="button"
                  onClick={() => toggleCollapsed(section.sectionId)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--vf-text-muted)',
                  }}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
              )}
              <InlineEdit
                value={section.title}
                onChange={(title) => updateSection(section.sectionId, { title })}
                disabled={!canEditSection}
                style={{ fontSize: 16, fontWeight: 700 }}
              />
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  color: 'var(--vf-text-muted)',
                }}
              >
                <input
                  type="checkbox"
                  checked={section.frozen}
                  disabled={!canMutate}
                  onChange={(e) =>
                    updateSection(section.sectionId, { frozen: e.target.checked })
                  }
                />
                Frozen
              </label>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEditSection}
                  onClick={() => moveSection(section.sectionId, -1)}
                  title="Move up"
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEditSection}
                  onClick={() => moveSection(section.sectionId, 1)}
                  title="Move down"
                >
                  ↓
                </Button>
                {deleteSectionId === section.sectionId ? (
                  <>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={!canMutate}
                      onClick={() => removeSection(section.sectionId)}
                    >
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteSectionId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canMutate}
                    onClick={() => setDeleteSectionId(section.sectionId)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>

            <div
              style={{
                marginBottom: 12,
                padding: 10,
                borderRadius: 'var(--vf-radius-sm)',
                background: 'var(--vf-elevated)',
                border: '1px solid var(--vf-border)',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                Index level (SNMP table matching)
              </div>
              <select
                value={section.indexLevel}
                disabled={!canMutate}
                onChange={(e) =>
                  updateSection(section.sectionId, {
                    indexLevel: e.target.value as NvdSection['indexLevel'],
                  })
                }
                style={{
                  width: '100%',
                  maxWidth: 420,
                  padding: '8px 10px',
                  borderRadius: 'var(--vf-radius-sm)',
                  border: '1px solid var(--vf-accent)',
                  background: 'var(--vf-surface)',
                  color: 'var(--vf-text-primary)',
                  fontWeight: 600,
                }}
              >
                {INDEX_LEVEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <label style={{ display: 'block', marginBottom: 12, fontSize: 13, color: 'var(--vf-text-muted)' }}>
              Parent section{' '}
              <select
                value={section.parentSectionId ?? ''}
                disabled={!canMutate}
                onChange={(e) => {
                  const val = e.target.value || null;
                  if (val && !isValidParent(section.sectionId, val, design!.sections)) return;
                  updateSection(section.sectionId, { parentSectionId: val });
                }}
                style={{
                  marginLeft: 8,
                  padding: '4px 8px',
                  borderRadius: 'var(--vf-radius-sm)',
                  border: '1px solid var(--vf-border)',
                  background: 'var(--vf-elevated)',
                  color: 'var(--vf-text-primary)',
                }}
              >
                <option value="">None (top level)</option>
                {parentOptions.map((s) => (
                  <option key={s.sectionId} value={s.sectionId}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ marginBottom: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canMutate}
                onClick={() => addLabel(section.sectionId)}
              >
                + Add Label
              </Button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sortLabels(section.labels).map((label) => {
                const labelKey = `${section.sectionId}:${label.labelId}`;
                const labelFrozen = label.frozen;
                const canEditLabel = canMutate && !labelFrozen;
                const showMoveDropdown =
                  hoverLabelMove === labelKey && canEditLabel && sectionsSorted.length > 1;

                return (
                  <div
                    key={label.labelId}
                    tabIndex={canEditLabel ? 0 : -1}
                    onFocus={() => setHoverLabelMove(labelKey)}
                    onBlur={() => setHoverLabelMove((k) => (k === labelKey ? null : k))}
                    onMouseEnter={() => setHoverLabelMove(labelKey)}
                    onMouseLeave={() => setHoverLabelMove((k) => (k === labelKey ? null : k))}
                    onKeyDown={(e) => {
                      if (!canEditLabel) return;
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveLabel(section.sectionId, label.labelId, -1);
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveLabel(section.sectionId, label.labelId, 1);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 999,
                      background: 'var(--vf-elevated)',
                      border: '1px solid var(--vf-border)',
                      outline: 'none',
                    }}
                  >
                    <InlineEdit
                      value={label.text}
                      onChange={(text) =>
                        updateLabel(section.sectionId, label.labelId, { text })
                      }
                      disabled={!canEditLabel}
                      style={{ fontSize: 13, fontWeight: 600, minWidth: 80 }}
                    />
                    <span style={{ color: 'var(--vf-text-muted)', fontSize: 12 }}>Unit</span>
                    <input
                      value={label.unit ?? ''}
                      disabled={!canEditLabel}
                      onChange={(e) =>
                        updateLabel(section.sectionId, label.labelId, {
                          unit: e.target.value.trim() || null,
                        })
                      }
                      placeholder="optional"
                      style={{
                        width: 72,
                        padding: '2px 6px',
                        borderRadius: 'var(--vf-radius-sm)',
                        border: '1px solid var(--vf-border)',
                        background: 'var(--vf-surface)',
                        color: 'var(--vf-text-primary)',
                        fontSize: 12,
                      }}
                    />
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 11,
                        color: 'var(--vf-text-muted)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={label.frozen}
                        disabled={!canMutate}
                        onChange={(e) =>
                          updateLabel(section.sectionId, label.labelId, {
                            frozen: e.target.checked,
                          })
                        }
                      />
                      Frozen
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canEditLabel}
                      onClick={() => moveLabel(section.sectionId, label.labelId, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canEditLabel}
                      onClick={() => moveLabel(section.sectionId, label.labelId, 1)}
                    >
                      ↓
                    </Button>
                    {showMoveDropdown && (
                      <label style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                        Move to section →
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            const to = e.target.value;
                            if (to) moveLabelToSection(section.sectionId, label.labelId, to);
                            e.target.value = '';
                          }}
                          style={{
                            marginLeft: 4,
                            fontSize: 11,
                            padding: '2px 4px',
                            borderRadius: 'var(--vf-radius-sm)',
                            border: '1px solid var(--vf-border)',
                          }}
                        >
                          <option value="">Select…</option>
                          {sectionsSorted
                            .filter((s) => s.sectionId !== section.sectionId)
                            .map((s) => (
                              <option key={s.sectionId} value={s.sectionId}>
                                {s.title}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    {deleteLabelKey === labelKey ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={!canMutate}
                          onClick={() => removeLabel(section.sectionId, label.labelId)}
                        >
                          Confirm
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteLabelKey(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canMutate}
                        onClick={() => setDeleteLabelKey(labelKey)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {!isCollapsed && renderSectionEditor(section.sectionId, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        minHeight: 0,
        background: 'var(--vf-elevated)',
      }}
    >
      <CreateDesignModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(p) => void handleCreate(p)}
        busy={creating}
      />

      {/* Left panel — design list */}
      <aside
        style={{
          width: LEFT_WIDTH,
          flexShrink: 0,
          borderRight: '1px solid var(--vf-border)',
          background: 'var(--vf-surface)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid var(--vf-border)' }}>
          <Button
            variant="primary"
            size="sm"
            fullWidth
            disabled={!canEdit}
            onClick={() => setCreateOpen(true)}
          >
            + New Node View
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {listLoading ? (
            <LoadingState label="Loading…" />
          ) : summaries.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', textAlign: 'center', marginTop: 24 }}>
              No designs yet
            </p>
          ) : (
            summaries.map((s) => {
              const selected = design?.nodeViewId === s.nodeViewId;
              return (
                <div
                  key={s.nodeViewId}
                  style={{
                    marginBottom: 10,
                    padding: 12,
                    borderRadius: 'var(--vf-radius-sm)',
                    border: selected
                      ? '1px solid var(--vf-accent)'
                      : '1px solid var(--vf-border)',
                    background: selected ? 'var(--vf-elevated)' : 'var(--vf-surface)',
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 4 }}>
                    {s.name}
                  </div>
                  {s.deviceFamily && (
                    <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 6 }}>
                      {s.deviceFamily}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                    <StatusPill status={s.status} />
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                      {s.sectionCount} sections · {s.labelCount} labels
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <Button variant="secondary" size="sm" onClick={() => void loadDesign(s.nodeViewId)}>
                      Load
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canEdit}
                      onClick={() => void handleDuplicate(s)}
                    >
                      Duplicate
                    </Button>
                    {deleteConfirmId === s.nodeViewId ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={!canEdit}
                          onClick={() => void handleDeleteDesign(s.nodeViewId)}
                        >
                          Confirm
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit}
                        onClick={() => setDeleteConfirmId(s.nodeViewId)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Right panel — designer */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--vf-elevated)',
        }}
      >
        {!design && !loadingDesign && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--vf-text-muted)',
              fontSize: 15,
            }}
          >
            Select a node view design to edit
          </div>
        )}

        {loadingDesign && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LoadingState label="Loading design…" />
          </div>
        )}

        {design && !loadingDesign && (
          <>
            <header
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--vf-border)',
                background: 'var(--vf-surface)',
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                <InlineEdit
                  value={design.name}
                  onChange={(name) => patchDesign((d) => ({ ...d, name }))}
                  disabled={!canMutate}
                  style={{ fontSize: 20, fontWeight: 700 }}
                />
                <InlineEdit
                  value={design.deviceFamily || 'Device family'}
                  onChange={(deviceFamily) => patchDesign((d) => ({ ...d, deviceFamily }))}
                  disabled={!canMutate}
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 'var(--vf-radius-sm)',
                    background: 'var(--vf-elevated)',
                    color: 'var(--vf-text-muted)',
                  }}
                />
                <StatusPill status={design.status} />
                <span
                  style={{
                    fontSize: 12,
                    color:
                      saveStatus === 'failed'
                        ? 'var(--vf-danger)'
                        : 'var(--vf-text-muted)',
                  }}
                >
                  {saveStatusLabel()}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <Button
                    variant={layoutLocked ? 'warning' : 'secondary'}
                    size="sm"
                    disabled={!canEdit}
                    onClick={() => void handleToggleLock()}
                    title={layoutLocked ? 'Unlock layout' : 'Lock layout'}
                  >
                    {layoutLocked ? '🔒 Locked' : '🔓 Lock layout'}
                  </Button>
                  <Button
                    variant={previewMode ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setPreviewMode((p) => !p)}
                  >
                    {previewMode ? 'Exit preview' : 'Preview'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void loadDesign(design.nodeViewId)}
                  >
                    Load
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={design.status !== 'ready'}
                    onClick={() =>
                      navigate(
                        `/v2/mib-builder?nodeViewId=${encodeURIComponent(design.nodeViewId)}&nodeViewName=${encodeURIComponent(design.name)}`,
                      )
                    }
                  >
                    Open in MIB Builder →
                  </Button>
                </div>
              </div>
              {!canEdit && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--vf-text-muted)' }}>
                  Read-only: admin or descriptor_admin role required to edit (PV-01).
                </p>
              )}
            </header>

            {!previewMode && (
              <div
                style={{
                  padding: '12px 20px',
                  borderBottom: '1px solid var(--vf-border)',
                  background: 'var(--vf-surface)',
                }}
              >
                <Button variant="secondary" size="sm" disabled={!canMutate} onClick={addSection}>
                  + Add Section
                </Button>
              </div>
            )}

            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              {previewMode
                ? renderPreviewTree(null, 0)
                : sectionsSorted.length === 0
                  ? (
                    <p style={{ color: 'var(--vf-text-muted)', fontSize: 14 }}>
                      No sections yet. Add a section to begin designing.
                    </p>
                  )
                  : renderSectionEditor(null, 0)}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

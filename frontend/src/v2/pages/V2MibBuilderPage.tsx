/**
 * V2MibBuilderPage — MIB UI Builder (4-step authoring flow)
 *
 * 1 · MIB Library — upload / browse / select objects
 * 2 · Build Screen — click-to-add layout + MIB binding
 * 3 · Preview & Publish — sample-data preview
 * 4 · Widget Rules — reference + generated XML
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseMibFile,
  extractApiError,
} from '../../api/productDefinitions.api';
import type { MibObjectSummary, ParseMibResult, MibStatistics } from '../../api/productDefinitions.api';
import {
  createDescriptor,
  updateDescriptor,
  publishDescriptor,
} from '../../api/uiBuilder.api';
import { useToast } from '../components/common/Toast';

// ── Descriptor types (draft shape used across steps) ─────────────────────────

interface UiDescriptorField {
  fieldId: string;
  elementType: 'heading' | 'sub-heading' | 'field-label' | 'table-block' | 'divider';
  label: string;
  labelLevel?: 'heading' | 'sub-heading' | 'field';
  mibObject?: string;
  oid?: string;
  syntax?: string;
  units?: string;
  access?: 'read-only' | 'read-write' | 'not-accessible';
  widget?: string;
  minValue?: number;
  maxValue?: number;
  pollInterval?: number;
  writeMode?: 'apply-button' | 'direct';
  helpText?: string;
  confirmWrite?: boolean;
  /** value → label for enum fields ('1' → 'enable'); a table block also keeps its `columns` setting here. */
  enumMap?: Record<string, string>;
  order: number;
}

interface UiDescriptorSection {
  sectionId: string;
  title: string;
  columns: 1 | 2;
  fullWidth?: boolean;
  pollInterval?: number;
  writeMode?: 'apply-button' | 'direct' | 'read-only';
  fields: UiDescriptorField[];
  order: number;
}

interface UiDescriptorDraft {
  descriptorId?: string;
  screenName: string;
  deviceProfile?: string;
  mibModule?: string;
  vendor?: string;
  productFamily?: string;
  status: 'draft' | 'published';
  sections: UiDescriptorSection[];
  generatedXml?: string;
  /** Full MIB object list from Stage 1 — stored so any admin can restore the session. */
  selectedObjects?: MibObjectSummary[];
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Shared styles ────────────────────────────────────────────────────────────

const FORM_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--vf-text-muted)',
  marginBottom: 6,
  display: 'block',
};

const BTN_PRIMARY: React.CSSProperties = {
  background: 'var(--vf-accent)',
  color: '#fff',
  border: 'none',
  padding: '8px 16px',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

const BTN_SECONDARY: React.CSSProperties = {
  background: 'var(--vf-elevated)',
  color: 'var(--vf-text-secondary)',
  border: '1px solid var(--vf-border-subtle)',
  padding: '8px 14px',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 500,
  fontSize: 13,
};

const uid = () => `f_${Math.random().toString(36).slice(2, 10)}`;
const sid = () => `s_${Math.random().toString(36).slice(2, 10)}`;

function normalizeAccess(access: string): UiDescriptorField['access'] {
  const a = access.toLowerCase();
  if (a.includes('write')) return 'read-write';
  if (a.includes('not-accessible')) return 'not-accessible';
  return 'read-only';
}

export function suggestWidget(obj: MibObjectSummary): string {
  const dt = (obj.nmsDataType || '').toLowerCase();
  const rw = normalizeAccess(obj.access) === 'read-write';
  if (obj.indexType !== 'SCALAR') return 'Data table';
  if (obj.isEnum) return rw ? 'Dropdown' : 'Status badge';
  if (dt.includes('truth') || dt === 'boolean') return rw ? 'Toggle switch' : 'On/Off badge';
  if (dt.includes('gauge')) return 'Gauge';
  if (dt.includes('counter')) return 'Rate chart (Δ/s)';
  if (dt.includes('timeticks')) return 'Duration (d h m)';
  if (dt.includes('sequence')) return 'Data table';
  if (dt.includes('ip') || dt.includes('inet')) return rw ? 'IP input (validated)' : 'IP text';
  if (dt.includes('integer') || dt.includes('int')) return rw ? 'Slider+number' : 'Value + units';
  return rw ? 'Text input' : 'Text value';
}

/** Trigger a browser download of an XML string as a file. */
function downloadXml(xml: string, filename: string) {
  const blob = new Blob([xml], { type: 'application/xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeXmlAttr(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateUiXml(descriptor: UiDescriptorDraft): string {
  const screenId = (descriptor.screenName || 'screen')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'screen';
  const mib = escapeXmlAttr(descriptor.mibModule || 'UNKNOWN-MIB');
  const lines: string[] = [`<screen id="${screenId}" mib="${mib}">`];

  const sections = [...descriptor.sections].sort((a, b) => a.order - b.order);
  const allFields = sections.flatMap((s) => s.fields);
  const screenHeading = allFields.find((f) => f.elementType === 'heading');
  const headingText = screenHeading?.label || descriptor.screenName || 'Screen';
  lines.push(`  <heading text="${escapeXmlAttr(headingText)}"/>`);

  for (const section of sections) {
    const fields = [...section.fields].sort((a, b) => a.order - b.order);
    const bindable = fields.filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block');
    if (bindable.length === 0 && !section.title) continue;

    const hasTable = bindable.some((f) => f.elementType === 'table-block') || section.fullWidth;
    const columnsAttr = hasTable ? 'full' : String(section.columns === 1 ? 1 : 2);
    const poll = section.pollInterval && section.pollInterval > 0 ? `${Math.round(section.pollInterval)}s` : '30s';
    const sectionParts = [
      `text="${escapeXmlAttr(section.title || 'Section')}"`,
      `columns="${columnsAttr}"`,
      `poll="${poll}"`,
    ];
    if (section.writeMode === 'apply-button') sectionParts.push('write="apply"');
    if (section.writeMode === 'direct') sectionParts.push('write="direct"');

    lines.push(`  <section ${sectionParts.join(' ')}>`);
    for (const field of fields) {
      if (field.elementType === 'sub-heading' && field.label) {
        lines.push(`    <subheading text="${escapeXmlAttr(field.label)}"/>`);
      }
    }
    for (const field of bindable) {
      if (field.elementType === 'table-block') {
        const tableParts: string[] = [];
        if (field.mibObject) tableParts.push(`object="${escapeXmlAttr(field.mibObject)}"`);
        tableParts.push('widget="grid"', 'walk="bulk"', 'columns="auto"');
        if (field.oid) tableParts.push(`oid="${escapeXmlAttr(field.oid)}"`);
        lines.push(`    <table ${tableParts.join(' ')}/>`);
        continue;
      }
      const parts: string[] = [];
      if (field.label) parts.push(`label="${escapeXmlAttr(field.label)}"`);
      if (field.mibObject) parts.push(`object="${escapeXmlAttr(field.mibObject)}"`);
      if (field.oid) parts.push(`oid="${escapeXmlAttr(field.oid)}"`);
      if (field.widget) parts.push(`widget="${escapeXmlAttr(field.widget)}"`);
      if (field.minValue != null) parts.push(`min="${escapeXmlAttr(field.minValue)}"`);
      if (field.maxValue != null) parts.push(`max="${escapeXmlAttr(field.maxValue)}"`);
      if (field.units) parts.push(`units="${escapeXmlAttr(field.units)}"`);
      if (field.confirmWrite) parts.push('confirm="true"');
      if (parts.length) lines.push(`    <field ${parts.join(' ')}/>`);
    }
    lines.push('  </section>');
  }
  lines.push('</screen>');
  return `${lines.join('\n')}\n`;
}

const SAMPLE_UI_XML = `<screen id="radio_overview" mib="SAMPLE-RADIO-MIB">
  <heading text="Radio Overview"/>
  <section text="RF Status" columns="2" poll="30s">
    <field label="TX Power" object="radioTxPower" widget="slider" min="-20" max="20" units="dBm"/>
    <field label="Admin State" object="radioAdminState" widget="toggle"/>
  </section>
</screen>
`;

// ── Section tree (groups objects by MIB section/subSection) ─────────────────

interface OidTreeNode {
  key: string;
  label: string;
  oidPrefix: string;
  children: OidTreeNode[];
  objectNames: string[];
}

/**
 * Build a two-level section → subSection tree from the parsed MIB objects.
 * Uses the `section` / `subSection` fields returned by the Java parser rather
 * than raw numeric OIDs, which are 9+ levels deep and unintelligible.
 *
 * Tree shape:
 *   ▶ configuration
 *       ▶ radio          (subSection = "configuration.radio")
 *           · radioAdminState
 *           · radioTxPower
 *       · sysDescr       (subSection === section)
 *   ▶ monitor
 *       · radioRxPower
 */
function buildOidTree(objects: MibObjectSummary[]): OidTreeNode {
  const root: OidTreeNode = { key: 'root', label: 'root', oidPrefix: '', children: [], objectNames: [] };

  const findOrCreate = (parent: OidTreeNode, key: string, label: string): OidTreeNode => {
    let node = parent.children.find((c) => c.key === key);
    if (!node) {
      node = { key, label, oidPrefix: key, children: [], objectNames: [] };
      parent.children.push(node);
    }
    return node;
  };

  for (const obj of objects) {
    const section = (obj.section || 'general').trim();
    const subSection = (obj.subSection || section).trim();

    const secNode = findOrCreate(root, `sec__${section}`, section);

    if (subSection === section) {
      // Object sits directly under its section
      secNode.objectNames.push(obj.name);
    } else {
      // Strip the section prefix to get a short subSection label
      const subLabel = subSection.startsWith(`${section}.`)
        ? subSection.slice(section.length + 1)
        : subSection;
      const subNode = findOrCreate(secNode, `sub__${subSection}`, subLabel);
      subNode.objectNames.push(obj.name);
    }
  }

  // Sort sections and subSections alphabetically
  const sortTree = (n: OidTreeNode) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    n.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

/** Collect all top-level section keys so we can auto-expand them after parse. */
function collectSectionKeys(tree: OidTreeNode): Set<string> {
  const keys = new Set<string>(['root']);
  for (const child of tree.children) keys.add(child.key);
  return keys;
}

function deriveModuleList(result: ParseMibResult): { name: string; status: 'parsed' | 'resolved' | 'missing' }[] {
  const list: { name: string; status: 'parsed' | 'resolved' | 'missing' }[] = [
    { name: result.moduleName, status: 'parsed' },
    { name: 'SNMPv2-MIB', status: 'resolved' },
    { name: 'IF-MIB', status: 'resolved' },
  ];
  const warnings = result.warnings ?? [];
  for (const w of warnings) {
    const m = w.match(/(?:import|resolve)[^\w]*([A-Z0-9-]+-MIB)/i) ?? w.match(/([A-Z0-9-]+-MIB)/);
    if (m && !list.some((x) => x.name === m[1])) {
      list.push({ name: m[1], status: 'missing' });
    }
  }
  if (!list.some((x) => x.name.includes('TC-MIB'))) {
    list.push({ name: 'SAMPLE-TC-MIB', status: 'missing' });
  }
  return list;
}

// ── Step header ──────────────────────────────────────────────────────────────

function StepHeader({ step, onStep }: { step: number; onStep: (n: number) => void }) {
  const items: { n: number; label: string }[] = [
    { n: 1, label: 'MIB Library' },
    { n: 2, label: 'Build Screen' },
    { n: 3, label: 'Preview & Publish' },
    { n: 4, label: '⓪ Widget Rules' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 20px',
        borderBottom: '1px solid var(--vf-border-subtle)',
        background: 'var(--vf-surface)',
        flexShrink: 0,
      }}
    >
      {items.map(({ n, label }, idx) => (
        <React.Fragment key={n}>
          {idx > 0 && <span style={{ color: 'var(--vf-text-muted)', fontSize: 12 }}>|</span>}
          <button
            type="button"
            onClick={() => onStep(n)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
              fontSize: 13,
              fontWeight: step === n ? 700 : 500,
              color: step === n ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
            }}
          >
            {n <= 3 ? `${n} · ${label}` : label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Screen 1: MIB Library ────────────────────────────────────────────────────

/**
 * Auto-generate an initial set of sections + fields from a list of selected
 * MIB objects. Objects are grouped by their `section` property so the Screen
 * Builder canvas already has a sensible starting layout when the user arrives.
 */
function autoGenerateSections(objects: MibObjectSummary[]): UiDescriptorSection[] {
  const sectionMap = new Map<string, UiDescriptorSection>();
  const ordered: UiDescriptorSection[] = [];

  for (const obj of objects) {
    const sectionName = (obj.section || 'general').trim();
    let sec = sectionMap.get(sectionName);
    if (!sec) {
      const hasWrite = objects
        .filter((o) => (o.section || 'general').trim() === sectionName)
        .some((o) => normalizeAccess(o.access) === 'read-write');
      sec = {
        sectionId: sid(),
        title: sectionName.charAt(0).toUpperCase() + sectionName.slice(1).replace(/-/g, ' '),
        columns: 2,
        pollInterval: 30,
        writeMode: hasWrite ? 'apply-button' : 'read-only',
        order: ordered.length,
        fields: [],
      };
      ordered.push(sec);
      sectionMap.set(sectionName, sec);
    }
    const field: UiDescriptorField = {
      fieldId: uid(),
      elementType: obj.indexType !== 'SCALAR' ? 'table-block' : 'field-label',
      label: obj.name,
      labelLevel: 'field',
      mibObject: obj.name,
      oid: obj.oid ?? undefined,
      syntax: obj.nmsDataType,
      access: normalizeAccess(obj.access),
      widget: suggestWidget(obj),
      enumMap: enumMapFor(obj),
      order: sec.fields.length,
    };
    sec.fields.push(field);
  }
  return ordered;
}

/**
 * enumMap for a field bound to a MIB object: the real labels ('1' → 'enable'). Table blocks also keep a
 * `columns` entry in the same map, so any existing one is carried over.
 */
function enumMapFor(obj: MibObjectSummary, prev?: Record<string, string>): Record<string, string> | undefined {
  const labels = obj.isEnum && obj.enumValues ? { ...obj.enumValues } : {};
  if (prev && prev['columns'] !== undefined) labels['columns'] = prev['columns'];
  return Object.keys(labels).length ? labels : undefined;
}

function MibLibraryScreen({
  onNext,
  existingDescriptor,
  onSaved,
  onLoadDraft,
  onDescriptorDeleted,
  initialParseResult,
}: {
  onNext: (objects: MibObjectSummary[], mib: ParseMibResult) => void;
  /** Descriptor already saved in this session — passed back so we can update instead of create. */
  existingDescriptor?: UiDescriptorDraft | null;
  /** Called after a successful save with the (possibly new) descriptor. */
  onSaved?: (draft: UiDescriptorDraft) => void;
  /** Called when the user picks an existing draft to resume — jumps to Screen Builder. */
  onLoadDraft?: (draft: UiDescriptorDraft) => void;
  /** Called after a draft is successfully deleted (passes the deleted descriptorId). */
  onDescriptorDeleted?: (descriptorId: string) => void;
  /**
   * Pre-built ParseMibResult used to seed the initial state when this component
   * is mounted (via key-based remount on draft load). Passed as `useState` initializer
   * so it is read exactly once on mount — no useEffect sync needed.
   */
  initialParseResult?: ParseMibResult | null;
}) {
  const { addToast } = useToast();
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  /** Id of the card currently showing the inline "Confirm delete / Cancel" prompt. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** Id of the card currently being renamed inline. */
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [savingRenameId, setSavingRenameId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<import('../../api/uiBuilder.api').UiDescriptorSummary[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  /**
   * Seeded from `initialParseResult` on mount (draft restore path).
   * The component is remounted via `key` whenever a different draft is loaded,
   * so this initializer runs fresh every time — no useEffect sync needed.
   */
  const [parseResult, setParseResult] = useState<ParseMibResult | null>(initialParseResult ?? null);
  /**
   * Tracks where the current parseResult came from:
   *   'none'     → nothing loaded yet (show upload prompt)
   *   'restored' → populated from a saved draft (initialParseResult on mount)
   *   'upload'   → populated by the user uploading a new MIB file
   * Used to avoid showing "restored from draft" UI when a fresh file has been uploaded.
   */
  const [parseSource, setParseSource] = useState<'none' | 'restored' | 'upload'>(
    initialParseResult && initialParseResult.objects.length > 0 ? 'restored' : 'none',
  );
  const [uploadedFileName, setUploadedFileName] = useState<string>('');
  /** User-editable name that will be used when saving the draft. */
  const [screenNameInput, setScreenNameInput] = useState(existingDescriptor?.screenName ?? '');
  const [deviceProfile, setDeviceProfile] = useState(
    existingDescriptor?.deviceProfile
      ?? (initialParseResult ? [initialParseResult.vendor, initialParseResult.productLine].filter(Boolean).join(' - ') : ''),
  );
  const [search, setSearch] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => existingDescriptor?.selectedObjects?.length
      ? new Set(existingDescriptor.selectedObjects.map((o) => o.name))
      : new Set(),
  );
  const [treeFocusName, setTreeFocusName] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']));
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const tableScrollRef = useRef<HTMLDivElement>(null);

  /** Names of MIB objects the user has removed from the table. */
  const [deletedNames, setDeletedNames] = useState<Set<string>>(new Set());
  /** Whether the "Add from MIB" picker popover is open. */
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  /** Search string inside the Add from MIB picker. */
  const [addPickerSearch, setAddPickerSearch] = useState('');

  const modules = parseResult ? deriveModuleList(parseResult) : [];

  /** All objects visible in the table = parsed MIB objects minus removed ones. */
  const allTableObjects = useMemo<MibObjectSummary[]>(() => 
    (parseResult?.objects ?? []).filter((o) => !deletedNames.has(o.name))
  , [parseResult, deletedNames]);

  const filteredObjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTableObjects.filter((o) => {
      if (!q) return true;
      return o.name.toLowerCase().includes(q) || (o.oid ?? '').includes(q);
    });
  }, [allTableObjects, search]);

  const objectByName = useMemo(() => {
    const m = new Map<string, MibObjectSummary>();
    allTableObjects.forEach((o) => m.set(o.name, o));
    return m;
  }, [allTableObjects]);

  const tree = useMemo(
    () => (parseResult ? buildOidTree(parseResult.objects) : null),
    [parseResult],
  );

  // Auto-expand all top-level sections whenever the tree changes
  useEffect(() => {
    if (tree) setExpanded(collectSectionKeys(tree));
  }, [tree]);

  // selectedNames and parseResult are seeded from initialParseResult / existingDescriptor
  // directly in their useState() initializers — no sync effects needed.

  useEffect(() => {
    if (treeFocusName) {
      const row = rowRefs.current.get(treeFocusName);
      const box = tableScrollRef.current;
      if (row && box) {
        // Scroll ONLY the table's own container. scrollIntoView() would also scroll every
        // ancestor (the app shell), dragging the MIB tree away while the user is picking fields.
        const rowTop = row.offsetTop;
        const rowBottom = rowTop + row.offsetHeight;
        const headH = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        if (rowTop - headH < box.scrollTop) box.scrollTo({ top: rowTop - headH, behavior: 'smooth' });
        else if (rowBottom > box.scrollTop + box.clientHeight) box.scrollTo({ top: rowBottom - box.clientHeight, behavior: 'smooth' });
      }
    }
  }, [treeFocusName, filteredObjects]);

  // Fetch the draft list once on mount so admins see existing work immediately
  useEffect(() => {
    import('../../api/uiBuilder.api')
      .then(({ listDescriptors }) => listDescriptors())
      .then(setDrafts)
      .catch(() => { /* silently ignore — non-critical */ });
  }, []);

  /** Load a full descriptor and invoke onLoadDraft to restore the entire session. */
  async function handlePickDraft(descriptorId: string) {
    setLoadingDraftId(descriptorId);
    try {
      const { getDescriptor } = await import('../../api/uiBuilder.api');
      const full = await getDescriptor(descriptorId);
      // Convert the API UiDescriptor shape into our local UiDescriptorDraft shape
      const draft: UiDescriptorDraft = {
        descriptorId:    full.descriptorId,
        screenName:      full.screenName,
        deviceProfile:   full.deviceProfile,
        mibModule:       full.mibModule,
        vendor:          full.vendor,
        productFamily:   full.productFamily,
        status:          full.status,
        sections:        full.sections as UiDescriptorSection[],
        generatedXml:    full.generatedXml,
        selectedObjects: (full.selectedObjects ?? []) as MibObjectSummary[],
        createdBy:       full.createdBy,
        updatedBy:       full.updatedBy,
        createdAt:       full.createdAt,
        updatedAt:       full.updatedAt,
      };
      onLoadDraft?.(draft);
    } catch {
      addToast('Failed to load draft', 'error');
    } finally {
      setLoadingDraftId(null);
    }
  }

  async function handleDeleteDraft(descriptorId: string) {
    setDeletingDraftId(descriptorId);
    try {
      const { deleteDescriptor } = await import('../../api/uiBuilder.api');
      await deleteDescriptor(descriptorId);
      setDrafts((prev) => prev.filter((d) => d.descriptorId !== descriptorId));
      setConfirmDeleteId(null);
      onDescriptorDeleted?.(descriptorId);
      addToast('Draft deleted', 'success');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
        ?? 'Delete failed';
      addToast(msg, 'error');
    } finally {
      setDeletingDraftId(null);
    }
  }

  async function handleRenameDraft(descriptorId: string) {
    const name = editingName.trim();
    if (!name) { addToast('Screen name cannot be empty', 'error'); return; }
    setSavingRenameId(descriptorId);
    try {
      const { updateDescriptor } = await import('../../api/uiBuilder.api');
      await updateDescriptor(descriptorId, { screenName: name });
      setDrafts((prev) => prev.map((d) => d.descriptorId === descriptorId ? { ...d, screenName: name } : d));
      setEditingDraftId(null);
      addToast('Renamed successfully', 'success');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
        ?? 'Rename failed';
      addToast(msg, 'error');
    } finally {
      setSavingRenameId(null);
    }
  }

  async function handleFile(file: File, opts?: { preserveSelection?: boolean }) {
    setParsing(true);
    setParseError(null);
    setParseResult(null);
    setParseSource('none');
    // Capture current selection BEFORE clearing, so we can restore matches after parse
    const prevSelected = opts?.preserveSelection ? new Set(selectedNames) : new Set<string>();
    setSelectedNames(new Set());
    setDeletedNames(new Set());
    // Remember the filename so we can display it in the header
    setUploadedFileName(file.name.replace(/\.(mib|my|txt)$/i, ''));
    try {
      const result = await parseMibFile(file);
      setParseResult(result);
      setParseSource('upload');   // ← mark as fresh upload, never show "restored draft" UI
      setDeviceProfile(
        result.vendor && result.productLine
          ? `${result.vendor} - ${result.productLine}`
          : result.vendor || result.productLine || '',
      );
      // Re-apply previous selection for names that also exist in the new MIB
      if (prevSelected.size > 0) {
        const newNames = new Set(result.objects.map((o) => o.name));
        const kept = new Set([...prevSelected].filter((n) => newNames.has(n)));
        if (kept.size > 0) setSelectedNames(kept);
      }
      // Pre-fill screen name from module name — user can edit before saving
      const suggestedName = result.moduleName && !['IMPORTS','EXPORTS','UNKNOWN-MIB'].includes(result.moduleName)
        ? result.moduleName.replace(/-MIB$/i, ' Overview')
        : (file.name.replace(/\.(mib|my|txt)$/i, '') + ' Overview');
      // Only overwrite screen name if not editing an existing descriptor
      if (!existingDescriptor?.descriptorId) setScreenNameInput(suggestedName);
      // NOTE: expanded is reset by the useEffect on tree (collectSectionKeys)
    } catch (err) {
      const ae = extractApiError(err);
      setParseError(ae.error.message ?? 'MIB parse failed');
      setParseSource('none');
    } finally {
      setParsing(false);
    }
  }

  function toggleSelected(name: string) {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Remove a row from the table. For MIB objects, track as deleted. For custom, remove from array. */
  /** Remove a parsed MIB row from the table. */
  function deleteRow(obj: MibObjectSummary) {
    setDeletedNames((prev) => new Set([...prev, obj.name]));
    setSelectedNames((prev) => {
      const next = new Set(prev);
      next.delete(obj.name);
      return next;
    });
  }

  /** Re-add a previously removed MIB object back into the table (and auto-select it). */
  function reAddMibObject(obj: MibObjectSummary) {
    setDeletedNames((prev) => {
      const next = new Set(prev);
      next.delete(obj.name);
      return next;
    });
    setSelectedNames((prev) => new Set([...prev, obj.name]));
  }

  function renderTreeNode(node: OidTreeNode, depth: number): React.ReactNode {
    // Root is invisible — just render children
    if (node.key === 'root') {
      if (node.children.length === 0 && node.objectNames.length === 0) {
        return (
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', padding: 8 }}>
            No objects parsed.
          </div>
        );
      }
      return (
        <>
          {node.children.map((c) => renderTreeNode(c, 0))}
          {node.objectNames.map((name) => renderLeaf(name, 0))}
        </>
      );
    }

    const hasChildren = node.children.length > 0 || node.objectNames.length > 0;
    const isOpen = expanded.has(node.key);

    return (
      <div key={node.key}>
        {/* Section / subSection header */}
        <button
          type="button"
          onClick={() => {
            setExpanded((e) => {
              const n = new Set(e);
              if (n.has(node.key)) n.delete(node.key);
              else n.add(node.key);
              return n;
            });
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            width: '100%',
            textAlign: 'left',
            padding: '4px 8px',
            paddingLeft: 8 + depth * 14,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--vf-text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          <span style={{ fontSize: 9, opacity: 0.7 }}>{hasChildren ? (isOpen ? '▼' : '▶') : '·'}</span>
          <span>{node.label}</span>
        </button>

        {/* Expanded: object leaves then subSection children */}
        {isOpen && (
          <>
            {node.objectNames.map((name) => renderLeaf(name, depth + 1))}
            {node.children.map((c) => renderTreeNode(c, depth + 1))}
          </>
        )}
      </div>
    );
  }

  function renderLeaf(name: string, depth: number): React.ReactNode {
    const isFocused = treeFocusName === name;
    const isChecked = selectedNames.has(name);
    return (
      <button
        key={name}
        type="button"
        onClick={() => {
          setTreeFocusName(name);
          toggleSelected(name);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          textAlign: 'left',
          padding: '3px 8px',
          paddingLeft: 8 + depth * 14,
          border: 'none',
          background: isFocused
            ? 'var(--vf-accent-subtle)'
            : isChecked
              ? 'rgba(34,197,94,0.08)'
              : 'transparent',
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'var(--vf-font-mono)',
          color: isFocused ? 'var(--vf-accent)' : 'var(--vf-text-primary)',
          borderRadius: 4,
        }}
      >
        <span style={{ opacity: 0.4, fontSize: 9 }}>·</span>
        <span>{name}</span>
        {isChecked && <span style={{ marginLeft: 'auto', color: 'var(--vf-success)', fontSize: 9 }}>✓</span>}
      </button>
    );
  }

  const selectedObjects = [...selectedNames]
    .map((n) => objectByName.get(n))
    .filter(Boolean) as MibObjectSummary[];

  /** Save (or update) a draft descriptor from the current MIB selection. */
  async function handleSaveDraft() {
    if (!parseResult || selectedObjects.length === 0) return;
    const finalName = screenNameInput.trim() || existingDescriptor?.screenName || 'New Screen';
    setSaving(true);
    try {
      const sections = autoGenerateSections(selectedObjects);
      const moduleName = parseResult.moduleName;
      const dp =
        deviceProfile ||
        (parseResult.vendor && parseResult.productLine
          ? `${parseResult.vendor} - ${parseResult.productLine}`
          : parseResult.vendor || '');

      const payload = {
        screenName: finalName,
        deviceProfile: dp || undefined,
        mibModule: moduleName,
        vendor: parseResult.vendor,
        productFamily: parseResult.productLine,
        status: 'draft' as const,
        sections,
        generatedXml: '',
        /** Persist selected objects so any admin can restore the session later. */
        selectedObjects,
      };

      let saved: UiDescriptorDraft;
      if (existingDescriptor?.descriptorId) {
        const updated = await updateDescriptor(existingDescriptor.descriptorId, payload);
        saved = { ...existingDescriptor, ...payload, descriptorId: updated.descriptorId ?? existingDescriptor.descriptorId };
      } else {
        const created = await createDescriptor(payload);
        saved = { ...payload, descriptorId: created.descriptorId };
      }

      onSaved?.(saved);
      // Reflect the (possibly new) name in the drafts panel immediately
      setDrafts((prev) => {
        const exists = prev.find((d) => d.descriptorId === saved.descriptorId);
        if (exists) {
          return prev.map((d) => d.descriptorId === saved.descriptorId ? { ...d, screenName: finalName } : d);
        }
        return prev; // new draft will appear on next listDescriptors fetch
      });
      addToast(
        `Draft saved — ${selectedObjects.length} objects in ${sections.length} section${sections.length !== 1 ? 's' : ''}`,
        'success',
      );
    } catch {
      addToast('Failed to save draft', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* Left panel */}
      <aside
        style={{
          width: 280,
          flexShrink: 0,
          borderRight: '1px solid var(--vf-border-subtle)',
          padding: 16,
          overflowY: 'auto',
          background: 'var(--vf-surface)',
        }}
      >
        {/* Header changes based on what is currently loaded */}
        {parseResult && parseSource === 'restored' && existingDescriptor?.descriptorId ? (
          /* ── Restored from saved draft ── */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>📂</span>
              <h2 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {existingDescriptor.screenName}
              </h2>
            </div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 6 }}>
              {existingDescriptor.mibModule && !['IMPORTS','EXPORTS','UNKNOWN-MIB'].includes(existingDescriptor.mibModule)
                ? existingDescriptor.mibModule
                : parseResult.moduleName && !['IMPORTS','EXPORTS','UNKNOWN-MIB'].includes(parseResult.moduleName)
                  ? parseResult.moduleName
                  : 'Loaded MIB'}
              {' · '}{parseResult.objects.length} object{parseResult.objects.length !== 1 ? 's' : ''}
            </div>
            <p style={{ fontSize: 11, color: 'var(--vf-text-secondary)', margin: '0 0 10px', lineHeight: 1.4 }}>
              Showing objects from saved draft. Upload a new MIB to replace.
            </p>
          </>
        ) : parseResult && parseSource === 'upload' ? (
          /* ── Fresh MIB file uploaded ── */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>📄</span>
              <h2 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: 'var(--vf-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {uploadedFileName || 'Uploaded MIB'}
              </h2>
            </div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 6 }}>
              {parseResult.moduleName && !['IMPORTS','EXPORTS','UNKNOWN-MIB'].includes(parseResult.moduleName)
                ? parseResult.moduleName
                : uploadedFileName || 'MIB module'}
              {' · '}{parseResult.objects.length} object{parseResult.objects.length !== 1 ? 's' : ''}
            </div>
          </>
        ) : (
          /* ── Nothing loaded yet — show upload prompt ── */
          <>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 6px', color: 'var(--vf-text-primary)' }}>
              Upload customer MIB
            </h2>
            <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '0 0 14px', lineHeight: 1.45 }}>
              .mib / .my / .txt — SMIv1 or SMIv2. Imports are resolved against the standard library.
            </p>
          </>
        )}

        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
          onClick={() => inputRef.current?.click()}
          style={{
            border: '2px dashed var(--vf-border-subtle)',
            borderRadius: 8,
            padding: '18px 12px',
            textAlign: 'center',
            cursor: parsing ? 'wait' : 'pointer',
            background: 'var(--vf-elevated)',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
            ↑ Choose file or drop here
          </div>
          {parsing && (
            <div style={{ fontSize: 11, color: 'var(--vf-accent)', marginTop: 8 }}>Parsing…</div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".mib,.my,.txt,.smi,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </div>

        {/* ── Screen name — used as the draft/screen identifier ── */}
        <label style={FORM_LABEL}>
          Screen name
          <span style={{ color: 'var(--vf-danger)', marginLeft: 2 }}>*</span>
        </label>
        <input
          value={screenNameInput}
          onChange={(e) => setScreenNameInput(e.target.value)}
          placeholder="e.g. Radio Config Overview"
          maxLength={80}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${!screenNameInput.trim() && parseResult ? 'var(--vf-danger)' : 'var(--vf-border-subtle)'}`,
            background: 'var(--vf-elevated)',
            color: 'var(--vf-text-primary)',
            fontSize: 13,
            marginBottom: screenNameInput.trim() ? 12 : 4,
          }}
        />
        {!screenNameInput.trim() && parseResult && (
          <p style={{ fontSize: 10, color: 'var(--vf-danger)', margin: '0 0 10px' }}>
            Enter a name before saving
          </p>
        )}

        <label style={FORM_LABEL}>Device profile</label>
        <input
          value={deviceProfile}
          onChange={(e) => setDeviceProfile(e.target.value)}
          placeholder="Vendor - Product family"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--vf-border-subtle)',
            background: 'var(--vf-elevated)',
            color: 'var(--vf-text-primary)',
            fontSize: 13,
            marginBottom: 16,
          }}
        />

        {parseResult && (
          <>
            <label style={FORM_LABEL}>Loaded modules</label>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {modules.map((mod) => {
                const badge =
                  mod.status === 'parsed'
                    ? { text: 'Parsed', color: 'var(--vf-success)' }
                    : mod.status === 'resolved'
                      ? { text: 'Resolved', color: '#2563eb' }
                      : { text: 'Missing import', color: 'var(--vf-danger)' };
                return (
                  <li
                    key={mod.name}
                    style={{
                      fontSize: 11,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-primary)' }}>
                      {mod.name}
                    </span>
                    <span style={{ color: badge.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{badge.text}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {parseError && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--vf-danger)' }}>{parseError}</div>
        )}

        {/* ── Versions — all descriptors sharing the same mibModule ─────────── */}
        {existingDescriptor?.mibModule && (() => {
          const versions = drafts
            .filter((d) => d.mibModule === existingDescriptor!.mibModule)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          if (versions.length === 0) return null;
          return (
            <div style={{ marginTop: 20, borderTop: '1px solid var(--vf-border-subtle)', paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ ...FORM_LABEL, margin: 0 }}>Versions</label>
                <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>
                  {existingDescriptor.mibModule}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {versions.map((v) => {
                  const isActive = existingDescriptor?.descriptorId === v.descriptorId;
                  const isLoading = loadingDraftId === v.descriptorId;
                  const ts = new Date(v.updatedAt);
                  const label = ts.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    + ' · ' + ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div
                      key={v.descriptorId}
                      style={{
                        padding: '7px 10px',
                        borderRadius: 6,
                        border: `1px solid ${isActive ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                        background: isActive ? 'rgba(37,99,235,0.06)' : 'var(--vf-elevated)',
                        display: 'flex', flexDirection: 'column', gap: 3,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* Status dot */}
                        <span style={{
                          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                          background: v.status === 'published' ? '#16a34a' : '#60a5fa',
                        }} />
                        <span style={{
                          fontSize: 11, fontWeight: 600, flex: 1,
                          color: isActive ? 'var(--vf-accent)' : 'var(--vf-text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={v.screenName}>{v.screenName}</span>
                        {isActive
                          ? <span style={{ fontSize: 10, color: 'var(--vf-accent)', fontWeight: 700 }}>Active</span>
                          : (
                            <button
                              type="button"
                              disabled={isLoading}
                              onClick={() => void handlePickDraft(v.descriptorId)}
                              style={{
                                fontSize: 10, padding: '2px 8px', borderRadius: 4,
                                border: 'none', background: 'var(--vf-accent)', color: '#fff',
                                cursor: isLoading ? 'wait' : 'pointer', fontWeight: 600,
                                opacity: isLoading ? 0.6 : 1,
                              }}
                            >
                              {isLoading ? '…' : 'Load'}
                            </button>
                          )
                        }
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', display: 'flex', gap: 8, paddingLeft: 13 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                          background: v.status === 'published' ? 'rgba(22,163,74,0.12)' : 'rgba(96,165,250,0.12)',
                          color: v.status === 'published' ? '#15803d' : '#3b82f6',
                          textTransform: 'uppercase',
                        }}>{v.status}</span>
                        <span>{v.objectCount} obj</span>
                        <span style={{ marginLeft: 'auto' }}>{label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── My Drafts ──────────────────────────────────────── */}
        {drafts.length > 0 && (
          <div style={{ marginTop: 20, borderTop: '1px solid var(--vf-border-subtle)', paddingTop: 16 }}>
            <label style={FORM_LABEL}>My drafts</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {drafts.map((d) => {
                const isLoading = loadingDraftId === d.descriptorId;
                const isActive  = existingDescriptor?.descriptorId === d.descriptorId;
                const ago = (() => {
                  const ms = Date.now() - new Date(d.updatedAt).getTime();
                  const m  = Math.round(ms / 60000);
                  if (m < 1)   return 'just now';
                  if (m < 60)  return `${m}m ago`;
                  const h = Math.round(m / 60);
                  if (h < 24)  return `${h}h ago`;
                  return `${Math.round(h / 24)}d ago`;
                })();
                return (
                  <div
                    key={d.descriptorId}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: `1px solid ${isActive ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                      background: isActive ? 'var(--vf-accent-subtle)' : 'var(--vf-elevated)',
                    }}
                  >
                    {/* ── Name row — either plain label or inline rename input ── */}
                    {editingDraftId === d.descriptorId ? (
                      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                        <input
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')  void handleRenameDraft(d.descriptorId);
                            if (e.key === 'Escape') { setEditingDraftId(null); }
                          }}
                          style={{
                            flex: 1,
                            fontSize: 11,
                            padding: '3px 6px',
                            borderRadius: 4,
                            border: '1px solid var(--vf-accent)',
                            background: 'var(--vf-surface)',
                            color: 'var(--vf-text-primary)',
                            outline: 'none',
                          }}
                        />
                        <button
                          type="button"
                          disabled={savingRenameId === d.descriptorId}
                          onClick={() => void handleRenameDraft(d.descriptorId)}
                          style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', background: 'var(--vf-accent)', color: '#fff', cursor: 'pointer', fontWeight: 700 }}
                        >
                          {savingRenameId === d.descriptorId ? '…' : '✓'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingDraftId(null)}
                          style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'transparent', color: 'var(--vf-text-muted)', cursor: 'pointer' }}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--vf-text-primary)',
                          marginBottom: 3,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={d.screenName}
                      >
                        {d.screenName}
                      </div>
                    )}

                    <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginBottom: 6 }}>
                      {d.mibModule && <span>{d.mibModule} · </span>}
                      {d.objectCount} obj · {d.sectionCount} sec
                      <span style={{ float: 'right' }}>{ago}</span>
                    </div>

                    {/* ── Confirm-delete row ── */}
                    {confirmDeleteId === d.descriptorId ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 10, color: 'var(--vf-danger)', flex: 1 }}>Delete this draft?</span>
                        <button
                          type="button"
                          disabled={deletingDraftId === d.descriptorId}
                          onClick={() => void handleDeleteDraft(d.descriptorId)}
                          style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: 'none', background: 'var(--vf-danger)', color: '#fff', cursor: 'pointer', fontWeight: 700 }}
                        >
                          {deletingDraftId === d.descriptorId ? '…' : 'Delete'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'transparent', color: 'var(--vf-text-muted)', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      /* ── Normal action row ── */
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {/* Status badge */}
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 999,
                            background: d.status === 'published' ? 'rgba(34,197,94,0.15)' : 'rgba(96,165,250,0.12)',
                            color: d.status === 'published' ? 'var(--vf-success)' : 'var(--vf-accent)',
                            textTransform: 'uppercase',
                          }}
                        >
                          {d.status}
                        </span>

                        {/* Edit (rename) button — always available */}
                        {editingDraftId !== d.descriptorId && (
                          <button
                            type="button"
                            title="Rename this draft"
                            onClick={() => { setEditingDraftId(d.descriptorId); setEditingName(d.screenName); setConfirmDeleteId(null); }}
                            style={{
                              fontSize: 10,
                              padding: '2px 7px',
                              borderRadius: 4,
                              border: '1px solid var(--vf-border-subtle)',
                              background: 'transparent',
                              color: 'var(--vf-text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            ✏ Edit
                          </button>
                        )}

                        {/* Delete button — drafts only (published are protected) */}
                        {d.status === 'draft' && (
                          <button
                            type="button"
                            title="Delete this draft"
                            onClick={() => { setConfirmDeleteId(d.descriptorId); setEditingDraftId(null); }}
                            style={{
                              fontSize: 10,
                              padding: '2px 7px',
                              borderRadius: 4,
                              border: '1px solid rgba(239,68,68,0.4)',
                              background: 'transparent',
                              color: 'var(--vf-danger)',
                              cursor: 'pointer',
                            }}
                          >
                            🗑
                          </button>
                        )}

                        {/* Load / Active */}
                        {isActive ? (
                          <span style={{ fontSize: 10, color: 'var(--vf-accent)', marginLeft: 'auto' }}>
                            ✓ Active
                          </span>
                        ) : (
                          <button
                            type="button"
                            style={{
                              marginLeft: 'auto',
                              fontSize: 11,
                              fontWeight: 600,
                              background: 'var(--vf-accent)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 5,
                              padding: '3px 10px',
                              cursor: isLoading ? 'wait' : 'pointer',
                              opacity: isLoading ? 0.6 : 1,
                            }}
                            disabled={isLoading}
                            onClick={() => void handlePickDraft(d.descriptorId)}
                          >
                            {isLoading ? '…' : 'Load →'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden', padding: 16 }}>
        {/* ── Draft-restored banner (req G-05) — only when data came from a saved draft, not a fresh upload ── */}
        {existingDescriptor?.descriptorId && parseResult && parseSource === 'restored' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 14px',
              background: 'rgba(37,99,235,0.08)',
              border: '1px solid rgba(37,99,235,0.2)',
              borderRadius: 8,
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            <span style={{ fontSize: 16 }}>📂</span>
            <div style={{ flex: 1 }}>
              <strong style={{ color: 'var(--vf-accent)' }}>Restored draft:</strong>
              {' '}<span style={{ color: 'var(--vf-text-secondary)' }}>{existingDescriptor.screenName}</span>
              {' · '}
              <span style={{ color: 'var(--vf-text-muted)' }}>
                {selectedNames.size} of {parseResult.objects.length} objects selected
              </span>
            </div>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                background: existingDescriptor.status === 'published' ? 'rgba(22,163,74,0.12)' : 'rgba(245,158,11,0.1)',
                color: existingDescriptor.status === 'published' ? '#15803d' : '#92400e',
              }}
            >
              {existingDescriptor.status === 'published' ? '✓ Published' : '● Draft'}
            </span>
            {/* ── Re-upload MIB button ── */}
            <label
              title="Re-upload the MIB file to access all parsed objects"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                border: '1px solid var(--vf-border-subtle)',
                background: 'var(--vf-elevated)',
                color: 'var(--vf-text-secondary)',
                fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
              }}
            >
              📄 Load MIB file
              <input
                type="file"
                accept=".mib,.my,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f, { preserveSelection: true });
                  // reset so same file can be chosen again
                  e.target.value = '';
                }}
              />
            </label>
            <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
              Review selections below, then continue to Builder →
            </span>
          </div>
        )}

        {!parseResult ? (
          /* ── Nothing loaded ── */
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 14, padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📡</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Upload a MIB file to browse objects</div>
            <div style={{ fontSize: 12 }}>
              Or load an existing draft from the left panel to continue where you left off.
            </div>
          </div>
        ) : parseResult.objects.length === 0 && parseSource === 'restored' ? (
          /* ── Draft loaded but had no saved objects (pre-migration draft) ── */
          <div style={{ margin: 'auto', textAlign: 'center', fontSize: 14, padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📂</div>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--vf-text-primary)' }}>
              Draft loaded — no saved MIB objects
            </div>
            <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 16, maxWidth: 340, margin: '0 auto 16px' }}>
              This draft was saved before MIB object storage was added. Upload the MIB file again to re-select objects, then re-save the draft.
            </div>
            <label
              style={{ display: 'inline-block', padding: '8px 20px', borderRadius: 6, background: 'var(--vf-accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              ↑ Choose MIB file
              <input type="file" accept=".mib,.my,.txt" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
            </label>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
                  {/* Heading priority:
                       1. If restored from draft → use mibModule saved with draft
                       2. If freshly uploaded → use real module name (guard keywords) or fall back to filename
                       3. Last resort → "MIB Objects"
                  */}
                  {parseSource === 'restored' && existingDescriptor?.mibModule
                    && !['IMPORTS', 'EXPORTS', 'UNKNOWN-MIB'].includes(existingDescriptor.mibModule)
                    ? existingDescriptor.mibModule
                    : parseResult.moduleName && !['IMPORTS', 'EXPORTS', 'UNKNOWN-MIB'].includes(parseResult.moduleName)
                      ? parseResult.moduleName
                      : uploadedFileName || 'MIB Objects'}{' '}
                  · parsed objects
                </h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--vf-text-secondary)' }}>
                  Pick objects to make them available in the Screen Builder palette.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* Save draft — persists the current selection without going to the Screen Builder */}
                <button
                  type="button"
                  disabled={selectedObjects.length === 0 || saving || !screenNameInput.trim()}
                  style={{
                    ...BTN_SECONDARY,
                    opacity: selectedObjects.length === 0 ? 0.5 : 1,
                    cursor: selectedObjects.length === 0 ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  onClick={() => void handleSaveDraft()}
                >
                  {saving ? (
                    <>⏳ Saving…</>
                  ) : (
                    <>
                      💾 Save draft
                      {existingDescriptor?.descriptorId && (
                        <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 2 }}>· update</span>
                      )}
                    </>
                  )}
                </button>

                {/* Continue to Screen Builder */}
                <button
                  type="button"
                  disabled={selectedObjects.length === 0}
                  style={{
                    ...BTN_PRIMARY,
                    opacity: selectedObjects.length === 0 ? 0.5 : 1,
                    cursor: selectedObjects.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                  onClick={() => onNext(selectedObjects, parseResult)}
                >
                  {existingDescriptor?.descriptorId
                    ? `Continue to Builder with ${selectedObjects.length} selected →`
                    : `Use ${selectedObjects.length} selected in Builder →`}
                </button>
              </div>
            </div>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or OID..."
              style={{
                width: '100%',
                maxWidth: 360,
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid var(--vf-border-subtle)',
                marginBottom: 12,
                fontSize: 13,
              }}
            />

            <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 12 }}>
              <div
                style={{
                  width: '30%',
                  minWidth: 180,
                  flexShrink: 0,
                  minHeight: 0,
                  border: '1px solid var(--vf-border-subtle)',
                  borderRadius: 8,
                  overflow: 'auto',
                  padding: 8,
                  background: 'var(--vf-elevated)',
                }}
              >
                <div style={{ ...FORM_LABEL, marginBottom: 8 }}>MIB tree</div>
                {tree && renderTreeNode(tree, 0)}
              </div>

              <div
                ref={tableScrollRef}
                style={{
                  flex: 1,
                  minWidth: 0,
                  position: 'relative',
                  border: '1px solid var(--vf-border-subtle)',
                  borderRadius: 8,
                  overflow: 'auto',
                  background: 'var(--vf-surface)',
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--vf-elevated)', zIndex: 1 }}>
                    <tr>
                      {['', 'OBJECT', 'OID', 'SYNTAX', 'ACCESS', 'INDEX', 'SUGGESTED WIDGET', ''].map((h, hi) => (
                        <th
                          key={h || (hi === 0 ? 'cb' : 'actions')}
                          style={{
                            padding: '8px 10px',
                            textAlign: hi === 7 ? 'center' : 'left',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.05em',
                            color: 'var(--vf-text-muted)',
                            borderBottom: '1px solid var(--vf-border-subtle)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredObjects.map((obj) => {
                      const checked = selectedNames.has(obj.name);
                      const access = normalizeAccess(obj.access);
                      return (
                        <tr
                          key={obj.name}
                          ref={(el) => {
                            if (el) rowRefs.current.set(obj.name, el);
                            else rowRefs.current.delete(obj.name);
                          }}
                          onClick={() => {
                            setTreeFocusName(obj.name);
                            toggleSelected(obj.name);
                          }}
                          style={{
                            cursor: 'pointer',
                            background:
                              treeFocusName === obj.name
                                ? 'var(--vf-accent-subtle)'
                                : checked
                                  ? 'rgba(34,197,94,0.06)'
                                  : undefined,
                            borderBottom: '1px solid var(--vf-border-subtle)',
                          }}
                        >
                          <td style={{ padding: '8px 10px', width: 32 }} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelected(obj.name)}
                            />
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            {/* Object name with description tooltip */}
                            <div
                              style={{ fontWeight: 600, color: 'var(--vf-text-primary)' }}
                              title={obj.description ?? ''}
                            >
                              {obj.name}
                            </div>
                            {obj.description && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: 'var(--vf-text-muted)',
                                  marginTop: 2,
                                  maxWidth: 220,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                                title={obj.description}
                              >
                                {obj.description}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px', maxWidth: 180 }}>
                            <div
                              style={{
                                fontSize: 10,
                                color: 'var(--vf-text-muted)',
                                fontFamily: 'var(--vf-font-mono)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={obj.oid ?? ''}
                            >
                              {obj.oid ?? '—'}
                            </div>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--vf-text-secondary)', fontSize: 11 }}>
                            {obj.nmsDataType}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: 999,
                                fontSize: 10,
                                fontWeight: 700,
                                background:
                                  access === 'read-write'
                                    ? 'rgba(37,99,235,0.12)'
                                    : 'rgba(100,116,139,0.1)',
                                color:
                                  access === 'read-write' ? '#1d4ed8' : '#64748b',
                              }}
                            >
                              {access === 'read-write' ? 'read-write' : access === 'not-accessible' ? 'n/a' : 'read-only'}
                            </span>
                          </td>
                          {/* Index structure column */}
                          <td style={{ padding: '8px 10px' }}>
                            <span
                              style={{
                                padding: '2px 7px',
                                borderRadius: 4,
                                fontSize: 9,
                                fontWeight: 700,
                                background:
                                  obj.indexType === 'SCALAR'         ? 'rgba(16,185,129,0.1)'  :
                                  obj.indexType === 'SINGLE_INDEX'   ? 'rgba(99,102,241,0.1)'  :
                                  obj.indexType === 'DOUBLE_INDEX'   ? 'rgba(245,158,11,0.12)' :
                                                                       'rgba(239,68,68,0.1)',
                                color:
                                  obj.indexType === 'SCALAR'         ? '#059669' :
                                  obj.indexType === 'SINGLE_INDEX'   ? '#4f46e5' :
                                  obj.indexType === 'DOUBLE_INDEX'   ? '#b45309' :
                                                                       '#dc2626',
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}
                            >
                              {obj.indexType === 'SCALAR'        ? 'scalar'  :
                               obj.indexType === 'SINGLE_INDEX'  ? '1-idx'   :
                               obj.indexType === 'DOUBLE_INDEX'  ? '2-idx'   :
                                                                   '3-idx'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--vf-text-secondary)', fontSize: 11 }}>
                            {suggestWidget(obj)}
                          </td>
                          {/* Remove button */}
                          <td style={{ padding: '8px 10px', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              title="Remove from table (can be re-added)"
                              onClick={() => deleteRow(obj)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 14, opacity: 0.7, lineHeight: 1 }}
                            >✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* ── Add from MIB picker ───────────────────────────────── */}
                <div style={{ padding: '8px 12px', borderTop: '1px solid var(--vf-border-subtle)', position: 'relative' }}>
                  {deletedNames.size > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setAddPickerOpen((o) => !o); setAddPickerSearch(''); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          background: 'none', border: '1px dashed var(--vf-border-subtle)',
                          borderRadius: 6, padding: '5px 14px',
                          color: 'var(--vf-accent)', fontSize: 12, cursor: 'pointer', fontWeight: 500,
                        }}
                      >
                        <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
                        Add field from MIB
                        <span style={{
                          fontSize: 10, background: 'var(--vf-accent)', color: '#fff',
                          borderRadius: 999, padding: '1px 7px', fontWeight: 700,
                        }}>{deletedNames.size}</span>
                      </button>

                      {/* Dropdown picker */}
                      {addPickerOpen && (
                        <div
                          style={{
                            position: 'absolute', bottom: '100%', left: 12, zIndex: 50,
                            background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
                            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                            width: 420, maxHeight: 320, display: 'flex', flexDirection: 'column',
                          }}
                        >
                          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--vf-border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              autoFocus
                              placeholder="Search MIB fields…"
                              value={addPickerSearch}
                              onChange={(e) => setAddPickerSearch(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Escape') setAddPickerOpen(false); }}
                              style={{
                                flex: 1, padding: '5px 8px', borderRadius: 5,
                                border: '1px solid var(--vf-border-subtle)',
                                background: 'var(--vf-canvas)', color: 'var(--vf-text-primary)', fontSize: 12,
                              }}
                            />
                            <button type="button" onClick={() => setAddPickerOpen(false)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 16, lineHeight: 1 }}>✕</button>
                          </div>
                          <div style={{ overflowY: 'auto', flex: 1 }}>
                            {(parseResult?.objects ?? [])
                              .filter((o) => {
                                if (!deletedNames.has(o.name)) return false;
                                const q = addPickerSearch.trim().toLowerCase();
                                if (!q) return true;
                                return o.name.toLowerCase().includes(q) || (o.oid ?? '').includes(q) || (o.description ?? '').toLowerCase().includes(q);
                              })
                              .map((o) => (
                                <button
                                  key={o.name}
                                  type="button"
                                  onClick={() => { reAddMibObject(o); setAddPickerOpen(false); }}
                                  style={{
                                    width: '100%', textAlign: 'left', padding: '8px 12px',
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    borderBottom: '1px solid var(--vf-border-subtle)',
                                    display: 'flex', flexDirection: 'column', gap: 2,
                                  }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--vf-elevated)'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--vf-text-primary)' }}>{o.name}</span>
                                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(16,185,129,0.1)', color: '#059669', fontWeight: 700 }}>
                                      {o.nmsDataType}
                                    </span>
                                    <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(100,116,139,0.1)', color: '#64748b', fontWeight: 700 }}>
                                      {o.indexType === 'SCALAR' ? 'scalar' : o.indexType === 'SINGLE_INDEX' ? '1-idx' : o.indexType === 'DOUBLE_INDEX' ? '2-idx' : '3-idx'}
                                    </span>
                                  </div>
                                  {o.description && (
                                    <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>
                                      {o.description}
                                    </div>
                                  )}
                                </button>
                              ))
                            }
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                      All MIB fields are shown. Use ✕ to remove a field from this view.
                    </span>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Screen 2: Screen Builder ─────────────────────────────────────────────────

const LAYOUT_PALETTE: { type: UiDescriptorField['elementType']; label: string }[] = [
  { type: 'heading', label: 'Heading' },
  { type: 'sub-heading', label: 'Sub-heading' },
  { type: 'field-label', label: 'Field label' },
  { type: 'table-block', label: 'Table block' },
  { type: 'divider', label: 'Divider' },
];

function emptyDraft(module?: string, profile?: string): UiDescriptorDraft {
  return {
    screenName: module ? module.replace(/-MIB$/i, ' Overview') : 'New Screen',
    deviceProfile: profile,
    mibModule: module,
    status: 'draft',
    sections: [],
  };
}

function boundObjectNames(sections: UiDescriptorSection[]): Set<string> {
  const s = new Set<string>();
  for (const sec of sections) {
    for (const f of sec.fields) {
      if (f.mibObject) s.add(f.mibObject);
    }
  }
  return s;
}

// Shared input style — works in both light and dark themes
const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-canvas)',
  color: 'var(--vf-text-primary)',
  fontSize: 13,
  marginBottom: 10,
};

const SELECT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-canvas)',
  color: 'var(--vf-text-primary)',
  fontSize: 13,
  marginBottom: 10,
};

function ScreenBuilderScreen({
  objects,
  parsedMib,
  descriptor,
  onChange,
  onPreview,
  deviceProfile,
}: {
  objects: MibObjectSummary[];
  parsedMib: ParseMibResult | null;
  descriptor: UiDescriptorDraft | null;
  onChange: (d: UiDescriptorDraft) => void;
  onPreview: () => void;
  deviceProfile?: string;
}) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<{ sectionId: string; fieldId: string } | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  /** ID of the canvas section currently being dragged over for MIB-object drops. */
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** Tracks which field card the cursor is hovering (for action-button visibility). */
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null);
  /** Section whose title is currently being edited inline. */
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  /** Confirm-delete state for sections (shows inline confirm bar). */
  const [confirmDeleteSectionId, setConfirmDeleteSectionId] = useState<string | null>(null);
  /**
   * Field being dragged within the canvas for reordering.
   * { fieldId, sectionId } — set on onDragStart of a canvas field card.
   */
  const [draggingField, setDraggingField] = useState<{ fieldId: string; sectionId: string } | null>(null);
  /** Drop target for canvas-field reorder drag. */
  const [dropTargetField, setDropTargetField] = useState<{ fieldId: string; sectionId: string; position: 'before' | 'after' } | null>(null);

  const draft = descriptor ?? emptyDraft(parsedMib?.moduleName, deviceProfile ?? parsedMib?.vendor);

  const bound = boundObjectNames(draft.sections);

  const updateDraft = useCallback(
    (patch: Partial<UiDescriptorDraft> | ((d: UiDescriptorDraft) => UiDescriptorDraft)) => {
      const base = descriptor ?? emptyDraft(parsedMib?.moduleName, deviceProfile);
      const next = typeof patch === 'function' ? patch(base) : { ...base, ...patch };
      onChange(next);
    },
    [descriptor, onChange, parsedMib, deviceProfile],
  );

  function addLayoutElement(type: UiDescriptorField['elementType']) {
    updateDraft((d) => {
      const sections = [...d.sections];
      if (type === 'heading') {
        let headSec = sections.find((s) => s.fields.some((f) => f.elementType === 'heading'));
        if (!headSec) {
          headSec = {
            sectionId: sid(),
            title: '',
            columns: 2,
            fields: [],
            order: -1,
          };
          sections.unshift(headSec);
        }
        const field: UiDescriptorField = {
          fieldId: uid(),
          elementType: 'heading',
          label: d.screenName,
          labelLevel: 'heading',
          order: 0,
        };
        headSec.fields = [...headSec.fields.filter((f) => f.elementType !== 'heading'), field];
        setSelected({ sectionId: headSec.sectionId, fieldId: field.fieldId });
        return { ...d, sections };
      }

      if (type === 'sub-heading') {
        const sec: UiDescriptorSection = {
          sectionId: sid(),
          title: 'New section',
          columns: 2,
          writeMode: 'apply-button',
          pollInterval: 30,
          order: sections.length,
          fields: [
            {
              fieldId: uid(),
              elementType: 'sub-heading',
              label: 'New section',
              labelLevel: 'sub-heading',
              order: 0,
            },
          ],
        };
        sections.push(sec);
        setActiveSectionId(sec.sectionId);
        setSelected({ sectionId: sec.sectionId, fieldId: sec.fields[0].fieldId });
        return { ...d, sections };
      }

      let targetId = activeSectionId;
      let sec = sections.find((s) => s.sectionId === targetId);
      if (!sec) {
        sec = {
          sectionId: sid(),
          title: 'Fields',
          columns: 2,
          order: sections.length,
          fields: [],
        };
        sections.push(sec);
        setActiveSectionId(sec.sectionId);
      }

      const labels: Record<string, string> = {
        'field-label': 'New field',
        'table-block': 'Table',
        divider: '—',
      };
      const field: UiDescriptorField = {
        fieldId: uid(),
        elementType: type,
        label: labels[type] ?? 'Element',
        labelLevel: type === 'field-label' ? 'field' : undefined,
        order: sec.fields.length,
        widget: type === 'table-block' ? 'Data table' : undefined,
      };
      sec.fields = [...sec.fields, field];
      setSelected({ sectionId: sec.sectionId, fieldId: field.fieldId });
      return { ...d, sections };
    });
  }

  function bindObjectToSelected(obj: MibObjectSummary) {
    if (!selected) return;
    updateDraft((d) => {
      const sections = d.sections.map((sec) => {
        if (sec.sectionId !== selected.sectionId) return sec;
        return {
          ...sec,
          fields: sec.fields.map((f) => {
            if (f.fieldId !== selected.fieldId) return f;
            if (f.elementType !== 'field-label' && f.elementType !== 'table-block') return f;
            return {
              ...f,
              mibObject: obj.name,
              oid: obj.oid ?? undefined,
              syntax: obj.nmsDataType,
              units: (obj as MibObjectSummary & { units?: string }).units,
              access: normalizeAccess(obj.access),
              widget: suggestWidget(obj),
              enumMap: enumMapFor(obj, f.enumMap),
              label: f.label === 'New field' || f.label === 'Table' ? obj.name : f.label,
              minValue: obj.nmsDataType.toLowerCase().includes('int') ? 0 : undefined,
              maxValue: obj.nmsDataType.toLowerCase().includes('int') ? 100 : undefined,
            };
          }),
        };
      });
      return { ...d, sections };
    });
  }

  /**
   * Drop a MIB object onto a specific canvas section.
   * Creates a new field (field-label or table-block) bound to the object.
   * If sectionId is null, creates a brand-new section first.
   */
  function dropObjectOnSection(obj: MibObjectSummary, targetSectionId: string | null) {
    const elemType: UiDescriptorField['elementType'] =
      obj.indexType !== 'SCALAR' ? 'table-block' : 'field-label';
    const newField: UiDescriptorField = {
      fieldId: uid(),
      elementType: elemType,
      label: obj.name,
      labelLevel: 'field',
      mibObject: obj.name,
      oid: obj.oid ?? undefined,
      syntax: obj.nmsDataType,
      access: normalizeAccess(obj.access),
      widget: suggestWidget(obj),
      enumMap: enumMapFor(obj),
      order: 999,
    };

    updateDraft((d) => {
      let sections = [...d.sections];

      if (targetSectionId) {
        sections = sections.map((sec) => {
          if (sec.sectionId !== targetSectionId) return sec;
          return { ...sec, fields: [...sec.fields, { ...newField, order: sec.fields.length }] };
        });
      } else {
        // No section — create one
        const newSec: UiDescriptorSection = {
          sectionId: sid(),
          title: obj.name,
          columns: 2,
          pollInterval: 30,
          writeMode: 'apply-button',
          order: sections.filter((s) => s.order >= 0).length,
          fields: [newField],
        };
        sections.push(newSec);
        setActiveSectionId(newSec.sectionId);
      }

      return { ...d, sections };
    });

    if (targetSectionId) setActiveSectionId(targetSectionId);
    setSelected({ sectionId: targetSectionId ?? '', fieldId: newField.fieldId });
  }

  const selectedField = useMemo(() => {
    if (!selected) return null;
    const sec = draft.sections.find((s) => s.sectionId === selected.sectionId);
    return sec?.fields.find((f) => f.fieldId === selected.fieldId) ?? null;
  }, [draft.sections, selected]);

  async function handleSaveDraft() {
    setSaving(true);
    const xml = generateUiXml(draft);
    const payload = {
      screenName: draft.screenName,
      deviceProfile: draft.deviceProfile,
      mibModule: draft.mibModule,
      vendor: parsedMib?.vendor,
      productFamily: parsedMib?.productLine,
      status: 'draft' as const,
      sections: draft.sections,
      generatedXml: xml,
      /** Keep selectedObjects in sync so session restore always has the latest selection. */
      selectedObjects: draft.selectedObjects ?? objects,
    };
    try {
      if (draft.descriptorId) {
        await updateDescriptor(draft.descriptorId, payload);
      } else {
        const created = await createDescriptor(payload);
        updateDraft({ descriptorId: created.descriptorId, generatedXml: xml });
      }
      addToast('Draft saved', 'success');
    } catch {
      addToast('Failed to save draft', 'error');
    } finally {
      setSaving(false);
    }
  }

  function patchSelectedField(patch: Partial<UiDescriptorField>) {
    if (!selected) return;
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((sec) =>
        sec.sectionId !== selected.sectionId
          ? sec
          : {
              ...sec,
              fields: sec.fields.map((f) => (f.fieldId === selected.fieldId ? { ...f, ...patch } : f)),
            },
      ),
    }));
  }

  function unsetBinding() {
    patchSelectedField({
      mibObject: undefined,
      oid: undefined,
      syntax: undefined,
      units: undefined,
      access: undefined,
    });
  }

  // ── Section CRUD ────────────────────────────────────────────────────────────

  function patchSection(sectionId: string, patch: Partial<UiDescriptorSection>) {
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => s.sectionId !== sectionId ? s : { ...s, ...patch }),
    }));
  }

  function deleteSection(sectionId: string) {
    updateDraft((d) => ({
      ...d,
      sections: d.sections.filter((s) => s.sectionId !== sectionId).map((s, i) => ({ ...s, order: s.order < 0 ? s.order : i })),
    }));
    if (selected?.sectionId === sectionId) setSelected(null);
    if (activeSectionId === sectionId) setActiveSectionId(null);
    setConfirmDeleteSectionId(null);
  }

  function moveSectionUp(sectionId: string) {
    updateDraft((d) => {
      const ordered = [...d.sections.filter((s) => s.order >= 0)].sort((a, b) => a.order - b.order);
      const idx = ordered.findIndex((s) => s.sectionId === sectionId);
      if (idx <= 0) return d;
      [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
      const reordered = ordered.map((s, i) => ({ ...s, order: i }));
      const hidden = d.sections.filter((s) => s.order < 0);
      return { ...d, sections: [...hidden, ...reordered] };
    });
  }

  function moveSectionDown(sectionId: string) {
    updateDraft((d) => {
      const ordered = [...d.sections.filter((s) => s.order >= 0)].sort((a, b) => a.order - b.order);
      const idx = ordered.findIndex((s) => s.sectionId === sectionId);
      if (idx < 0 || idx >= ordered.length - 1) return d;
      [ordered[idx], ordered[idx + 1]] = [ordered[idx + 1], ordered[idx]];
      const reordered = ordered.map((s, i) => ({ ...s, order: i }));
      const hidden = d.sections.filter((s) => s.order < 0);
      return { ...d, sections: [...hidden, ...reordered] };
    });
  }

  // ── Field CRUD ──────────────────────────────────────────────────────────────

  function deleteField(sectionId: string, fieldId: string) {
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.sectionId !== sectionId ? s : { ...s, fields: s.fields.filter((f) => f.fieldId !== fieldId).map((f, i) => ({ ...f, order: i })) },
      ),
    }));
    if (selected?.fieldId === fieldId) setSelected(null);
  }

  function moveFieldUp(sectionId: string, fieldId: string) {
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== sectionId) return s;
        const fields = [...s.fields].sort((a, b) => a.order - b.order);
        const idx = fields.findIndex((f) => f.fieldId === fieldId);
        if (idx <= 0) return s;
        [fields[idx - 1], fields[idx]] = [fields[idx], fields[idx - 1]];
        return { ...s, fields: fields.map((f, i) => ({ ...f, order: i })) };
      }),
    }));
  }

  function moveFieldDown(sectionId: string, fieldId: string) {
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== sectionId) return s;
        const fields = [...s.fields].sort((a, b) => a.order - b.order);
        const idx = fields.findIndex((f) => f.fieldId === fieldId);
        if (idx < 0 || idx >= fields.length - 1) return s;
        [fields[idx], fields[idx + 1]] = [fields[idx + 1], fields[idx]];
        return { ...s, fields: fields.map((f, i) => ({ ...f, order: i })) };
      }),
    }));
  }

  function moveFieldToSection(fieldId: string, fromSectionId: string, toSectionId: string) {
    if (fromSectionId === toSectionId) return;
    updateDraft((d) => {
      let movedField: UiDescriptorField | null = null;
      const sections = d.sections.map((s) => {
        if (s.sectionId === fromSectionId) {
          const f = s.fields.find((f) => f.fieldId === fieldId);
          if (f) movedField = f;
          return { ...s, fields: s.fields.filter((f) => f.fieldId !== fieldId).map((f, i) => ({ ...f, order: i })) };
        }
        return s;
      }).map((s) => {
        if (s.sectionId === toSectionId && movedField) {
          return { ...s, fields: [...s.fields, { ...movedField, order: s.fields.length }] };
        }
        return s;
      });
      return { ...d, sections };
    });
    setSelected({ sectionId: toSectionId, fieldId });
    setActiveSectionId(toSectionId);
  }

  /** Reorder fields by dragging within the canvas. */
  function dropFieldOnField(
    dragged: { fieldId: string; sectionId: string },
    target: { fieldId: string; sectionId: string; position: 'before' | 'after' },
  ) {
    if (dragged.fieldId === target.fieldId) return;
    if (dragged.sectionId !== target.sectionId) {
      // Cross-section move: first move the field, then we'll re-sort
      moveFieldToSection(dragged.fieldId, dragged.sectionId, target.sectionId);
      return;
    }
    updateDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => {
        if (s.sectionId !== dragged.sectionId) return s;
        let fields = [...s.fields].sort((a, b) => a.order - b.order);
        const fromIdx = fields.findIndex((f) => f.fieldId === dragged.fieldId);
        const toIdx   = fields.findIndex((f) => f.fieldId === target.fieldId);
        if (fromIdx < 0 || toIdx < 0) return s;
        const [item] = fields.splice(fromIdx, 1);
        const insertAt = target.position === 'before' ? (fromIdx < toIdx ? toIdx - 1 : toIdx) : (fromIdx < toIdx ? toIdx : toIdx + 1);
        fields.splice(Math.max(0, insertAt), 0, item);
        return { ...s, fields: fields.map((f, i) => ({ ...f, order: i })) };
      }),
    }));
  }

  const canvasSections = draft.sections
    .filter((s) => s.order >= 0)
    .sort((a, b) => a.order - b.order);

  const headingField = draft.sections.flatMap((s) => s.fields).find((f) => f.elementType === 'heading');

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <aside
        style={{
          width: 220,
          borderRight: '1px solid var(--vf-border-subtle)',
          padding: 12,
          overflowY: 'auto',
          background: 'var(--vf-surface)',
        }}
      >
        <div style={FORM_LABEL}>Layout elements</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
          {LAYOUT_PALETTE.map((item) => (
            <button
              key={item.type}
              type="button"
              style={{ ...BTN_SECONDARY, textAlign: 'left' }}
              onClick={() => addLayoutElement(item.type)}
            >
              + {item.label}
            </button>
          ))}
        </div>

        <div style={FORM_LABEL}>MIB objects</div>
        <p style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 0, marginBottom: 8, lineHeight: 1.4 }}>
          Drag onto a section — or click to bind to selected field.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {objects.map((obj) => {
            const isBound = bound.has(obj.name);
            return (
              <div
                key={obj.name}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'mib-object', name: obj.name }));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => bindObjectToSelected(obj)}
                onKeyDown={(e) => e.key === 'Enter' && bindObjectToSelected(obj)}
                style={{
                  ...BTN_SECONDARY,
                  textAlign: 'left',
                  borderColor: isBound ? 'var(--vf-success)' : undefined,
                  cursor: 'grab',
                  userSelect: 'none',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-primary)' }}>{obj.name}</div>
                <div style={{ fontSize: 10, color: isBound ? 'var(--vf-success)' : 'var(--vf-text-muted)', marginTop: 2 }}>
                  {isBound ? '✓ BOUND' : `${obj.nmsDataType} · ${suggestWidget(obj)}`}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
            borderBottom: '1px solid var(--vf-border-subtle)',
            background: 'var(--vf-elevated)',
            flexWrap: 'wrap',
          }}
        >
          <input
            value={draft.screenName}
            onChange={(e) => updateDraft({ screenName: e.target.value })}
            placeholder="Screen name"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--vf-border-subtle)',
              background: 'var(--vf-canvas)',
              color: 'var(--vf-text-primary)',
              fontSize: 13,
              fontWeight: 600,
              minWidth: 200,
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
            {draft.deviceProfile || parsedMib?.vendor || 'Device profile'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" style={{ ...BTN_SECONDARY, opacity: 0.5, cursor: 'not-allowed' }} disabled>
              Undo
            </button>
            <button type="button" style={BTN_SECONDARY} onClick={() => void handleSaveDraft()} disabled={saving}>
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              style={BTN_PRIMARY}
              onClick={() => {
                updateDraft({ generatedXml: generateUiXml(draft) });
                onPreview();
              }}
            >
              Preview →
            </button>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 24,
            background: 'var(--vf-elevated)',
          }}
        >
          <div
            style={{
              maxWidth: 900,
              margin: '0 auto',
              minHeight: 360,
              background: 'var(--vf-surface)',
              borderRadius: 10,
              border: '1px solid var(--vf-border-subtle)',
              padding: 24,
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}
            /* Canvas-level drop: creates a new section */
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/plain')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain')) as { type: string; name: string };
                if (data.type !== 'mib-object') return;
                const obj = objects.find((o) => o.name === data.name);
                if (obj) dropObjectOnSection(obj, null);
              } catch { /* ignore */ }
            }}
          >
            {headingField && (
              <h1
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  margin: '0 0 20px',
                  color: 'var(--vf-text-primary)',
                }}
              >
                {headingField.label}
              </h1>
            )}

            {canvasSections.length === 0 && !headingField && (
              <div
                style={{
                  textAlign: 'center',
                  marginTop: 80,
                  padding: 32,
                  border: '2px dashed var(--vf-border-subtle)',
                  borderRadius: 10,
                  color: 'var(--vf-text-muted)',
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 12 }}>🎯</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Drop MIB objects here</div>
                <div style={{ fontSize: 12 }}>Or use the palette buttons on the left to add layout elements</div>
              </div>
            )}

            {canvasSections.map((sec, secIdx) => {
              const sub = sec.fields.find((f) => f.elementType === 'sub-heading');
              const fields = sec.fields.filter(
                (f) => f.elementType === 'field-label' || f.elementType === 'table-block' || f.elementType === 'divider',
              ).sort((a, b) => a.order - b.order);
              const isDropTarget = dragOverId === sec.sectionId;
              const isConfirmDelete = confirmDeleteSectionId === sec.sectionId;
              const isEditingTitle = editingSectionId === sec.sectionId;

              return (
                <div
                  key={sec.sectionId}
                  style={{
                    marginBottom: 24,
                    borderRadius: 8,
                    border: `2px solid ${
                      isDropTarget ? 'var(--vf-accent)'
                      : activeSectionId === sec.sectionId ? 'var(--vf-accent)'
                      : 'var(--vf-border-subtle)'
                    }`,
                    background: isDropTarget ? 'var(--vf-accent-subtle)'
                      : activeSectionId === sec.sectionId ? 'rgba(96,165,250,0.06)'
                      : 'var(--vf-elevated)',
                    transition: 'border-color 0.1s, background 0.1s',
                    overflow: 'hidden',
                  }}
                  onClick={() => setActiveSectionId(sec.sectionId)}
                  onDragOver={(e) => {
                    const raw = e.dataTransfer.types.includes('text/plain');
                    if (!raw) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'copy';
                    setDragOverId(sec.sectionId);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverId(null);
                    setDropTargetField(null);
                    try {
                      const raw = e.dataTransfer.getData('text/plain');
                      const data = JSON.parse(raw) as { type: string; name?: string; fieldId?: string; sectionId?: string };
                      if (data.type === 'mib-object' && data.name) {
                        const obj = objects.find((o) => o.name === data.name);
                        if (obj) dropObjectOnSection(obj, sec.sectionId);
                      } else if (data.type === 'canvas-field' && data.fieldId && data.sectionId && data.sectionId !== sec.sectionId) {
                        moveFieldToSection(data.fieldId, data.sectionId, sec.sectionId);
                      }
                    } catch { /* ignore */ }
                  }}
                >
                  {/* ── Section toolbar ────────────────────────────────────── */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '7px 10px',
                      background: 'var(--vf-surface)',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Editable section title */}
                    {isEditingTitle ? (
                      <input
                        autoFocus
                        value={sec.title}
                        onChange={(e) => {
                          patchSection(sec.sectionId, { title: e.target.value });
                          if (sub) updateDraft((d) => ({
                            ...d,
                            sections: d.sections.map((s) => s.sectionId !== sec.sectionId ? s : {
                              ...s,
                              fields: s.fields.map((f) => f.elementType === 'sub-heading' ? { ...f, label: e.target.value } : f),
                            }),
                          }));
                        }}
                        onBlur={() => setEditingSectionId(null)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingSectionId(null); }}
                        style={{ flex: 1, fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--vf-accent)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', outline: 'none' }}
                      />
                    ) : (
                      <span
                        title="Click to rename"
                        onClick={() => setEditingSectionId(sec.sectionId)}
                        style={{ flex: 1, fontSize: 11, fontWeight: 700, color: 'var(--vf-text-primary)', cursor: 'text', padding: '2px 4px', borderRadius: 4, border: '1px solid transparent' }}
                      >
                        {sec.title || 'Untitled section'}
                      </span>
                    )}

                    {/* Columns toggle */}
                    <button
                      type="button"
                      title="Toggle 1 / 2 columns"
                      onClick={() => patchSection(sec.sectionId, { columns: sec.columns === 1 ? 2 : 1 })}
                      style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {sec.columns}-col
                    </button>

                    {/* Poll interval */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <input
                        type="number"
                        value={sec.pollInterval ?? 30}
                        min={5}
                        onChange={(e) => patchSection(sec.sectionId, { pollInterval: Number(e.target.value) })}
                        title="Poll interval (seconds)"
                        style={{ width: 36, fontSize: 9, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: 9, color: 'var(--vf-text-muted)' }}>s</span>
                    </div>

                    {/* Write mode */}
                    <select
                      value={sec.writeMode ?? 'apply-button'}
                      onChange={(e) => patchSection(sec.sectionId, { writeMode: e.target.value as UiDescriptorSection['writeMode'] })}
                      title="Write mode"
                      style={{ fontSize: 9, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)' }}
                    >
                      <option value="apply-button">Apply btn</option>
                      <option value="direct">Direct</option>
                      <option value="read-only">Read-only</option>
                    </select>

                    {/* Section reorder ↑↓ */}
                    <button type="button" title="Move section up" onClick={() => moveSectionUp(sec.sectionId)}
                      style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'transparent', color: secIdx === 0 ? 'var(--vf-text-muted)' : 'var(--vf-text-secondary)', cursor: secIdx === 0 ? 'default' : 'pointer', opacity: secIdx === 0 ? 0.4 : 1 }}
                      disabled={secIdx === 0}
                    >↑</button>
                    <button type="button" title="Move section down" onClick={() => moveSectionDown(sec.sectionId)}
                      style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'transparent', color: secIdx === canvasSections.length - 1 ? 'var(--vf-text-muted)' : 'var(--vf-text-secondary)', cursor: secIdx === canvasSections.length - 1 ? 'default' : 'pointer', opacity: secIdx === canvasSections.length - 1 ? 0.4 : 1 }}
                      disabled={secIdx === canvasSections.length - 1}
                    >↓</button>

                    {/* Delete section */}
                    <button type="button" title="Delete section" onClick={() => setConfirmDeleteSectionId(sec.sectionId)}
                      style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(239,68,68,0.35)', background: 'transparent', color: 'var(--vf-danger)', cursor: 'pointer' }}
                    >🗑</button>
                  </div>

                  {/* ── Confirm-delete section bar ─────────────────────────── */}
                  {isConfirmDelete && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}
                      onClick={(e) => e.stopPropagation()}>
                      <span style={{ flex: 1, fontSize: 11, color: 'var(--vf-danger)' }}>Delete "{sec.title}"? This removes all {fields.length} field{fields.length !== 1 ? 's' : ''}.</span>
                      <button type="button" onClick={() => deleteSection(sec.sectionId)}
                        style={{ fontSize: 10, padding: '2px 10px', borderRadius: 4, border: 'none', background: 'var(--vf-danger)', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>Delete</button>
                      <button type="button" onClick={() => setConfirmDeleteSectionId(null)}
                        style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--vf-border-subtle)', background: 'transparent', color: 'var(--vf-text-muted)', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  )}

                  {/* ── Section body ────────────────────────────────────────── */}
                  <div style={{ padding: 14 }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: sec.columns === 1 ? '1fr' : '1fr 1fr',
                        gap: 10,
                      }}
                    >
                      {fields.map((f, fIdx) => {
                        const isSel = selected?.fieldId === f.fieldId;
                        const isHovered = hoveredFieldId === f.fieldId;
                        const isDragTarget = dropTargetField?.fieldId === f.fieldId;

                        if (f.elementType === 'divider') {
                          return (
                            <div key={f.fieldId} style={{ gridColumn: '1 / -1', position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--vf-border-subtle)' }} onClick={(e) => { e.stopPropagation(); setSelected({ sectionId: sec.sectionId, fieldId: f.fieldId }); }} />
                              <button type="button" onClick={(e) => { e.stopPropagation(); deleteField(sec.sectionId, f.fieldId); }}
                                style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: 'var(--vf-danger)', cursor: 'pointer' }}>×</button>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={f.fieldId}
                            role="button"
                            tabIndex={0}
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'canvas-field', fieldId: f.fieldId, sectionId: sec.sectionId }));
                              e.dataTransfer.effectAllowed = 'move';
                              setDraggingField({ fieldId: f.fieldId, sectionId: sec.sectionId });
                            }}
                            onDragEnd={() => { setDraggingField(null); setDropTargetField(null); }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                              setDropTargetField({ fieldId: f.fieldId, sectionId: sec.sectionId, position });
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              try {
                                const data = JSON.parse(e.dataTransfer.getData('text/plain')) as { type: string; fieldId?: string; sectionId?: string; name?: string };
                                if (data.type === 'canvas-field' && data.fieldId && data.sectionId) {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                                  dropFieldOnField({ fieldId: data.fieldId, sectionId: data.sectionId }, { fieldId: f.fieldId, sectionId: sec.sectionId, position });
                                } else if (data.type === 'mib-object' && data.name) {
                                  const obj = objects.find((o) => o.name === data.name);
                                  if (obj) dropObjectOnSection(obj, sec.sectionId);
                                }
                              } catch { /* ignore */ }
                              setDropTargetField(null);
                              setDragOverId(null);
                            }}
                            onClick={(e) => { e.stopPropagation(); setSelected({ sectionId: sec.sectionId, fieldId: f.fieldId }); setActiveSectionId(sec.sectionId); }}
                            onMouseEnter={() => setHoveredFieldId(f.fieldId)}
                            onMouseLeave={() => setHoveredFieldId((prev) => prev === f.fieldId ? null : prev)}
                            style={{
                              position: 'relative',
                              padding: '10px 12px',
                              borderRadius: 6,
                              border: `2px solid ${isSel ? 'var(--vf-accent)' : isDragTarget ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`,
                              background: isSel ? 'var(--vf-accent-subtle)' : isDragTarget ? 'rgba(96,165,250,0.07)' : 'var(--vf-canvas)',
                              cursor: 'grab',
                              opacity: draggingField?.fieldId === f.fieldId ? 0.4 : 1,
                              outline: isDragTarget && dropTargetField?.position === 'before' ? '2px solid var(--vf-accent)' : 'none',
                              outlineOffset: '-2px',
                              transition: 'border-color 0.1s, background 0.1s',
                            }}
                          >
                            {/* ── Field action buttons (shown on hover or selection) ── */}
                            {(isSel || isHovered) && (
                              <div
                                style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3, zIndex: 2 }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button type="button" title="Move up" onClick={() => moveFieldUp(sec.sectionId, f.fieldId)}
                                  disabled={fIdx === 0}
                                  style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: fIdx === 0 ? 'var(--vf-text-muted)' : 'var(--vf-text-secondary)', cursor: fIdx === 0 ? 'default' : 'pointer', opacity: fIdx === 0 ? 0.4 : 1 }}>↑</button>
                                <button type="button" title="Move down" onClick={() => moveFieldDown(sec.sectionId, f.fieldId)}
                                  disabled={fIdx === fields.length - 1}
                                  style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', color: fIdx === fields.length - 1 ? 'var(--vf-text-muted)' : 'var(--vf-text-secondary)', cursor: fIdx === fields.length - 1 ? 'default' : 'pointer', opacity: fIdx === fields.length - 1 ? 0.4 : 1 }}>↓</button>
                                <button type="button" title="Delete field" onClick={() => deleteField(sec.sectionId, f.fieldId)}
                                  style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: 'var(--vf-danger)', cursor: 'pointer', fontWeight: 700 }}>×</button>
                              </div>
                            )}

                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 3, paddingRight: (isSel || isHovered) ? 64 : 0 }}>
                              {f.label}
                            </div>
                            {f.mibObject ? (
                              <div style={{ fontSize: 10, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-accent)' }}>
                                {f.mibObject} · {f.widget}
                              </div>
                            ) : (
                              <div style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>
                                {f.oid ? f.oid : 'Unbound — select & bind MIB'}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Drop-here pill shown when dragging a MIB object over this section */}
                      {isDropTarget && draggingField === null && (
                        <div style={{ padding: '10px 12px', borderRadius: 6, border: '2px dashed var(--vf-accent)', background: 'var(--vf-accent-subtle)', color: 'var(--vf-accent)', fontSize: 12, fontWeight: 600, textAlign: 'center' }}>
                          + Drop here
                        </div>
                      )}
                    </div>

                    {/* Empty-section placeholder */}
                    {fields.length === 0 && !isDropTarget && (
                      <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--vf-text-muted)', fontSize: 12, border: '1px dashed var(--vf-border-subtle)', borderRadius: 6 }}>
                        Drop a MIB object or add a field from the palette
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <aside
        style={{
          width: 280,
          borderLeft: '1px solid var(--vf-border-subtle)',
          padding: 14,
          overflowY: 'auto',
          background: 'var(--vf-surface)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Properties</div>
        {!selectedField ? (
          <p style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Select a canvas element to edit properties.</p>
        ) : (
          <>
            {/* ── Field-level actions bar ── */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {/* Move up / down within section */}
              {selected && (() => {
                const sec = draft.sections.find((s) => s.sectionId === selected.sectionId);
                const fields = (sec?.fields ?? []).filter((f) => f.elementType !== 'sub-heading' && f.elementType !== 'heading').sort((a, b) => a.order - b.order);
                const fIdx = fields.findIndex((f) => f.fieldId === selected.fieldId);
                return (
                  <>
                    <button type="button" disabled={fIdx <= 0} onClick={() => moveFieldUp(selected.sectionId, selected.fieldId)}
                      title="Move field up"
                      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)', cursor: fIdx <= 0 ? 'default' : 'pointer', opacity: fIdx <= 0 ? 0.4 : 1 }}>↑ Up</button>
                    <button type="button" disabled={fIdx >= fields.length - 1} onClick={() => moveFieldDown(selected.sectionId, selected.fieldId)}
                      title="Move field down"
                      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)', cursor: fIdx >= fields.length - 1 ? 'default' : 'pointer', opacity: fIdx >= fields.length - 1 ? 0.4 : 1 }}>↓ Down</button>
                  </>
                );
              })()}
              <button type="button" onClick={() => selected && deleteField(selected.sectionId, selected.fieldId)}
                title="Delete this field"
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.06)', color: 'var(--vf-danger)', cursor: 'pointer', fontWeight: 600 }}>🗑 Delete</button>
            </div>

            {/* Move to section */}
            {canvasSections.length > 1 && selected && (
              <div style={{ marginBottom: 14 }}>
                <label style={FORM_LABEL}>Move to section</label>
                <select
                  value={selected.sectionId}
                  onChange={(e) => selected && moveFieldToSection(selected.fieldId, selected.sectionId, e.target.value)}
                  style={{ ...SELECT_STYLE }}
                >
                  {canvasSections.map((s) => (
                    <option key={s.sectionId} value={s.sectionId}>{s.title || 'Untitled'}</option>
                  ))}
                </select>
              </div>
            )}

            <label style={FORM_LABEL}>Label</label>
            <input
              value={selectedField.label}
              onChange={(e) => patchSelectedField({ label: e.target.value })}
              style={{ ...INPUT_STYLE }}
            />

                <label style={FORM_LABEL}>Label level</label>
                <select
                  value={selectedField.labelLevel ?? selectedField.elementType.replace('-block', '')}
                  onChange={(e) =>
                    patchSelectedField({ labelLevel: e.target.value as UiDescriptorField['labelLevel'] })
                  }
                  style={{ ...SELECT_STYLE }}
                >
              <option value="heading">Heading</option>
              <option value="sub-heading">Sub-heading</option>
              <option value="field">Field</option>
            </select>

            {(selectedField.elementType === 'field-label' || selectedField.elementType === 'table-block') && (
              <>
                <div style={FORM_LABEL}>MIB binding</div>
                {selectedField.mibObject ? (
                  <div style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>
                    <div>
                      <strong>{selectedField.mibObject}</strong>
                    </div>
                    <div style={{ color: 'var(--vf-text-muted)' }}>{selectedField.oid}</div>
                    <div>{selectedField.syntax}</div>
                    <div>{selectedField.units}</div>
                    <div>{selectedField.access}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button type="button" style={BTN_SECONDARY} onClick={() => unsetBinding()}>
                        Unset
                      </button>
                    </div>
                  </div>
                ) : (
                  <p style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>Click a MIB object in the palette to bind.</p>
                )}

                <label style={FORM_LABEL}>Widget</label>
                <select
                  value={selectedField.widget ?? ''}
                  onChange={(e) => patchSelectedField({ widget: e.target.value })}
                  style={{ ...SELECT_STYLE }}
                >
                  {[
                    'Text input',
                    'Text value',
                    'Slider+number',
                    'Toggle switch',
                    'Dropdown',
                    'Status badge',
                    'Gauge',
                    'Data table',
                  ].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>

                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={FORM_LABEL}>Min</label>
                    <input
                      type="number"
                      value={selectedField.minValue ?? ''}
                      onChange={(e) =>
                          patchSelectedField({ minValue: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      style={{ width: '100%', padding: 6, borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-canvas)', color: 'var(--vf-text-primary)' }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={FORM_LABEL}>Max</label>
                    <input
                      type="number"
                      value={selectedField.maxValue ?? ''}
                      onChange={(e) =>
                        patchSelectedField({ maxValue: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      style={{ width: '100%', padding: 6, borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-canvas)', color: 'var(--vf-text-primary)' }}
                    />
                  </div>
                </div>

                <label style={FORM_LABEL}>Poll interval</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                  <input
                    type="number"
                    value={selectedField.pollInterval ?? 30}
                    onChange={(e) => patchSelectedField({ pollInterval: Number(e.target.value) })}
                    style={{ flex: 1, padding: 6, borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-canvas)', color: 'var(--vf-text-primary)' }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>s</span>
                </div>

                <label style={FORM_LABEL}>Write mode</label>
                <select
                  value={selectedField.writeMode ?? 'apply-button'}
                  onChange={(e) =>
                    patchSelectedField({ writeMode: e.target.value as UiDescriptorField['writeMode'] })
                  }
                  style={{ ...SELECT_STYLE }}
                >
                  <option value="apply-button">Apply button</option>
                  <option value="direct">Direct</option>
                </select>

                <label style={FORM_LABEL}>Help text</label>
                <textarea
                  value={selectedField.helpText ?? ''}
                  onChange={(e) => patchSelectedField({ helpText: e.target.value })}
                  rows={3}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    marginBottom: 12,
                    padding: 8,
                    borderRadius: 6,
                    border: '1px solid var(--vf-border-subtle)',
                    background: 'var(--vf-canvas)',
                    color: 'var(--vf-text-primary)',
                    fontSize: 12,
                    resize: 'vertical',
                  }}
                />

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!selectedField.confirmWrite}
                    onChange={(e) => patchSelectedField({ confirmWrite: e.target.checked })}
                  />
                  Confirm before SNMP SET
                </label>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

// ── Screen 3: Preview ────────────────────────────────────────────────────────

function PreviewFieldWidget({ field }: { field: UiDescriptorField }) {
  const w = (field.widget ?? '').toLowerCase();
  if (w.includes('slider')) {
    const min = field.minValue ?? 0;
    const max = field.maxValue ?? 100;
    const mid = (min + max) / 2;
    const pct = ((mid - min) / (max - min)) * 100;
    return (
      <div>
        <input type="range" min={min} max={max} defaultValue={mid} style={{ width: '100%' }} readOnly />
        <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{mid} {field.units ?? ''} ({pct.toFixed(0)}%)</div>
      </div>
    );
  }
  if (w.includes('toggle')) {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" defaultChecked readOnly /> On
      </label>
    );
  }
  if (w.includes('gauge')) {
    return (
      <svg width="80" height="48" viewBox="0 0 80 48" aria-hidden>
        <path d="M8 40 A32 32 0 0 1 72 40" fill="none" stroke="var(--vf-border-subtle)" strokeWidth="6" />
        <path d="M8 40 A32 32 0 0 1 44 12" fill="none" stroke="var(--vf-accent)" strokeWidth="6" />
        <text x="40" y="44" textAnchor="middle" fontSize="11" fill="var(--vf-text-primary)">-58</text>
      </svg>
    );
  }
  if (w.includes('status') || w.includes('badge')) {
    return (
      <span style={{ padding: '4px 10px', borderRadius: 999, background: 'rgba(34,197,94,0.15)', color: 'var(--vf-success)', fontWeight: 700, fontSize: 12 }}>
        UP
      </span>
    );
  }
  if (w.includes('table') || field.elementType === 'table-block') {
    return (
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Index', 'MAC', 'RSSI'].map((h) => (
              <th key={h} style={{ borderBottom: '1px solid var(--vf-border-subtle)', padding: 4, textAlign: 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4].map((i) => (
            <tr key={i}>
              <td style={{ padding: 4 }}>{i}</td>
              <td style={{ padding: 4, fontFamily: 'var(--vf-font-mono)' }}>00:11:22:33:44:{50 + i}</td>
              <td style={{ padding: 4 }}>{-60 - i * 3} dBm</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <span style={{ fontSize: 13, color: 'var(--vf-text-primary)' }}>sample-string-value</span>;
}

function PreviewScreen({
  descriptor,
  onBack,
  onPublished,
}: {
  descriptor: UiDescriptorDraft | null;
  onBack: () => void;
  onPublished: (d: UiDescriptorDraft) => void;
}) {
  const { addToast } = useToast();
  const [publishing, setPublishing] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const draft    = descriptor ?? emptyDraft();
  const sections = draft.sections.filter((s) => s.order >= 0).sort((a, b) => a.order - b.order);

  // ── Statistics (req E-02, E-03) ───────────────────────────────────────────
  const allFields   = sections.flatMap((s) => s.fields);
  const bindable    = allFields.filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block');
  const bound       = bindable.filter((f) => f.oid);
  const unbound     = bindable.filter((f) => !f.oid);
  const readWrite   = bindable.filter((f) => f.access === 'read-write');
  const xmlFileName =
    (draft.screenName ?? 'screen').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.ui.xml';
  const liveXml     = generateUiXml(draft);

  // ── Pre-publish validation (req F-02, F-03) ───────────────────────────────
  const validationErrors: string[] = [];
  if (!draft.descriptorId) validationErrors.push('Draft must be saved before publishing');
  if (sections.length === 0) validationErrors.push('Add at least one section in the builder');
  if (unbound.length > 0)
    validationErrors.push(`${unbound.length} field${unbound.length > 1 ? 's' : ''} missing OID binding: ${unbound.map((f) => f.label || f.mibObject || f.fieldId).slice(0, 3).join(', ')}${unbound.length > 3 ? '…' : ''}`);
  const canPublish = validationErrors.length === 0;

  async function handlePublish() {
    if (!canPublish) { setShowValidation(true); return; }
    setPublishing(true);
    try {
      const pub = await publishDescriptor(draft.descriptorId!);
      onPublished({
        ...draft,
        status: 'published',
        generatedXml: pub.generatedXml ?? liveXml,
      });
      addToast('✓ Published to device profile', 'success');
    } catch {
      addToast('Publish failed — check gateway logs', 'error');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Top bar */}
      <div
        style={{
          padding: '9px 16px',
          background: 'rgba(245,158,11,0.12)',
          borderBottom: '1px solid rgba(245,158,11,0.3)',
          fontSize: 12,
          color: '#92400e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span>Preview mode — live SNMP GETs against a test device. Values below are sample data.</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
            onClick={onBack}
          >
            ← Back to builder
          </button>
          {/* ⬇ Export XML */}
          <button
            type="button"
            onClick={() => downloadXml(liveXml, xmlFileName)}
            style={{
              ...BTN_SECONDARY,
              fontSize: 12,
              padding: '5px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              color: 'var(--vf-text-primary)',
            }}
          >
            ⬇ Export XML
          </button>
          <button type="button" style={{ ...BTN_PRIMARY, fontSize: 12, padding: '6px 14px' }} onClick={() => void handlePublish()} disabled={publishing}>
            {publishing ? 'Publishing…' : 'Publish to device profile'}
          </button>
        </div>
      </div>

      {/* Statistics bar (req E-02, E-03) */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          background: 'var(--vf-surface)',
          borderBottom: '1px solid var(--vf-border-subtle)',
          fontSize: 12,
          flexWrap: 'wrap',
        }}
      >
        {[
          { label: 'Sections',    value: sections.length,  color: 'var(--vf-accent)' },
          { label: 'Fields',      value: bindable.length,  color: 'var(--vf-text-primary)' },
          { label: 'Bound',       value: bound.length,     color: '#16a34a' },
          { label: 'Unbound',     value: unbound.length,   color: unbound.length > 0 ? '#dc2626' : '#94a3b8' },
          { label: 'Read-write',  value: readWrite.length, color: '#2563eb' },
          { label: 'Read-only',   value: bindable.length - readWrite.length, color: '#64748b' },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            style={{
              padding: '8px 18px',
              borderRight: '1px solid var(--vf-border-subtle)',
              textAlign: 'center',
              minWidth: 80,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
            <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
          </div>
        ))}
        {/* Status badge */}
        <div style={{ padding: '8px 18px', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '3px 10px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              background: draft.status === 'published' ? 'rgba(22,163,74,0.12)' : 'rgba(245,158,11,0.12)',
              color: draft.status === 'published' ? '#15803d' : '#92400e',
            }}
          >
            {draft.status === 'published' ? '✓ Published' : '● Draft'}
          </span>
        </div>
      </div>

      {/* Pre-publish validation panel (req F-02) */}
      {showValidation && validationErrors.length > 0 && (
        <div
          style={{
            margin: '12px 24px 0',
            padding: '12px 16px',
            background: 'rgba(220,38,38,0.06)',
            border: '1px solid rgba(220,38,38,0.25)',
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>⚠ Cannot publish — fix these first:</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#b91c1c', lineHeight: 1.7 }}>
            {validationErrors.map((e) => <li key={e}>{e}</li>)}
          </ul>
          <button
            type="button"
            style={{ marginTop: 8, fontSize: 11, background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', padding: 0 }}
            onClick={() => setShowValidation(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 24, background: 'var(--vf-elevated)' }}>
        {/* Device / MIB info line */}
        {(draft.deviceProfile || draft.mibModule) && (
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginBottom: 6 }}>
            {[draft.deviceProfile, draft.mibModule].filter(Boolean).join(' · ')}
            {' · SNMP v2 · polled 12 ago'}
          </div>
        )}
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 20, marginTop: 0, color: 'var(--vf-text-primary)' }}>
          {draft.screenName}
        </h1>
        {sections.map((sec) => {
          const fields = sec.fields.filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block');
          const isWritable = sec.writeMode === 'apply-button';
          return (
            <div
              key={sec.sectionId}
              style={{
                background: 'var(--vf-surface)',
                border: '1px solid var(--vf-border-subtle)',
                borderRadius: 10,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--vf-text-primary)' }}>{sec.title}</h2>
                  <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 3 }}>
                    {isWritable ? 'Read-write objects — changes are sent as one SNMP SET' : `Read-only · polled every ${sec.pollInterval ?? 30} s`}
                  </div>
                </div>
                {isWritable && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={{ ...BTN_SECONDARY, fontSize: 12, padding: '5px 12px' }}>Revert</button>
                    <button type="button" style={{ ...BTN_PRIMARY,   fontSize: 12, padding: '5px 12px' }}>Apply (SNMP SET)</button>
                  </div>
                )}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: sec.fullWidth ? '1fr' : sec.columns === 1 ? '1fr' : '1fr 1fr',
                  gap: 16,
                  marginTop: 12,
                }}
              >
                {fields.map((f) => (
                  <div key={f.fieldId}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--vf-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {f.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', fontFamily: 'var(--vf-font-mono)', marginBottom: 6, opacity: 0.7 }}>
                      {f.mibObject}
                    </div>
                    <PreviewFieldWidget field={f} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {sections.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--vf-text-muted)', padding: 60 }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🖼️</div>
            <div style={{ fontWeight: 600 }}>No sections yet</div>
            <div style={{ fontSize: 12 }}>Add layout in the Screen Builder (Step 2).</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Screen 4: Widget rules + XML ─────────────────────────────────────────────

function XmlCodePanel({ xml }: { xml: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 16,
        fontSize: 11,
        lineHeight: 1.5,
        fontFamily: 'var(--vf-font-mono)',
        whiteSpace: 'pre-wrap',
        color: '#a5f3fc',
      }}
    >
      {xml}
    </pre>
  );
}

function WidgetRulesScreen({ descriptor }: { descriptor: UiDescriptorDraft | null }) {
  const xml      = descriptor?.generatedXml ?? generateUiXml(descriptor ?? emptyDraft()) ?? SAMPLE_UI_XML;
  const fileName =
    (descriptor?.screenName ?? 'radio_overview')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_') + '.ui.xml';
  const liveXml  = descriptor ? generateUiXml(descriptor) : xml;

  const rows: [string, string, string, string][] = [
    ['DisplayString / OCTET STRING', 'Text value', 'Text input', 'SIZE → max length'],
    ['Integer32 (range)', 'Value + units', 'Slider + number', 'range → min/max, UNITS → suffix'],
    ['INTEGER { enum }', 'Status badge', 'Dropdown', 'enum labels → options'],
    ['TruthValue', 'On/Off badge', 'Toggle switch', 'true(1) / label(2)'],
    ['Gauge32', 'Gauge / bar', '—', 'thresholds set by user'],
    ['Counter32 / Counter64', 'Rate chart (Δ/s)', '—', 'wrap handled by poller'],
    ['TimeTicks', 'Duration (d h m)', '—', '1/100 s → humanized'],
    ['IpAddress / InetAddress', 'IP text', 'IP input (validated)', 'type + length'],
    ['SEQUENCE OF Entry (table)', 'Data table', 'Editable grid', 'INDEX → key column; columns from Entry'],
  ];

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 20, borderRight: '1px solid var(--vf-border-subtle)' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginTop: 0 }}>SMI syntax → default widget</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 24 }}>
          <thead>
            <tr style={{ background: 'var(--vf-elevated)' }}>
              {['SYNTAX / TC', 'READ-ONLY', 'READ-WRITE', 'AUTO-DERIVED FROM MIB'].map((h) => (
                <th key={h} style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 10 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[0]}>
                {r.map((cell) => (
                  <td key={cell} style={{ padding: 8, borderBottom: '1px solid var(--vf-border-subtle)', verticalAlign: 'top' }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ fontSize: 14, fontWeight: 700 }}>Label hierarchy</h3>
        <ul style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--vf-text-secondary)', paddingLeft: 18 }}>
          <li>
            <strong>HEADING</strong>: Screen / tab — One per screen. Optional scope OID prefix.
          </li>
          <li>
            <strong>SUB-HEADING</strong>: Section card — Groups fields; sets columns, poll rate, one SET per Apply
          </li>
          <li>
            <strong>FIELD LABEL</strong>: Label + widget — Binds exactly one scalar or one table.
          </li>
        </ul>
      </div>

      {/* Right panel — dark code viewer (intentional dark bg for code readability) */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#0f172a' }}>
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #334155',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 14 }}>Generated UI descriptor</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
              Saved with the device profile; NMS renderer and backend poller both read this.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'var(--vf-font-mono)' }}>{fileName}</span>
            {/* ⬇ Export XML */}
            <button
              type="button"
              onClick={() => downloadXml(liveXml.trim() || SAMPLE_UI_XML, fileName)}
              style={{
                background: '#1e40af',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              ⬇ Export XML
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <XmlCodePanel xml={liveXml.trim() || SAMPLE_UI_XML} />
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function V2MibBuilderPage() {
  const [step, setStep] = useState(1);
  const [parsedMib, setParsedMib] = useState<ParseMibResult | null>(null);
  const [selectedObjects, setSelectedObjects] = useState<MibObjectSummary[]>([]);
  const [descriptor, setDescriptor] = useState<UiDescriptorDraft | null>(null);
  const [deviceProfile, setDeviceProfile] = useState<string>('');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,          /* fill the V2AppShell flex-column main area */
        overflow: 'hidden',
        minHeight: 0,     /* critical: lets flex children shrink below content height */
      }}
    >
      <StepHeader step={step} onStep={setStep} />

      {step === 1 && (
        <MibLibraryScreen
          key={descriptor?.descriptorId ?? 'fresh'}
          existingDescriptor={descriptor}
          initialParseResult={parsedMib}
          onSaved={(saved) => {
            setDescriptor(saved);
          }}
          onLoadDraft={(draft) => {
            // ── Restore full session from saved draft (req G-05: restore last saved state) ──

            setDescriptor(draft);
            setDeviceProfile(draft.deviceProfile ?? '');

            const objs = draft.selectedObjects ?? [];
            setSelectedObjects(objs);

            // Reconstruct a ParseMibResult from the stored objects so Stage 1
            // can display the object table with the saved selections already ticked.
            // The user can review/modify selections and then proceed to Stage 2.
            const restoredStats: MibStatistics = {
              totalObjects:     objs.length,
              scalarCount:      objs.filter((o) => o.indexType === 'SCALAR').length,
              singleIndexCount: objs.filter((o) => o.indexType === 'SINGLE_INDEX').length,
              doubleIndexCount: objs.filter((o) => o.indexType === 'DOUBLE_INDEX').length,
              tripleIndexCount: objs.filter((o) => o.indexType === 'TRIPLE_INDEX').length,
              enumCount:        objs.filter((o) => o.isEnum).length,
            };
            const pseudoMib: ParseMibResult = {
              moduleName:    draft.mibModule    ?? 'Loaded MIB',
              vendor:        draft.vendor        ?? '',
              productLine:   draft.productFamily ?? '',
              enterpriseOid: '',
              statistics:    restoredStats,
              objects:       objs,
              generatedXml:  draft.generatedXml ?? '',
              warnings:      [],
            };
            setParsedMib(pseudoMib);

            // Per req G-05 ("restore last saved state"): go to Stage 1 so the admin
            // can review/modify their object selections before going to the builder.
            // From Stage 1 they click "Use N selected in Builder →" to reach Stage 2.
            setStep(1);
          }}
          onDescriptorDeleted={(deletedId) => {
            // If the currently-active descriptor was deleted, clear all parent state
            if (descriptor?.descriptorId === deletedId) {
              setDescriptor(null);
              setParsedMib(null);
              setSelectedObjects([]);
            }
          }}
          onNext={(objects, mib) => {
            setSelectedObjects(objects);
            setParsedMib(mib);
            setDeviceProfile(
              mib.vendor && mib.productLine ? `${mib.vendor} - ${mib.productLine}` : mib.vendor || '',
            );
            setDescriptor((prev) =>
              prev ?? {
                ...emptyDraft(mib.moduleName),
                deviceProfile:
                  mib.vendor && mib.productLine ? `${mib.vendor} - ${mib.productLine}` : undefined,
                mibModule: mib.moduleName,
              },
            );
            setStep(2);
          }}
        />
      )}
      {step === 2 && (
        <ScreenBuilderScreen
          objects={selectedObjects}
          parsedMib={parsedMib}
          descriptor={descriptor}
          onChange={setDescriptor}
          deviceProfile={deviceProfile}
          onPreview={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <PreviewScreen
          descriptor={descriptor}
          onBack={() => setStep(2)}
          onPublished={setDescriptor}
        />
      )}
      {step === 4 && <WidgetRulesScreen descriptor={descriptor} />}
    </div>
  );
}

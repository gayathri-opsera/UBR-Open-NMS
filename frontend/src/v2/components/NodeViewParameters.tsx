/**
 * NodeViewParameters — Wireless-tab-style renderer for the definition-driven Node View
 * =================================================================================
 *
 * Renders exactly what the uploaded product definition declares, in its own hierarchy:
 *
 *   Group            → accent-underline tab          (definition group order)
 *     Sub-group      → Card with a title             (order of first appearance)
 *       Parameter    → labelled Select / Input       (definition parameter order)
 *
 * Look and behaviour follow WirelessConfigTab: tab bar with Apply on the right, `Card`s, a
 * 2-column grid, dropdowns for enumerated parameters, inputs for the rest. Nothing that is
 * not in the definition is shown.
 *
 * A parameter that the device reports once per radio / VLAN / port has several SNMP
 * instances. They stay inside that one parameter's field, one control per instance,
 * labelled by SNMP index (#1, #2, …) — no extra level is invented.
 *
 * Editing: a changed control is marked; Apply sends only the changed ones to the gateway,
 * which validates against the definition and writes to the device.
 */

import type React from 'react';
import { useMemo, useState } from 'react';

import type {
  NodeViewChange, NodeViewChangeResult, NodeViewValues, ParameterValueRecord,
  WireframeGroup, WireframeParameter,
} from '../../api/nodeView.types';
import { valueKey } from '../../api/nodeView.types';
import { applyNodeViewChanges } from '../../api/nodeView.api';

import { Badge }   from './common/Badge';
import { Button }  from './common/Button';
import { Card }    from './common/Card';
import { Input }   from './common/Input';
import { Select }  from './common/Select';
import { Spinner } from './common/Spinner';
import { useToast } from './common/Toast';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parameters without a sub-group sit in an untitled leading card. */
const NO_SUB = '\u0000none';

/** Presentation only: acronyms that appear as sub-group slugs are upper-cased. */
const ACRONYMS = new Set(['ip', 'ipv4', 'ipv6', 'vlan', 'dhcp', 'dcs', 'ddrs', 'atpc', 'mtu', 'snr', 'rtx', 'qos', 'gps', 'ofdma', 'eirp']);
function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * uiTab keywords that always imply table rendering for Monitor groups.
 * Used as fallback when the device is unreachable and no live values are loaded yet.
 */
const TABLE_TAB_KEYWORDS = [
  'link stats', 'link statistics', 'rtx', 'interface stats',
  'learn table', 'arp', 'bridge', 'ethernet stats', 'port stats', 'associated',
];

// ── Table styles (shared constants for Monitor table rendering) ───────────────
const thStyle: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600,
  color: 'var(--vf-text-secondary)', borderBottom: '1px solid var(--vf-border-subtle)',
  whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = {
  padding: '8px 12px', borderBottom: '1px solid var(--vf-border-subtle)',
  fontSize: 13, verticalAlign: 'middle',
};
const NUMERIC_TYPES = new Set(['INTEGER', 'UINT', 'FLOAT', 'GAUGE', 'COUNTER', 'TIMETICKS']);
function isNumericParam(p: WireframeParameter) {
  return NUMERIC_TYPES.has((p.dataType || '').toUpperCase());
}

// ── Sidebar structure helpers ─────────────────────────────────────────────────

/**
 * Page → Parent → [groups] hierarchy derived from uiPage/uiParent/uiTab on each group.
 * Falls back to flat rendering when no group has uiPage set.
 */
interface SidebarItem {
  parent: string;
  groups: WireframeGroup[];   // one per uiTab within this parent
}
interface SidebarPage {
  page: string;
  items: SidebarItem[];
}

/** Page order mirrors the real device left nav. */
const PAGE_ORDER = ['Wireless', 'Network', 'Management', 'Monitor'];

function buildSidebar(groups: WireframeGroup[]): SidebarPage[] {
  const withHierarchy = groups.filter((g) => g.uiPage);
  if (withHierarchy.length === 0) return [];   // flat fallback

  const pageMap = new Map<string, Map<string, WireframeGroup[]>>();

  for (const g of withHierarchy) {
    const page   = g.uiPage   || 'Wireless';
    const parent = g.uiParent || 'Settings';
    if (!pageMap.has(page))   pageMap.set(page, new Map());
    const parentMap = pageMap.get(page)!;
    if (!parentMap.has(parent)) parentMap.set(parent, []);
    parentMap.get(parent)!.push(g);
  }

  // Sort pages by canonical order, then alphabetically for unknowns
  const sortedPages = [...pageMap.keys()].sort((a, b) => {
    const ai = PAGE_ORDER.indexOf(a); const bi = PAGE_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return sortedPages.map((page) => {
    const parentMap = pageMap.get(page)!;
    const items: SidebarItem[] = [...parentMap.entries()].map(([parent, gs]) => ({
      parent,
      groups: gs.sort((a, b) => a.displayOrder - b.displayOrder),
    }));
    return { page, items };
  });
}

const editKey = (groupId: string, parameterId: string, instance: string) => `${groupId}::${parameterId}::${instance}`;

interface InstanceView {
  index: string;
  value: string | null;
  display: string | null;
}

function instancesOf(record: ParameterValueRecord | undefined): InstanceView[] {
  if (!record) return [];
  if (record.instances?.length) {
    return record.instances.map((i) => ({ index: i.index, value: i.value, display: i.display }));
  }
  return record.value != null ? [{ index: '', value: record.value, display: record.display }] : [];
}

/** Client-side check mirroring the gateway's rules, so obvious mistakes are caught before sending. */
function validate(param: WireframeParameter, value: string): string | null {
  const dt = (param.dataType || '').toUpperCase();
  const options = param.options ?? [];
  if (options.length && (dt === 'ENUM' || param.effectiveWidget === 'dropdown')) {
    return options.some((o) => o.value === value) ? null : 'Choose one of the listed values.';
  }
  if (dt === 'IPADDRESS') {
    return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value) ? null : 'Enter an IPv4 address (a.b.c.d).';
  }
  if (dt === 'INTEGER') {
    if (!/^-?\d+$/.test(value)) return 'Enter a whole number.';
    const n = Number(value);
    if (param.minValue != null && n < param.minValue) return `Must be at least ${param.minValue}.`;
    if (param.maxValue != null && n > param.maxValue) return `Must be at most ${param.maxValue}.`;
    return null;
  }
  if (param.minValue != null && value.length < param.minValue) return `Must be at least ${param.minValue} characters.`;
  if (param.maxValue != null && value.length > param.maxValue) return `Must be at most ${param.maxValue} characters.`;
  return null;
}

// ── status strip ──────────────────────────────────────────────────────────────

function StatusBar({
  deviceStatus, productDefinitionId, registryVersion, collectedAt, pollStatus, loading, refreshing, onRefresh,
}: {
  deviceStatus: string; productDefinitionId: string; registryVersion: string;
  collectedAt?: string | null; pollStatus?: string; loading: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const pollOk = pollStatus === 'OK';
  const strip = { fontSize: 11, color: 'var(--vf-text-muted)' } as const;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '8px 14px',
      background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, marginBottom: 16,
    }}>
      <span style={strip}>Status: <strong style={{ color: 'var(--vf-text-primary)' }}>{deviceStatus || '—'}</strong></span>
      <span style={{ ...strip, fontFamily: 'var(--vf-font-mono)' }}>def: {productDefinitionId}{registryVersion ? ` · rv${registryVersion}` : ''}</span>
      <span style={strip}>
        Last polled: <strong style={{ color: 'var(--vf-text-primary)' }}>{collectedAt ? new Date(collectedAt).toLocaleString() : '—'}</strong>
      </span>
      {pollStatus && (
        <span style={strip}>
          Poll: <Badge variant={pollOk ? 'success' : pollStatus === 'NOT_POLLED' ? 'default' : 'danger'}>{pollStatus}</Badge>
        </span>
      )}
      {loading && <Spinner />}
      <span style={{ marginLeft: 'auto' }}>
        <Button variant="ghost" onClick={onRefresh} loading={refreshing}>↻ Refresh</Button>
      </span>
    </div>
  );
}

// ── one control (Select or Input) ─────────────────────────────────────────────

interface ControlProps {
  id:        string;
  param:     WireframeParameter;
  /** value the device currently reports (null = none) */
  original:  string | null;
  /** shown text for a read-only enumerated value */
  edited:    string | undefined;
  editable:  boolean;
  error?:    string;
  label?:    string;
  hint?:     string;
  onChange:  (v: string) => void;
}

function Control({ id, param, original, edited, editable, error, label, hint, onChange }: ControlProps) {
  const [reveal, setReveal] = useState(false);
  const current = edited !== undefined ? edited : (original ?? '');
  const changed = edited !== undefined && edited !== (original ?? '');
  const paramOptions = param.options ?? [];
  const isEnum = paramOptions.length > 0 && ((param.dataType || '').toUpperCase() === 'ENUM' || param.effectiveWidget === 'dropdown');
  const mark = changed ? { boxShadow: '0 0 0 2px var(--vf-accent)', borderRadius: 'var(--vf-radius-md)' } : undefined;

  if (isEnum) {
    // The device may report a value the definition does not list — keep it selectable and
    // visible instead of silently showing the first option.
    const known = paramOptions.some((o) => o.value === current);
    const options = [
      ...(!known && current !== '' ? [{ value: current, label: `${current} (current)` }] : []),
      ...paramOptions.map((o) => ({ value: o.value, label: o.label === o.value ? o.label : `${o.label} (${o.value})` })),
    ];
    return (
      <div style={mark}>
        <Select
          id={id} label={label} options={options} value={current} placeholder={current === '' ? '—' : undefined}
          disabled={!editable} error={error} hint={hint} onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  const numeric = (param.dataType || '').toUpperCase() === 'INTEGER';
  return (
    <div style={{ position: 'relative', ...mark }}>
      <Input
        id={id} label={label}
        type={param.sensitive && !reveal ? 'password' : numeric ? 'number' : 'text'}
        value={current} placeholder={original == null ? '—' : undefined}
        min={numeric && param.minValue != null ? param.minValue : undefined}
        max={numeric && param.maxValue != null ? param.maxValue : undefined}
        disabled={!editable} error={error} hint={hint} autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {param.sensitive && (
        <button
          type="button" onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? 'Hide value' : 'Show value'}
          style={{ position: 'absolute', right: 10, top: label ? 30 : 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vf-text-muted)', fontSize: 12 }}
        >
          {reveal ? '🙈 Hide' : '👁 Show'}
        </button>
      )}
    </div>
  );
}

// ── one parameter (label + one control per instance) ──────────────────────────

function ParameterField({ groupId, param, record, canEdit, edits, errors, onEdit }: {
  groupId: string; param: WireframeParameter; record: ParameterValueRecord | undefined; canEdit: boolean;
  edits: Record<string, string>; errors: Record<string, string>;
  onEdit: (key: string, value: string, original: string | null) => void;
}) {
  const instances = instancesOf(record);
  const writableParam = canEdit && !param.readOnly && !!param.snmpOid;
  const title = param.unit ? `${param.displayName || param.parameterId} (${param.unit})` : (param.displayName || param.parameterId);
  const baseId = `nv-${groupId}-${param.parameterId}`;

  // No value from the device: say why, never fake one.
  if (instances.length === 0) {
    const why = record?.readStatus === 'UNMAPPED' ? 'No OID in the definition'
      : record?.readStatus === 'NO_SUCH_OBJECT' ? 'Not reported by the device'
      : record?.readStatus === 'UNREACHABLE' ? 'Device unreachable' : 'No value yet';
    return <Input id={baseId} label={title} value="" placeholder="—" disabled hint={why} readOnly />;
  }

  const stale = record && (record.freshnessState === 'STALE' || record.freshnessState === 'FAILED');
  const staleHint = stale ? (record?.failureReason || 'Value may be out of date') : undefined;

  if (instances.length === 1 && instances[0].index === '') {
    const inst = instances[0];
    const k = editKey(groupId, param.parameterId, '');
    return (
      <Control
        id={baseId} param={param} label={title} original={inst.value} edited={edits[k]} editable={writableParam}
        error={errors[k]} hint={staleHint} onChange={(v) => onEdit(k, v, inst.value)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--vf-type-caption-size)', fontWeight: 600, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em' }}>
        {title}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {instances.map((inst) => {
          const k = editKey(groupId, param.parameterId, inst.index);
          return (
            <div key={inst.index} style={{ display: 'grid', gridTemplateColumns: '34px 1fr', gap: 8, alignItems: 'start' }}>
              <span
                title={`SNMP instance ${inst.index}`}
                style={{ fontSize: 11, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-muted)', paddingTop: 9 }}
              >
                #{inst.index}
              </span>
              <Control
                id={`${baseId}-${inst.index}`} param={param} original={inst.value} edited={edits[k]}
                editable={writableParam} error={errors[k]} hint={staleHint} onChange={(v) => onEdit(k, v, inst.value)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── props ─────────────────────────────────────────────────────────────────────

interface Props {
  deviceId:            string;
  wireframe:           WireframeGroup[];
  values:              NodeViewValues;
  loading:             boolean;
  refreshing:          boolean;
  onRefresh:           () => void;
  deviceStatus:        string;
  productDefinitionId: string;
  registryVersion:     string;
  collectedAt?:        string | null;
  pollStatus?:         string;
  /** The signed-in user may change configuration (role check; the gateway enforces it too). */
  canEdit:             boolean;
  /** The gateway can write to this device (a write community is configured). */
  deviceWritable:      boolean;
}

// ── main ──────────────────────────────────────────────────────────────────────

export function NodeViewParameters({
  deviceId, wireframe, values, loading, refreshing, onRefresh, deviceStatus,
  productDefinitionId, registryVersion, collectedAt, pollStatus, canEdit, deviceWritable,
}: Props) {
  const { addToast } = useToast();
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [edits, setEdits]       = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string | null>>({});
  const [errors, setErrors]     = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set(['Wireless', 'Network']));

  const groups = useMemo(() => wireframe.filter((g) => g.parameters.some((p) => !p.hidden)), [wireframe]);
  const sidebar = useMemo(() => buildSidebar(groups), [groups]);
  const hasSidebar = sidebar.length > 0;

  // Active group — defaults to first group
  const activeGroup = groups.find((g) => g.groupId === activeGroupId) ?? groups[0];

  // All groups under the same uiParent as the active group (for tab row)
  const siblingGroups = useMemo(() => {
    if (!activeGroup?.uiPage) return groups; // flat fallback
    return groups.filter(
      (g) => g.uiPage === activeGroup.uiPage && g.uiParent === activeGroup.uiParent,
    );
  }, [activeGroup, groups]);

  const cards = useMemo(() => {
    if (!activeGroup) return [] as Array<{ key: string; title: string; params: WireframeParameter[] }>;
    const bySub = new Map<string, WireframeParameter[]>();
    for (const p of activeGroup.parameters) {
      if (p.hidden) continue;
      const k = p.subGroup ?? NO_SUB;
      bySub.set(k, [...(bySub.get(k) ?? []), p]);
    }
    const order = [NO_SUB, ...activeGroup.subGroups];
    for (const k of bySub.keys()) if (!order.includes(k)) order.push(k);
    return order.filter((k) => bySub.has(k)).map((k) => ({
      key: k, title: k === NO_SUB ? '' : humanize(k), params: bySub.get(k) ?? [],
    }));
  }, [activeGroup]);

  const groupHasWritable = !!activeGroup && activeGroup.parameters.some((p) => !p.hidden && !p.readOnly && !!p.snmpOid);
  const pending = Object.entries(edits).filter(([k, v]) => v !== (originals[k] ?? ''));
  const editingAllowed = canEdit && deviceWritable;

  const onEdit = (key: string, value: string, original: string | null) => {
    setOriginals((o) => ({ ...o, [key]: original }));
    setEdits((e) => ({ ...e, [key]: value }));
    setErrors((er) => { if (!(key in er)) return er; const { [key]: _drop, ...rest } = er; return rest; });
  };
  const reset = () => { setEdits({}); setOriginals({}); setErrors({}); };

  const paramFor = (key: string) => {
    const [groupId, parameterId, instance] = key.split('::');
    const param = wireframe.find((g) => g.groupId === groupId)?.parameters.find((p) => p.parameterId === parameterId);
    return param ? { groupId, param, instance: instance ?? '' } : null;
  };

  async function apply() {
    const nextErrors: Record<string, string> = {};
    const changes: NodeViewChange[] = [];
    for (const [key, value] of pending) {
      const hit = paramFor(key);
      if (!hit) continue;
      const msg = validate(hit.param, value);
      if (msg) nextErrors[key] = msg;
      else changes.push({ groupId: hit.groupId, parameterId: hit.param.parameterId, instance: hit.instance, value });
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || changes.length === 0) {
      if (Object.keys(nextErrors).length) addToast('Fix the highlighted fields before applying.', 'error');
      return;
    }
    setApplying(true);
    try {
      const resp = await applyNodeViewChanges(deviceId, changes);
      if (resp.error && !resp.results) { addToast(resp.error.message, 'error'); return; }
      const results: NodeViewChangeResult[] = resp.results ?? [];
      const failed = results.filter((r) => !r.ok);
      const okKeys = new Set(results.filter((r) => r.ok).map((r) => editKey(r.groupId, r.parameterId, r.instance)));
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !okKeys.has(k))));
      setOriginals((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !okKeys.has(k))));
      setErrors(Object.fromEntries(failed.map((r) => [editKey(r.groupId, r.parameterId, r.instance), r.error ?? 'Rejected'])));
      if (failed.length === 0) addToast(`Applied ${results.length} change${results.length === 1 ? '' : 's'}.`, 'success');
      else addToast(`${results.length - failed.length} applied, ${failed.length} failed.`, 'error');
      if (okKeys.size) onRefresh();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Failed to apply changes.', 'error');
    } finally {
      setApplying(false);
    }
  }

  const togglePage = (page: string) =>
    setExpandedPages((s) => { const n = new Set(s); n.has(page) ? n.delete(page) : n.add(page); return n; });

  // ── Table renderer (Monitor groups — stats rendered like the device UI) ───────

  /**
   * Determines if the active group should render as a table.
   *
   * Rules (in priority order):
   * 1. uiPage must be 'Monitor'
   * 2. Any parameter's record has isTable=true → table
   * 3. Any parameter has an instance with non-empty, non-scalar index
   *    (index !== '' AND index !== '0') → SNMP table row indexed by station/port
   * 4. No live data yet (device unreachable) but uiTab name suggests a table
   *    (e.g. "Link Stats", "RTX", "Interface Stats") → table (show empty table + note)
   */
  const isTableGroup = useMemo(() => {
    if (!activeGroup || activeGroup.uiPage !== 'Monitor') return false;

    // Check live data for table signals
    const hasTableData = activeGroup.parameters.some((p) => {
      const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
      if (!rec) return false;
      if (rec.isTable) return true;
      // Non-empty, non-scalar SNMP index (e.g. "1" for station 1 in assocTable)
      return rec.instances?.some((i) => i.index !== '' && i.index !== '0') ?? false;
    });
    if (hasTableData) return true;

    // Fallback when no values loaded: infer from tab name
    const tabLabel = (activeGroup.uiTab || activeGroup.label || '').toLowerCase();
    return TABLE_TAB_KEYWORDS.some((kw) => tabLabel.includes(kw));
  }, [activeGroup, values]);

  /**
   * Collect all unique instance indices across all parameters in the group.
   * Only collect non-empty, non-scalar indices (e.g. "1", "2" for stations).
   * Sort numerically so rows appear in natural order (1, 2, 3…).
   */
  const tableIndices = useMemo(() => {
    if (!activeGroup || !isTableGroup) return [] as string[];
    const idxSet = new Set<string>();
    for (const p of activeGroup.parameters) {
      const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
      if (!rec) continue;
      if (rec.instances?.length) {
        rec.instances
          .filter((i) => i.index !== '' && i.index !== '0')
          .forEach((i) => idxSet.add(i.index));
      }
    }
    return [...idxSet].sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
    });
  }, [activeGroup, values, isTableGroup]);

  /** Get a specific instance value from a record by station/row index. */
  const instanceValue = (rec: ParameterValueRecord | undefined, idx: string) => {
    if (!rec) return null;
    // If this parameter has indexed instances, look up the specific one
    if (rec.instances?.length) {
      const inst = rec.instances.find((i) => i.index === idx);
      if (inst) return inst.display ?? inst.value ?? null;
      // Fallback: if all instances have same value (scalar reported under table walk)
      if (rec.instances.length === 1) return rec.instances[0].display ?? rec.instances[0].value ?? null;
    }
    return rec.display ?? rec.value ?? null;
  };

  const renderTable = () => {
    if (!activeGroup) return null;
    // Separate scalar params (summaries shown above table) from tabular params
    const scalarParams = activeGroup.parameters.filter((p) => !p.hidden && (() => {
      const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
      return !rec || (!rec.isTable && (rec.instances?.length ?? 0) <= 1);
    })());
    // Params that have SNMP table instances (non-empty, non-scalar index) → table columns
    const visibleParams = activeGroup.parameters.filter((p) => !p.hidden && (() => {
      const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
      if (!rec) return false;
      if (rec.isTable) return true;
      return rec.instances?.some((i) => i.index !== '' && i.index !== '0') ?? false;
    })());
    // Fall back to all params if none are tabular (show scalar summary table)
    const tableParams = visibleParams.length > 0 ? visibleParams : activeGroup.parameters.filter(p => !p.hidden);
    const noData = tableIndices.length === 0;

    return (
      <div>
        {/* ── Scalar summary rows (Avg RTX %, system fields, etc.) ── */}
        {scalarParams.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12, marginBottom: 16,
            padding: '12px 16px',
            background: 'var(--vf-surface)',
            border: '1px solid var(--vf-border-subtle)', borderRadius: 8,
          }}>
            {scalarParams.map((p) => {
              const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
              const val = rec?.display ?? rec?.value ?? null;
              const stale = rec?.freshnessState === 'STALE' || rec?.freshnessState === 'FAILED';
              return (
                <div key={p.parameterId}>
                  <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 2 }}>{p.displayName}{p.unit ? ` (${p.unit})` : ''}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: stale ? 'var(--vf-text-muted)' : 'var(--vf-text-primary)' }}>
                    {val ?? '—'}{stale && val && <span title="Stale" style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Instance table ── */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: 13, fontFamily: 'var(--vf-font-sans)',
            background: 'var(--vf-surface)',
            border: '1px solid var(--vf-border-subtle)',
            borderRadius: 8, overflow: 'hidden',
          }}>
            {/* ── Header ── */}
            <thead>
              <tr style={{ background: 'var(--vf-surface-raised, #f8f9fa)' }}>
                <th style={thStyle}>Index</th>
                {tableParams.map((p) => (
                  <th key={p.parameterId} style={thStyle}>
                    {p.displayName}
                    {p.unit ? <span style={{ fontWeight: 400, color: 'var(--vf-text-muted)', marginLeft: 4 }}>({p.unit})</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            {/* ── Body ── */}
            <tbody>
              {noData ? (
                <tr>
                  <td colSpan={tableParams.length + 1} style={{ ...tdStyle, textAlign: 'center', color: 'var(--vf-text-muted)', padding: '24px 12px' }}>
                    No data — device unreachable or no connected stations.
                  </td>
                </tr>
              ) : tableIndices.map((idx, rowIdx) => (
                <tr key={idx} style={{ background: rowIdx % 2 === 0 ? 'transparent' : 'var(--vf-surface-subtle, rgba(0,0,0,.02))' }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--vf-text-secondary)' }}>{idx || '1'}</td>
                  {tableParams.map((p) => {
                    const rec = values[valueKey(activeGroup.groupId, p.parameterId)];
                    const val = instanceValue(rec, idx);
                    const fresh = rec?.freshnessState;
                    const stale = fresh === 'STALE' || fresh === 'FAILED';
                    return (
                      <td key={p.parameterId} style={{
                        ...tdStyle,
                        color: stale ? 'var(--vf-text-muted)' : 'var(--vf-text-primary)',
                        fontFamily: isNumericParam(p) ? 'var(--vf-font-mono, monospace)' : undefined,
                      }}>
                        {val != null ? val : <span style={{ color: 'var(--vf-text-muted)' }}>—</span>}
                        {stale && val != null && <span title="Stale data" style={{ marginLeft: 4, fontSize: 10, color: 'var(--vf-text-muted)' }}>⚠</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {tableIndices.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 6 }}>
              {tableIndices.length} entr{tableIndices.length === 1 ? 'y' : 'ies'} · polled {collectedAt ? new Date(collectedAt).toLocaleTimeString() : '—'}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Render parameter cards (shared between sidebar and flat modes) ───────────
  const renderCards = () => {
    if (isTableGroup) return renderTable();
    return (
    <>
      {canEdit && !deviceWritable && groupHasWritable && (
        <div style={{ padding: '8px 12px', marginBottom: 12, background: 'var(--vf-warning-subtle)', border: '1px solid var(--vf-warning)', borderRadius: 6, fontSize: 12, color: 'var(--vf-warning)' }}>
          Read-only — no SNMP write community is configured for this device, so changes cannot be applied.
        </div>
      )}
      {!canEdit && groupHasWritable && (
        <div style={{ padding: '8px 12px', marginBottom: 12, background: 'var(--vf-warning-subtle)', border: '1px solid var(--vf-warning)', borderRadius: 6, fontSize: 12, color: 'var(--vf-warning)' }}>
          Read-only mode — you do not have permission to modify device configuration.
        </div>
      )}
      {cards.map((c) => (
        <Card key={c.key} title={c.title || undefined} style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
            {c.params.map((p) => (
              <ParameterField
                key={p.parameterId} groupId={activeGroup!.groupId} param={p}
                record={values[valueKey(activeGroup!.groupId, p.parameterId)]}
                canEdit={editingAllowed} edits={edits} errors={errors} onEdit={onEdit}
              />
            ))}
          </div>
        </Card>
      ))}
    </>
    );
  };

  // ── Sidebar layout (uiPage/uiParent/uiTab hierarchy) ──────────────────────
  if (hasSidebar) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
        <StatusBar
          deviceStatus={deviceStatus} productDefinitionId={productDefinitionId} registryVersion={registryVersion}
          collectedAt={collectedAt} pollStatus={pollStatus} loading={loading} refreshing={refreshing} onRefresh={onRefresh}
        />
        {loading && Object.keys(values).length === 0 && (
          <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
        )}

        <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', minHeight: 400 }}>
          {/* ── LEFT SIDEBAR ────────────────────────────────────────── */}
          <nav style={{
            width: 210, flexShrink: 0,
            background: 'var(--vf-surface)',
            border: '1px solid var(--vf-border-subtle)', borderRadius: 8,
            marginRight: 16, padding: '8px 0', userSelect: 'none',
          }}>
            {sidebar.map(({ page, items }) => (
              <div key={page}>
                {/* Page header (collapsible) */}
                <button
                  onClick={() => togglePage(page)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--vf-text-secondary)', fontSize: 11, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}
                >
                  <span>{page}</span>
                  <span style={{ fontSize: 9 }}>{expandedPages.has(page) ? '▾' : '▸'}</span>
                </button>

                {expandedPages.has(page) && items.map(({ parent, groups: pGroups }) => {
                  const isParentActive = pGroups.some((g) => g.groupId === activeGroup?.groupId);
                  return (
                    <div key={parent}>
                      {/* Sub-item (parent) */}
                      <button
                        onClick={() => {
                          const first = pGroups[0];
                          if (first) setActiveGroupId(first.groupId);
                          // Auto-expand the page if collapsed
                          setExpandedPages((s) => { const n = new Set(s); n.add(page); return n; });
                        }}
                        style={{
                          width: '100%', textAlign: 'left',
                          padding: '6px 14px 6px 20px',
                          background: isParentActive ? 'var(--vf-accent-subtle, rgba(59,130,246,.1))' : 'none',
                          border: 'none', borderLeft: isParentActive ? '3px solid var(--vf-accent)' : '3px solid transparent',
                          color: isParentActive ? 'var(--vf-accent)' : 'var(--vf-text-primary)',
                          fontSize: 13, fontWeight: isParentActive ? 600 : 400,
                          cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        {parent}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* ── RIGHT CONTENT AREA ──────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Tab row for siblings (Properties / DDRS/ATPC / DFS / DCS …) */}
            {siblingGroups.length > 1 && (
              <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--vf-border-subtle)', overflowX: 'auto' }}>
                {siblingGroups.map((g) => {
                  const active = g.groupId === activeGroup?.groupId;
                  return (
                    <button
                      key={g.groupId} onClick={() => setActiveGroupId(g.groupId)}
                      style={{
                        padding: '7px 16px', background: 'none', border: 'none',
                        borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
                        color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                        fontFamily: 'var(--vf-font-sans)', fontSize: 13, fontWeight: active ? 600 : 400,
                        cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap',
                      }}
                    >
                      {g.uiTab || g.label || humanize(g.groupId)}
                    </button>
                  );
                })}
                {editingAllowed && (
                  <div style={{ marginLeft: 'auto', paddingBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {pending.length > 0 && <Button variant="ghost" size="sm" onClick={reset} disabled={applying}>Reset</Button>}
                    <Button size="sm" onClick={() => void apply()} disabled={applying || pending.length === 0} loading={applying}>
                      {pending.length > 0 ? `Apply (${pending.length})` : 'Apply'}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {/* Apply button when only one tab */}
            {siblingGroups.length <= 1 && editingAllowed && pending.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                <Button variant="ghost" size="sm" onClick={reset} disabled={applying}>Reset</Button>
                <Button size="sm" onClick={() => void apply()} disabled={applying || pending.length === 0} loading={applying}>
                  Apply ({pending.length})
                </Button>
              </div>
            )}

            {activeGroup ? renderCards() : (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>
                Select a section from the left menu.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Flat layout fallback (legacy descriptors without uiPage) ──────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16 }}>
      <StatusBar
        deviceStatus={deviceStatus} productDefinitionId={productDefinitionId} registryVersion={registryVersion}
        collectedAt={collectedAt} pollStatus={pollStatus} loading={loading} refreshing={refreshing} onRefresh={onRefresh}
      />
      {loading && Object.keys(values).length === 0 && (
        <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
      )}
      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--vf-border-subtle)', overflowX: 'auto' }}>
          {groups.map((g) => {
            const active = g.groupId === activeGroup?.groupId;
            return (
              <button key={g.groupId} onClick={() => setActiveGroupId(g.groupId)}
                style={{ padding: '8px 16px', background: 'none', border: 'none',
                  borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
                  color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                  fontFamily: 'var(--vf-font-sans)', fontSize: 13, fontWeight: active ? 600 : 400,
                  cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap' }}>
                {g.label || humanize(g.groupId)}
              </button>
            );
          })}
          {editingAllowed && (
            <div style={{ marginLeft: 'auto', paddingBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
              {pending.length > 0 && <Button variant="ghost" size="sm" onClick={reset} disabled={applying}>Reset</Button>}
              <Button size="sm" onClick={() => void apply()} disabled={applying || pending.length === 0} loading={applying}>
                {pending.length > 0 ? `Apply (${pending.length})` : 'Apply'}
              </Button>
            </div>
          )}
        </div>
      )}
      {activeGroup ? renderCards() : null}
      {groups.length === 0 && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--vf-text-muted)', fontSize: 13 }}>
          No parameters defined in this definition.
        </div>
      )}
    </div>
  );
}

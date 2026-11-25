/**
 * Device-style UI model for Custom UI Builder v2.
 * Turns a flat list of descriptor sections (each carrying an optional Page > Parent > Tab path) into the
 * navigation tree of the device web UI: Page (top menu) > Parent (sub menu) > Tab (tab row) > sections.
 */
import type { UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';

export interface DeviceTab { name: string; sections: UiDescriptorSection[]; note: string }
export interface DeviceParent { name: string; title: string; tabs: DeviceTab[] }
export interface DevicePage { name: string; parents: DeviceParent[]; direct: boolean }
export interface ActivePath { page: string; parent: string; tab: string }

export const pageOf = (s: UiDescriptorSection, screen: string) => (s.uiPage || '').trim() || screen || 'Screen';
export const parentOf = (s: UiDescriptorSection) => (s.uiParent || '').trim() || s.title || 'Section';
export const tabOf = (s: UiDescriptorSection) => (s.uiTab || '').trim() || s.title || 'Section';

export function buildDeviceTree(screen: string, sections: UiDescriptorSection[]): DevicePage[] {
  const pages: DevicePage[] = [];
  const ordered = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const s of ordered) {
    const pn = pageOf(s, screen), rn = parentOf(s), tn = tabOf(s);
    let page = pages.find((p) => p.name === pn);
    if (!page) { page = { name: pn, parents: [], direct: false }; pages.push(page); }
    let parent = page.parents.find((p) => p.name === rn);
    if (!parent) { parent = { name: rn, title: '', tabs: [] }; page.parents.push(parent); }
    if (!parent.title && s.uiTitle) parent.title = s.uiTitle;
    let tab = parent.tabs.find((t) => t.name === tn);
    if (!tab) { tab = { name: tn, sections: [], note: '' }; parent.tabs.push(tab); }
    tab.sections.push(s);
    if (s.uiNote) tab.note = tab.note ? `${tab.note}\n${s.uiNote}` : s.uiNote;
  }
  // a page with a single sub menu named like the page is a plain link in the device menu (e.g. Quick Start)
  for (const p of pages) p.direct = p.parents.length === 1 && p.parents[0].name === p.name;
  return pages;
}

export function firstPath(tree: DevicePage[]): ActivePath {
  const p = tree[0], r = p?.parents[0], t = r?.tabs[0];
  return { page: p?.name ?? '', parent: r?.name ?? '', tab: t?.name ?? '' };
}

/** Resolve a (possibly stale) path to a real one: keep what exists, fall back to the first entry. */
export function resolvePath(tree: DevicePage[], want: Partial<ActivePath>): ActivePath {
  const page = tree.find((p) => p.name === want.page) ?? tree[0];
  const parent = page?.parents.find((r) => r.name === want.parent) ?? page?.parents[0];
  const tab = parent?.tabs.find((t) => t.name === want.tab) ?? parent?.tabs[0];
  return { page: page?.name ?? '', parent: parent?.name ?? '', tab: tab?.name ?? '' };
}

export type ControlKind = 'select' | 'input' | 'checkbox' | 'text' | 'idlist';

export function controlKind(f: UiDescriptorField): ControlKind {
  if (f.valueSource === 'static' || f.valueSource === 'calc') return 'text';   // fixed / calculated values are display-only
  if (f.idList) return 'idlist';
  const w = (f.widget || '').toLowerCase();
  if (w === 'dropdown' || w === 'select') return 'select';
  if (w === 'toggle switch' || w === 'toggle' || w === 'checkbox') return 'checkbox';
  if (w.includes('input') || w.includes('slider') || w === 'textfield') return 'input';
  return 'text';
}

// ── a list of numeric ids (the VLAN trunk list: up to 100 ids, 1-4094) ────────

/** "10 20,30" (the device shows the list space separated) → ['10','20','30']; '-NA-' / empty → []. */
export function parseIdList(raw: string | null | undefined): string[] {
  return String(raw ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map((x) => String(parseInt(x, 10)));
}
export const formatIdList = (ids: string[]): string => ids.join(' ');

/** Why this list cannot be applied (null = fine): each id a whole number in range, no duplicates, at most `max` ids. */
export function checkIdList(ids: string[], cfg: { max: number; minId: number; maxId: number }): string | null {
  const bad = ids.find((x) => !/^\d+$/.test(x) || +x < cfg.minId || +x > cfg.maxId);
  if (bad !== undefined) return `VLAN ID ${bad} must be a whole number from ${cfg.minId} to ${cfg.maxId}.`;
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup !== undefined) return `VLAN ID ${dup} is already in the list.`;
  if (ids.length > cfg.max) return `At most ${cfg.max} VLAN IDs are allowed (the list has ${ids.length}).`;
  return null;
}

/** What to send to turn `before` into `after`: the device adds / deletes ONE id per SET, so the changes are sets of single ids. */
export function diffIdList(before: string[], after: string[]): { remove: string[]; add: string[] } {
  return { remove: before.filter((x) => !after.includes(x)), add: after.filter((x) => !before.includes(x)) };
}

/**
 * The SNMP changes that turn the device's id list `before` into `after`: one delete per removed id, then one add per new id
 * (the device handles one id per SET). `error` when the new list is not acceptable — nothing is sent then.
 */
export function planIdListChanges(
  groupId: string, parameterId: string, instance: string,
  cfg: { deleteParam: string; max: number; minId: number; maxId: number }, before: string[], after: string[],
): { error: string | null; changes: { groupId: string; parameterId: string; instance: string; value: string }[] } {
  const error = checkIdList(after, cfg);
  if (error) return { error, changes: [] };
  const { remove, add } = diffIdList(before, after);
  return { error: null, changes: [
    ...remove.map((value) => ({ groupId, parameterId: cfg.deleteParam, instance, value })),
    ...add.map((value) => ({ groupId, parameterId, instance, value })),
  ] };
}

export function enumOptions(f: UiDescriptorField): { value: string; label: string }[] {
  return Object.entries(f.enumMap || {})
    .filter(([k]) => k !== 'columns')
    .map(([value, label]) => ({ value, label: String(label) }));
}

/** "36( 5180 MHz ),37( 5185 MHz )" (a device's own option list) → dropdown options; "36" is the stored value, "36 ( 5180 MHz )" the label. */
export function parseOptionList(raw: string | null | undefined): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const m = /^\s*([^\s(:]+)\s*(?:\(([^)]*)\)|:\s*(.*))?\s*$/.exec(part);
    if (!m) continue;
    const extra = (m[2] ?? m[3] ?? '').trim();
    out.push({ value: m[1], label: extra ? (m[2] !== undefined ? `${m[1]} ( ${extra} )` : extra) : m[1] });
  }
  return out;
}

/**
 * Options of a field whose list follows other fields (`optionsBy`): the table entry for the parents' CURRENT values
 * (pending edit, else the device's value) — Country, Bandwidth → Channel list. null while that combination has no entry.
 */
export function optionsByList(f: UiDescriptorField, valueOf: (fieldId: string) => string): { value: string; label: string }[] | null {
  const by = f.optionsBy;
  if (!by) return null;
  // a parent the device has not answered yet (or never will) counts as its default — Country: India
  const raw = by.table[by.dependsOn.map((id) => valueOf(id) || by.defaults?.[id] || '').join('|')];
  if (raw == null) return null;
  const list = parseOptionList(raw);
  return list.length ? list : null;
}

/**
 * A parent field changed to `value`: which dependent fields must change too (the device resets Channel to Auto when Bandwidth
 * changes; a Bandwidth the new Country does not offer falls back). Follows the chain Country → Bandwidth → Channel.
 */
export function cascadeOptionResets(sec: UiDescriptorSection, changedId: string, value: string, valueOf: (fieldId: string) => string, others: UiDescriptorSection[] = []): { fieldId: string; value: string; sectionId: string }[] {
  const overlay: Record<string, string> = { [changedId]: value };
  const get = (id: string) => (id in overlay ? overlay[id] : valueOf(id));   // (optionsByList applies the defaults)
  const out: { fieldId: string; value: string; sectionId: string }[] = [];
  const all = [sec, ...others.filter((o) => o.sectionId !== sec.sectionId)];   // a dependent may sit in another section (VLAN Mode ← Radio Mode)
  const queue = [changedId];
  const seen = new Set<string>();
  while (queue.length) {
    const parent = queue.shift() as string;
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const [gs, g] of all.flatMap((x) => x.fields.map((y) => [x, y] as const))) {
      const by = g.optionsBy;
      if (!by || !by.dependsOn.includes(parent) || g.fieldId === changedId) continue;
      const list = optionsByList(g, get);
      const cur = get(g.fieldId);
      const own = enumOptions(g).map((o) => o.value).filter((v) => !/^\d+$/.test(v));
      const valid = !!list && (list.some((o) => o.value === cur) || own.includes(cur));
      if (!by.resetOnChange && (valid || !list)) continue;
      const next = by.resetTo ?? list?.[0]?.value ?? cur;
      if (next === cur && !by.resetOnChange) continue;
      if (g.fieldId in overlay && overlay[g.fieldId] === next) continue;   // already reset by another parent
      overlay[g.fieldId] = next;
      out.push({ fieldId: g.fieldId, value: next, sectionId: gs.sectionId });
      queue.push(g.fieldId);
    }
  }
  return out;
}

export const isBindable = (f: UiDescriptorField) => f.elementType === 'field-label' || f.elementType === 'table-block';

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

// ── runtime visibility: "hide when empty" and radio-column matrices ──────────────────────────────────────────────

export interface CellSource {
  /** text of one table instance (row index) of a field, or null when the device returned nothing for it */
  rows: (sectionId: string, f: UiDescriptorField) => { index: string; text: string }[];
  /** text of a single value (static / calculated / scalar), or null */
  display: (sectionId: string, f: UiDescriptorField) => string | null;
  /** raw value of a single field (used by "show when" rules), or null */
  rawValue?: (sectionId: string, f: UiDescriptorField) => string | null;
  /** the user's pending (unsaved) value of a field, if any — "show when" rules follow it, like the device UI that reacts as you pick */
  edited?: (sectionId: string, f: UiDescriptorField) => string | undefined;
  /** has this section been read from the device yet? (false = unknown, so "hide when empty" must not judge it) */
  sectionRead?: (sectionId: string) => boolean;
}

const has = (t: string | null | undefined) => t != null && t !== '';

/** Text of one matrix cell (field × column index), or null when the device returned nothing for that radio. */
export function matrixCell(src: CellSource, sectionId: string, f: UiDescriptorField, index: string): string | null {
  const r = src.rows(sectionId, f).find((x) => x.index === index);
  return r && has(r.text) ? r.text : null;
}

/** Columns of a matrix section that are shown: all of them, or — when hideEmptyColumns (default) — those with data. */
export function visibleMatrixColumns(sec: UiDescriptorSection, src: CellSource | null): { index: string; label: string; map?: Record<string, string> }[] {
  const cols = sec.uiMatrix?.columns ?? [];
  if (!src || sec.uiMatrix?.hideEmptyColumns === false) return cols;
  const fields = sec.fields.filter(isBindable);
  return cols.filter((c) => fields.some((f) => matrixCell(src, sec.sectionId, f, c.index) != null));
}

/**
 * Is a row of a live screen visible? A row marked "hide when empty" goes while the device has no value for it; a row with
 * "show when" rules goes while a sibling field holds a value that does not satisfy them (the device UI shows rows by radio mode,
 * DDRS state…). A sibling whose value is unknown never hides anything — nothing flickers away while values load.
 */
export function rowVisible(sec: UiDescriptorSection, f: UiDescriptorField, src: CellSource): boolean {
  if (f.uiHidden) return false;
  if (f.uiHideWhenEmpty && !has(src.display(sec.sectionId, f)) && !has(src.rawValue?.(sec.sectionId, f))) return false;
  for (const c of f.uiShowWhen ?? []) {
    const sib = sec.fields.find((x) => x.fieldId === c.field);
    const v = sib ? (src.edited?.(sec.sectionId, sib) ?? src.rawValue?.(sec.sectionId, sib)) : null;
    if (!has(v)) { if (c.required) return false; continue; }   // required: a sibling with no value (a radio the unit does not have) hides the row
    if (c.in && !c.in.includes(String(v))) return false;
    if (c.notIn && c.notIn.includes(String(v))) return false;
  }
  return true;
}

/** Does the device return any data for this section? (rows hidden by their rules do not count) */
export function sectionHasData(sec: UiDescriptorSection, src: CellSource): boolean {
  // fixed text (Key ********) is not something the device returned, so it never makes a section "non-empty"
  const fields = sec.fields.filter((f) => isBindable(f) && f.valueSource !== 'static' && rowVisible(sec, f, src));
  if (sec.uiLayout === 'matrix') return visibleMatrixColumns({ ...sec, uiMatrix: { ...(sec.uiMatrix ?? { columns: [] }), hideEmptyColumns: true } }, src).length > 0;
  return fields.some((f) => has(src.display(sec.sectionId, f)) || src.rows(sec.sectionId, f).some((r) => has(r.text)));
}

/**
 * Sections to show at runtime. A section marked "hide when empty" is dropped when the device has no data for it — once
 * the first reading is in (`ready`), so nothing flickers away while values are still loading. A tab, menu item or menu
 * section whose sections were all dropped disappears with them (the tree is built from what is left).
 */
export function visibleSections(sections: UiDescriptorSection[], src: CellSource | null, ready: boolean): UiDescriptorSection[] {
  if (!src || !ready) return sections;
  // a section never read yet is unknown, not empty: it stays so it can be opened and read, and goes if it then proves empty
  return sections.filter((s) => !(s.uiHideWhenEmpty && src.sectionRead?.(s.sectionId) !== false && !sectionHasData(s, src)));
}

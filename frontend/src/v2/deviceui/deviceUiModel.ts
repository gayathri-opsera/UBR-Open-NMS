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

export type ControlKind = 'select' | 'input' | 'checkbox' | 'text';

export function controlKind(f: UiDescriptorField): ControlKind {
  if (f.valueSource === 'static' || f.valueSource === 'calc') return 'text';   // fixed / calculated values are display-only
  const w = (f.widget || '').toLowerCase();
  if (w === 'dropdown' || w === 'select') return 'select';
  if (w === 'toggle switch' || w === 'toggle' || w === 'checkbox') return 'checkbox';
  if (w.includes('input') || w.includes('slider') || w === 'textfield') return 'input';
  return 'text';
}

export function enumOptions(f: UiDescriptorField): { value: string; label: string }[] {
  return Object.entries(f.enumMap || {})
    .filter(([k]) => k !== 'columns')
    .map(([value, label]) => ({ value, label: String(label) }));
}

export const isBindable = (f: UiDescriptorField) => f.elementType === 'field-label' || f.elementType === 'table-block';

export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

// ── runtime visibility: "hide when empty" and radio-column matrices ──────────────────────────────────────────────

export interface CellSource {
  /** text of one table instance (row index) of a field, or null when the device returned nothing for it */
  rows: (sectionId: string, f: UiDescriptorField) => { index: string; text: string }[];
  /** text of a single value (static / calculated / scalar), or null */
  display: (sectionId: string, f: UiDescriptorField) => string | null;
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

/** Does the device return any data for this section? */
export function sectionHasData(sec: UiDescriptorSection, src: CellSource): boolean {
  const fields = sec.fields.filter(isBindable);
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
  return sections.filter((s) => !(s.uiHideWhenEmpty && !sectionHasData(s, src)));
}

/**
 * DeviceUiView — renders descriptor sections exactly like the device's own web UI
 * (header bar, left menu, page title, tab row, label-left form rows, note, Save button, summary cards, stats tables).
 * Presentational: used by Custom UI Builder v2 as the live design preview (design=true) and reusable for a runtime view.
 */
import React, { useEffect, useMemo, useState } from 'react';
import './deviceUi.css';
import type { DeviceUiConfig, ResolvedHeader, UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import { hasSource } from './headerPreview';
import type { ActivePath } from './deviceUiModel';
import StatsCharts, { type HistoryFetcher, type LiveFetcher } from './StatsCharts';
import { buildDeviceTree, cascadeOptionResets, checkIdList, formatIdList, parseIdList, controlKind, optionsByList, enumOptions, isBindable, matrixCell, parseOptionList, resolvePath, rowVisible, visibleMatrixColumns, visibleSections } from './deviceUiModel';

const Svg: React.FC<{ d: string; className?: string; vb?: string }> = ({ d, className, vb = '0 0 24 24' }) => (
  <svg className={className} viewBox={vb} aria-hidden="true"><path d={d} /></svg>
);
const ICON: Record<string, string> = {
  grid: 'M3 3h5v5H3zM10 3h5v5h-5zM17 3h4v5h-4zM3 10h5v5H3zM10 10h5v5h-5zM17 10h4v5h-4zM3 17h5v4H3zM10 17h5v4h-5zM17 17h4v4h-4z',
  wifi: 'M12 18.5a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM4.9 13.4l1.8 1.9a7.4 7.4 0 0110.6 0l1.8-1.9a10 10 0 00-14.2 0zM1 9.3l1.8 1.9a12.9 12.9 0 0118.4 0L23 9.3a15.5 15.5 0 00-22 0z',
  chart: 'M3 20h18v2H3zM4 11h3v8H4zM9 5h3v14H9zM14 9h3v10h-3zM19 13h2v6h-2z',
  retweet: 'M7 7h10v3l4-4-4-4v3H5v6h2zM17 17H7v-3l-4 4 4 4v-3h12v-6h-2z',
  desktop: 'M3 4h18v12H3zM5 6v8h14V6zM8 18h8v2H8z',
  right: 'M8 4l8 8-8 8-2-2 6-6-6-6z',
  down: 'M4 8l8 8 8-8-2-2-6 6-6-6z',
  home: 'M12 3L2 12h3v8h5v-5h4v5h5v-8h3z',
  save: 'M4 3h13l3 3v15H4zM7 3v6h9V3zM7 13h10v7H7z',
  power: 'M11 2h2v10h-2zM6.3 5.6l1.4 1.4a7 7 0 108.6 0l1.4-1.4A9 9 0 116.3 5.6z',
  out: 'M10 4h8a2 2 0 012 2v12a2 2 0 01-2 2h-8v-2h8V6h-8zM3 11h9V8l5 4-5 4v-3H3z',
};
const TOP_ICON = (name: string, i: number) => {
  const n = name.toLowerCase();
  if (n.includes('quick')) return ICON.grid;
  if (n.includes('wireless')) return ICON.wifi;
  if (n.includes('network')) return ICON.chart;
  if (n.includes('manage')) return ICON.retweet;
  if (n.includes('monitor')) return ICON.desktop;
  return [ICON.grid, ICON.wifi, ICON.chart, ICON.retweet, ICON.desktop][i % 5];
};

/** Inline-edit / structure handlers supplied by Builder v2 (omit for a read-only view). */
export interface DeviceUiEdit {
  header: (patch: Partial<DeviceUiConfig>) => void;
  renamePage: (page: string, to: string) => void;
  renameParent: (page: string, parent: string, to: string) => void;
  renameTab: (page: string, parent: string, tab: string, to: string) => void;
  setParentTitle: (page: string, parent: string, v: string) => void;
  setTabNote: (page: string, parent: string, tab: string, v: string) => void;
  setSectionTitle: (sectionId: string, v: string) => void;
  patchSection: (sectionId: string, patch: Partial<UiDescriptorSection>) => void;
  setFieldLabel: (sectionId: string, fieldId: string, v: string) => void;
  setFieldHint: (sectionId: string, fieldId: string, v: string) => void;
  addPage: () => void;
  addParent: (page: string) => void;
  addTab: (page: string, parent: string) => void;
  addSection: (page: string, parent: string, tab: string) => void;
  /** drag & drop: a MIB object dropped on the screen (target decides where) */
  dropObject: (name: string, target: { sectionId?: string; page?: string; parent?: string; tab?: string; fieldId?: string; position?: 'before' | 'after' }) => void;
  /** drag & drop: a field dragged to another place (same or another section) */
  moveField: (from: { sectionId: string; fieldId: string }, target: { sectionId: string; fieldId?: string; position?: 'before' | 'after' }) => void;
  /** drag & drop: a menu section / menu item / tab dragged before or after a sibling */
  moveNode: (level: 'page' | 'parent' | 'tab', from: ActivePath, to: ActivePath, position: 'before' | 'after') => void;
  move: (level: 'page' | 'parent' | 'tab', page: string, parent: string, tab: string, dir: -1 | 1) => void;
  remove: (level: 'page' | 'parent' | 'tab', page: string, parent: string, tab: string) => void;
}

/** Text that turns into an input on double-click when editing is enabled. */
const Ed: React.FC<{
  value: string; onCommit?: (v: string) => void; placeholder?: string; multiline?: boolean;
  className?: string; children?: React.ReactNode;
}> = ({ value, onCommit, placeholder, multiline, className, children }) => {
  const [on, setOn] = useState(false);
  const [txt, setTxt] = useState(value);
  if (!onCommit) return <>{children ?? value}</>;
  const done = (commit: boolean) => { setOn(false); if (commit && txt !== value) onCommit(txt); };
  if (on) {
    const common = {
      className: 'dv-ed-input', value: txt, autoFocus: true,
      onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(),
      onBlur: () => done(true),
    };
    return multiline
      ? <textarea {...common} onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true); }} />
      : <input {...common} onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); }} />;
  }
  const shown = children ?? value;            // a bound / computed value passed as children wins over the empty typed text
  const empty = !shown;
  return (
    <span className={`dv-ed ${empty ? 'dv-ed-empty' : ''} ${className ?? ''}`} title="Double-click to edit"
      onDoubleClick={(e) => { e.stopPropagation(); setTxt(value); setOn(true); }}>
      {empty ? (placeholder ?? 'edit') : shown}
    </span>
  );
};

/** Live binding for the Node View (runtime) — values from the device, edits, and Save. Absent in the builder preview. */
export interface DeviceUiRuntime {
  /** the user may edit and the gateway can write to this device */
  canEdit: boolean;
  rawValue: (sectionId: string, f: UiDescriptorField) => string | null;
  display: (sectionId: string, f: UiDescriptorField) => string | null;
  /** table columns: one entry per row index the device returned */
  rows: (sectionId: string, f: UiDescriptorField) => { index: string; text: string }[];
  edited: (sectionId: string, f: UiDescriptorField) => string | undefined;
  onEdit: (sectionId: string, f: UiDescriptorField, value: string) => void;
  error: (sectionId: string, f: UiDescriptorField) => string | undefined;
  stale: (sectionId: string, f: UiDescriptorField) => boolean;
  pending: (sectionIds: string[]) => number;
  applying: boolean;
  onApply: (sectionIds: string[]) => void;
  onRevert: (sectionIds: string[]) => void;
  /** header items bound to a field of the screen */
  byField: (fieldId: string) => string | null;
  /** the first device reading is in — "hide when empty" only applies after that, so nothing flickers away while loading */
  ready: boolean;
  /** has this section's page been read from the device yet? ("hide when empty" never judges an unread section) */
  sectionRead?: (sectionId: string) => boolean;
  /** history of a chart group (Monitor > Graphs); absent = the charts show a preview note */
  history?: HistoryFetcher;
  /** live stream of a radio's chart metrics */
  liveStats?: LiveFetcher;
}

export interface DeviceUiViewProps {
  screenName: string;
  sections: UiDescriptorSection[];
  deviceUi?: DeviceUiConfig | null;
  active: ActivePath;
  onActiveChange: (p: ActivePath) => void;
  design?: boolean;
  selectedFieldId?: string;
  selectedSectionId?: string;
  onSelectField?: (sectionId: string, fieldId: string) => void;
  onSelectSection?: (sectionId: string) => void;
  /** current values keyed by fieldId (optional; design mode shows placeholders) */
  values?: Record<string, string>;
  /** inline editing + structure controls (design mode) */
  edit?: DeviceUiEdit;
  /** live device values + editing (Node View) */
  runtime?: DeviceUiRuntime;
  /** header bar values: resolved from the device (Node View) or from the sample inputs (builder preview); absent = typed text */
  header?: ResolvedHeader | null;
}

/** A list of numeric ids (the VLAN trunk list): chips with ✕, one box to add ids; edits are pending until Apply. */
function IdListEditor({ ids, cfg, editable, changed, unread, onChange }: {
  ids: string[]; cfg: { max: number; minId: number; maxId: number }; editable: boolean; changed: boolean; unread?: boolean; onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState('');
  const add = () => {
    const incoming = parseIdList(draft);
    if (!incoming.length) { setMsg(draft.trim() ? 'Enter whole numbers, e.g. 10 or 10 20 30.' : ''); return; }
    const next = [...ids, ...incoming];
    const why = checkIdList(next, cfg);
    if (why) { setMsg(why); return; }
    setMsg(''); setDraft(''); onChange(next);
  };
  return (
    <div className={`dv-idlist ${changed ? 'dv-changed' : ''}`}>
      <div className="dv-idlist-chips" aria-label="VLAN IDs">
        {ids.length === 0 && <span className="dv-hint">{unread ? 'The device did not report its current list — IDs you add are appended to it' : 'No VLAN IDs in the list'}</span>}
        {ids.map((id) => (
          <span key={id} className="dv-chip">{id}{editable && <b title={`Remove ${id}`} role="button" aria-label={`Remove ${id}`} onClick={() => { setMsg(''); onChange(ids.filter((x) => x !== id)); }}>✕</b>}</span>
        ))}
      </div>
      {editable && (
        <div className="dv-idlist-add">
          <input className="dv-input" type="text" value={draft} placeholder={`VLAN ID (${cfg.minId} - ${cfg.maxId})`} aria-label="Add VLAN ID"
            onChange={(e) => { setDraft(e.target.value); setMsg(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} disabled={ids.length >= cfg.max} />
          <button type="button" className="dv-idlist-btn" onClick={add} disabled={ids.length >= cfg.max}>Add</button>
        </div>
      )}
      <span className="dv-hint">{ids.length} / {cfg.max} entries</span>
      {msg && <div className="dv-err">{msg}</div>}
    </div>
  );
}

const fieldTitle = (f: UiDescriptorField) => f.label || f.mibObject || f.fieldId;

export const DeviceUiView: React.FC<DeviceUiViewProps> = ({
  screenName, sections, deviceUi, active, onActiveChange, design, selectedFieldId, selectedSectionId,
  onSelectField, onSelectSection, values, edit, runtime, header,
}) => {
  // Node View: sections marked "hide when empty" drop out when the device has no data for them (a tab, menu item or menu
  // section left with nothing disappears with them).
  const viewSections = runtime ? visibleSections(sections, runtime, runtime.ready) : sections;
  const tree = buildDeviceTree(screenName, viewSections);
  const path = resolvePath(tree, active);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { setOpen((o) => ({ ...o, [path.page]: true })); }, [path.page]);

  const page = tree.find((p) => p.name === path.page);
  const parent = page?.parents.find((r) => r.name === path.parent);
  const tab = parent?.tabs.find((t) => t.name === path.tab);
  const hd = deviceUi || {};
  const radios = hd.radios ?? [];
  const ed = design ? edit : undefined;

  const pick = (p: Partial<ActivePath>) => onActiveChange(resolvePath(tree, { ...path, ...p }));
  const setRadio = (i: number, patch: Partial<NonNullable<DeviceUiConfig['radios']>[number]>) =>
    ed?.header({ radios: radios.map((r, k) => (k === i ? { ...r, ...patch } : r)) });

  // ── drag & drop (design mode) ──────────────────────────────────────────────
  type Payload =
    | { type: 'mib-object'; name: string }
    | { type: 'dv-field'; sectionId: string; fieldId: string }
    | { type: 'dv-node'; level: 'page' | 'parent' | 'tab'; page: string; parent: string; tab: string };
  const [hint, setHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);
  const readPayload = (e: React.DragEvent): Payload | null => { try { return JSON.parse(e.dataTransfer.getData('text/plain')) as Payload; } catch { return null; } };
  const hintClass = (id: string) => (hint?.id === id ? (hint.pos === 'before' ? 'dv-drop-before' : 'dv-drop-after') : '');
  const dragSrc = (payload: Payload) => (ed ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', JSON.stringify(payload)); e.dataTransfer.effectAllowed = 'copyMove'; },
    onDragEnd: () => setHint(null),
  } : {});
  const sideOf = (e: React.DragEvent, axis: 'x' | 'y'): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return (axis === 'y' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2) ? 'before' : 'after';
  };
  /** drop target for one field (row, card row, table column, heading, divider) */
  const fieldDrop = (sec: UiDescriptorSection, f: UiDescriptorField, axis: 'x' | 'y' = 'y') => (ed ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); const pos = sideOf(e, axis); setHint((h) => (h?.id === f.fieldId && h.pos === pos ? h : { id: f.fieldId, pos })); },
    onDragLeave: () => setHint((h) => (h?.id === f.fieldId ? null : h)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      const pl = readPayload(e); const pos = hint?.id === f.fieldId ? hint.pos : sideOf(e, axis); setHint(null);
      if (!pl) return;
      if (pl.type === 'mib-object') ed.dropObject(pl.name, { sectionId: sec.sectionId, fieldId: f.fieldId, position: pos });
      else if (pl.type === 'dv-field') ed.moveField({ sectionId: pl.sectionId, fieldId: pl.fieldId }, { sectionId: sec.sectionId, fieldId: f.fieldId, position: pos });
    },
  } : {});
  /** drop target for a whole section: append */
  const sectionDrop = (sec: UiDescriptorSection) => (ed ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation(); setHint(null);
      const pl = readPayload(e); if (!pl) return;
      if (pl.type === 'mib-object') ed.dropObject(pl.name, { sectionId: sec.sectionId });
      else if (pl.type === 'dv-field') ed.moveField({ sectionId: pl.sectionId, fieldId: pl.fieldId }, { sectionId: sec.sectionId });
    },
  } : {});
  const firstSectionOf = (level: 'page' | 'parent' | 'tab', to: ActivePath): UiDescriptorSection | undefined => {
    const pg = tree.find((x) => x.name === to.page);
    const pr = level === 'page' ? pg?.parents[0] : pg?.parents.find((x) => x.name === to.parent);
    const tb = level === 'tab' ? pr?.tabs.find((x) => x.name === to.tab) : pr?.tabs[0];
    return tb?.sections[0];
  };
  /** drag source + drop target for a menu section / menu item / tab */
  const nodeDnd = (level: 'page' | 'parent' | 'tab', node: ActivePath) => {
    if (!ed) return {};
    const id = `n:${level}:${node.page}|${node.parent}|${node.tab}`;
    return {
      ...dragSrc({ type: 'dv-node', level, ...node }),
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); const pos = sideOf(e, level === 'tab' ? 'x' : 'y'); setHint((h) => (h?.id === id && h.pos === pos ? h : { id, pos })); },
      onDragLeave: () => setHint((h) => (h?.id === id ? null : h)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation();
        const pl = readPayload(e); const pos = hint?.id === id ? hint.pos : sideOf(e, level === 'tab' ? 'x' : 'y'); setHint(null);
        if (!pl) return;
        const target = firstSectionOf(level, node);
        if (pl.type === 'dv-node') { if (pl.level === level) ed.moveNode(level, { page: pl.page, parent: pl.parent, tab: pl.tab }, node, pos); }
        else if (!target) return;
        else if (pl.type === 'dv-field') ed.moveField({ sectionId: pl.sectionId, fieldId: pl.fieldId }, { sectionId: target.sectionId });
        else if (pl.type === 'mib-object') ed.dropObject(pl.name, { sectionId: target.sectionId });
      },
      __id: id,
    };
  };
  const nodeProps = (level: 'page' | 'parent' | 'tab', node: ActivePath) => { const { __id, ...rest } = nodeDnd(level, node) as Record<string, unknown>; void __id; return { rest, cls: hintClass(`n:${level}:${node.page}|${node.parent}|${node.tab}`) }; };

  const Ctl: React.FC<{ level: 'page' | 'parent' | 'tab'; pg: string; pr?: string; tb?: string }> = ({ level, pg, pr = '', tb = '' }) => (
    !ed ? null : (
      <span className="dv-ctl" onClick={(e) => e.stopPropagation()}>
        <b title="Move up / left" onClick={() => ed.move(level, pg, pr, tb, -1)}>↑</b>
        <b title="Move down / right" onClick={() => ed.move(level, pg, pr, tb, 1)}>↓</b>
        <b className="del" title="Delete (with its sections)" onClick={() => ed.remove(level, pg, pr, tb)}>✕</b>
      </span>
    )
  );

  const renderControl = (f: UiDescriptorField, sec: UiDescriptorSection) => {
    const kind = controlKind(f);
    const val = values?.[f.fieldId];
    const hint = f.helpText || (f.units ? `(${f.units})` : '');
    const hintEl = ed
      ? <span className="dv-hint"><Ed value={f.helpText ?? ''} placeholder="+ hint" onCommit={(v) => ed.setFieldHint(sec.sectionId, f.fieldId, v)}>{hint}</Ed></span>
      : (hint ? <span className="dv-hint">{hint}</span> : null);

    if (runtime) {
      const writable = runtime.canEdit && f.access === 'read-write' && f.valueSource !== 'static' && f.valueSource !== 'calc';
      const cur = runtime.edited(sec.sectionId, f) ?? runtime.rawValue(sec.sectionId, f) ?? '';
      const err = runtime.error(sec.sectionId, f);
      const errEl = err ? <div className="dv-err">{err}</div> : null;
      const changed = runtime.edited(sec.sectionId, f) !== undefined;
      if (kind === 'idlist' && f.idList) {
        const raw = runtime.rawValue(sec.sectionId, f);
        const e0 = runtime.edited(sec.sectionId, f);
        const ids = parseIdList(e0 ?? raw);
        const cfg = f.idList;
        return (<>
          <IdListEditor ids={ids} cfg={cfg} editable={writable} changed={changed} unread={raw == null || /^-?NA-?$/i.test(String(raw).trim())}
            onChange={(next) => runtime.onEdit(sec.sectionId, f, formatIdList(next) === formatIdList(parseIdList(raw)) ? (raw ?? '') : formatIdList(next))} />
          {hintEl}{errEl}
        </>);
      }
      if (kind === 'select') {
        const sib = f.optionsFrom ? sec.fields.find((x) => x.fieldId === f.optionsFrom) : undefined;
        // a parent may sit in another section of the screen (VLAN Mode follows the Radio Mode on the Wireless page)
        const valueOf = (id: string) => {
          for (const s of [sec, ...sections]) {
            const p = s.fields.find((x) => x.fieldId === id);
            if (p) return runtime.edited(s.sectionId, p) ?? runtime.rawValue(s.sectionId, p) ?? '';
          }
          return '';
        };
        // options that follow other fields' current (even unsaved) values win over the device's own current list
        const fromDevice = optionsByList(f, valueOf) ?? (sib ? parseOptionList(runtime.rawValue(sec.sectionId, sib)) : []);
        const own = enumOptions(f);
        // the device's own list wins; the fixed values stay as labels for entries it does not spell out (Auto) and as the fallback
        const opts = fromDevice.length ? [...own.filter((o) => !fromDevice.some((d) => d.value === o.value) && !/^\d+$/.test(o.value)), ...fromDevice] : own;
        const has = opts.some((o) => o.value === cur);
        return (<>
          <select className={`dv-select ${changed ? 'dv-changed' : ''}`} value={cur} disabled={!writable}
            onChange={(e) => {
              runtime.onEdit(sec.sectionId, f, e.target.value);
              for (const r of cascadeOptionResets(sec, f.fieldId, e.target.value, valueOf, sections)) {
                const gs = r.sectionId === sec.sectionId ? sec : sections.find((x) => x.sectionId === r.sectionId);
                const g = gs?.fields.find((x) => x.fieldId === r.fieldId);
                if (gs && g) runtime.onEdit(gs.sectionId, g, r.value);
              }
            }}>
            {!has && <option value={cur}>{cur === '' ? '—' : cur}</option>}
            {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {hintEl}{errEl}
        </>);
      }
      if (kind === 'checkbox') {
        return <input type="checkbox" checked={cur === '1' || cur === 'true'} disabled={!writable}
          onChange={(e) => runtime.onEdit(sec.sectionId, f, e.target.checked ? '1' : '2')} />;
      }
      if (kind === 'input') {
        return (<>
          <input className={`dv-input ${changed ? 'dv-changed' : ''}`} type="text" value={cur} disabled={!writable}
            onChange={(e) => runtime.onEdit(sec.sectionId, f, e.target.value)} />
          {hintEl}{errEl}
        </>);
      }
      const shown = runtime.display(sec.sectionId, f);
      return <span className="dv-static" style={runtime.stale(sec.sectionId, f) ? { opacity: .55 } : undefined}>{shown ?? '-'}</span>;
    }

    const editable = f.access === 'read-write' || kind !== 'text';
    if (kind === 'idlist' && f.idList) return <IdListEditor ids={parseIdList(val)} cfg={f.idList} editable={false} changed={false} onChange={() => undefined} />;
    if (kind === 'select') {
      const opts = enumOptions(f);
      return (<>
        <select className="dv-select" value={val ?? opts[0]?.value ?? ''} onChange={() => undefined} disabled={!editable}>
          {opts.length === 0 && <option value="">—</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {hintEl}
      </>);
    }
    if (kind === 'checkbox') return <input type="checkbox" checked={val === '1' || val === 'true'} onChange={() => undefined} />;
    if (kind === 'input') {
      return (<>
        <input className="dv-input" type="text" value={val ?? ''} placeholder={design ? (f.mibObject || '') : ''} onChange={() => undefined} readOnly={!editable} />
        {hintEl}
      </>);
    }
    return <span className="dv-static">{val ?? '—'}</span>;
  };

  const rowProps = (sec: UiDescriptorSection, f: UiDescriptorField, axis: 'x' | 'y' = 'y') => ({
    'data-dv-field': f.fieldId,
    title: design ? `${f.mibObject || ''}  ${f.oid || ''}`.trim() : undefined,
    onClick: design ? (e: React.MouseEvent) => { e.stopPropagation(); onSelectField?.(sec.sectionId, f.fieldId); } : undefined,
    ...dragSrc({ type: 'dv-field', sectionId: sec.sectionId, fieldId: f.fieldId }),
    ...fieldDrop(sec, f, axis),
  });
  const labelEd = (sec: UiDescriptorSection, f: UiDescriptorField) => (
    <Ed value={fieldTitle(f)} onCommit={ed ? (v) => ed.setFieldLabel(sec.sectionId, f.fieldId, v) : undefined} />
  );

  /** A row flagged "hide when empty" is left out of a live Node View while the device has no value for it (the device UI hides such rows by mode). The designer always shows it. */
  const rowHidden = (sec: UiDescriptorSection, f: UiDescriptorField) =>
    !!runtime && !design && runtime.ready && !rowVisible(sec, f, runtime);

  const renderSection = (sec: UiDescriptorSection) => {
    if (sec.uiLayout === 'charts') {
      return (
        <div key={sec.sectionId} className={design && selectedSectionId === sec.sectionId ? 'sel-section' : ''} data-dv-section={sec.sectionId}
          onClick={design ? () => onSelectSection?.(sec.sectionId) : undefined}>
          <StatsCharts config={sec.uiCharts} group={sec.sectionId} fetcher={runtime?.history} liveFetcher={runtime?.liveStats} />
        </div>
      );
    }
    const fields = [...sec.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter(isBindable);
    const forms = fields.filter((f) => f.elementType === 'field-label');
    const tables = fields.filter((f) => f.elementType === 'table-block');
    const cls = selectedSectionId === sec.sectionId && design ? 'sel-section' : '';
    return (
      <div key={sec.sectionId} data-dv-section={sec.sectionId} className={cls}
        onClick={design ? () => onSelectSection?.(sec.sectionId) : undefined} {...sectionDrop(sec)}>
        {[...sec.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((f) => {
          if (f.elementType === 'divider') return <hr key={f.fieldId} className={`dv-divider ${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f)} />;
          if (f.elementType === 'heading' || f.elementType === 'sub-heading') {
            return (
              <div key={f.fieldId} className={`dv-subhead ${f.elementType === 'heading' ? 'lg' : ''} ${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f)}>
                {labelEd(sec, f)}
              </div>
            );
          }
          if (f.elementType !== 'field-label') return null;
          if (rowHidden(sec, f)) return null;
          return (
            <div key={f.fieldId} className={`dv-row ${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f)}>
              <label className="dv-label">{labelEd(sec, f)}</label>
              <div className="dv-field">{renderControl(f, sec)}</div>
            </div>
          );
        })}
        {tables.length > 0 && (
          <div className="dv-tablewrap">
            <table className="dv-table">
              <thead><tr>
                {tables.map((f) => (
                  <th key={f.fieldId} className={`${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f, 'x')}>
                    {labelEd(sec, f)}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {(() => {
                  if (!runtime) return <tr>{tables.map((f, i) => (i === 0 ? <td key={f.fieldId} className="empty" colSpan={tables.length}>{design ? 'Collecting data...' : '—'}</td> : null))}</tr>;
                  const perField = tables.map((f) => new Map(runtime.rows(sec.sectionId, f).map((r) => [r.index, r.text] as const)));
                  const idx = Array.from(new Set(perField.flatMap((m) => [...m.keys()]))).sort((a, b) => {
                    const na = parseInt(a, 10), nb = parseInt(b, 10);
                    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
                  });
                  if (idx.length === 0) return <tr><td className="empty" colSpan={tables.length}>Collecting data...</td></tr>;
                  return idx.map((i) => <tr key={i}>{tables.map((f, k) => <td key={f.fieldId}>{perField[k].get(i) ?? '-'}</td>)}</tr>);
                })()}
              </tbody>
            </table>
          </div>
        )}
        {design && fields.length === 0 && sec.fields.length === 0 && <div className="dv-note" style={{ opacity: .6 }}>Empty section — add MIB objects from the “MIB objects” panel.</div>}
      </div>
    );
  };

  const renderMatrix = (sec: UiDescriptorSection) => {
    const mx = sec.uiMatrix ?? { columns: [] };
    const cols = mx.columns ?? [];
    const fields = [...sec.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter(isBindable);
    const shown = runtime ? visibleMatrixColumns(sec, runtime) : cols;
    const addColumn = () => {
      const next = String(Math.max(0, ...cols.map((c) => parseInt(c.index, 10) || 0)) + 1);
      ed?.patchSection(sec.sectionId, { uiMatrix: { ...mx, columns: [...cols, { index: next, label: `Radio ${cols.length + 1}` }] } });
    };
    return (
      <fieldset key={sec.sectionId} className={`dv-card dv-matrix ${design && selectedSectionId === sec.sectionId ? 'sel-section' : ''}`}
        data-dv-section={sec.sectionId} onClick={design ? () => onSelectSection?.(sec.sectionId) : undefined} {...sectionDrop(sec)}>
        <legend><Ed value={sec.title} onCommit={ed ? (v) => ed.setSectionTitle(sec.sectionId, v) : undefined} />
          {design && sec.uiHideWhenEmpty && <span className="dv-badge">hidden when empty</span>}</legend>
        <table className="dv-mx">
          <thead><tr>
            <th />
            {shown.map((c) => (
              <th key={c.index} title={design ? `table row ${c.index}${mx.hideEmptyColumns === false ? '' : ' — hidden when the device has no data for it'}` : undefined}>
                <Ed value={c.label} onCommit={ed ? (v) => ed.patchSection(sec.sectionId, { uiMatrix: { ...mx, columns: cols.map((x) => (x.index === c.index ? { ...x, label: v } : x)) } }) : undefined} />
              </th>
            ))}
            {ed && <th><button type="button" className="dv-add inline" onClick={(e) => { e.stopPropagation(); addColumn(); }}>+ column</button></th>}
          </tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.fieldId} className={`${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f)}>
                <td className="k">{labelEd(sec, f)}</td>
                {shown.map((c) => { const t = runtime ? matrixCell(runtime, sec.sectionId, f, c.index) : null; return <td key={c.index}>{t == null ? (runtime ? '-' : '—') : (c.map && c.map[t] != null ? c.map[t] : t)}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
        {design && cols.length === 0 && <div className="dv-note" style={{ opacity: .6 }}>No radio columns yet — click “+ column”. Bind each row to a table column OID; column N shows table row N.</div>}
        {design && fields.length === 0 && <div className="dv-note" style={{ opacity: .6 }}>No rows yet — add table-column objects from the “MIB objects” panel.</div>}
      </fieldset>
    );
  };

  const renderCard = (sec: UiDescriptorSection) => {
    if (sec.uiLayout === 'matrix') return renderMatrix(sec);
    const fields = [...sec.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).filter(isBindable);
    return (
      <fieldset key={sec.sectionId} className={`dv-card ${design && selectedSectionId === sec.sectionId ? 'sel-section' : ''}`}
        data-dv-section={sec.sectionId} onClick={design ? () => onSelectSection?.(sec.sectionId) : undefined} {...sectionDrop(sec)}>
        <legend><Ed value={sec.title} onCommit={ed ? (v) => ed.setSectionTitle(sec.sectionId, v) : undefined} />
          {design && sec.uiHideWhenEmpty && <span className="dv-badge">hidden when empty</span>}</legend>
        {fields.filter((f) => !rowHidden(sec, f)).map((f) => (
          <div key={f.fieldId} className={`dv-card-row ${selectedFieldId === f.fieldId ? 'sel' : ''} ${hintClass(f.fieldId)}`} {...rowProps(sec, f)}>
            <div className="k">{labelEd(sec, f)}</div>
            <div className="v">{(runtime ? runtime.display(sec.sectionId, f) : values?.[f.fieldId]) ?? (runtime ? '-' : '—')}</div>
          </div>
        ))}
        {design && fields.length === 0 && <div className="dv-note" style={{ opacity: .6 }}>Empty card — add MIB objects from the “MIB objects” panel.</div>}
      </fieldset>
    );
  };
  // Cards flow side by side; when any card is pinned to a column they stack in a left and a right column (device Summary).
  const renderCards = (secs: UiDescriptorSection[]) => {
    if (!secs.some((c) => c.uiColumn)) return <div className="dv-cards">{secs.map(renderCard)}</div>;
    return (
      <div className="dv-cols">
        <div className="dv-col">{secs.filter((c) => c.uiColumn !== 'right').map(renderCard)}</div>
        <div className="dv-col">{secs.filter((c) => c.uiColumn === 'right').map(renderCard)}</div>
      </div>
    );
  };

  const tabSections = tab?.sections ?? [];
  const cardSecs = tabSections.filter((s) => s.uiLayout === 'card' || s.uiLayout === 'matrix');
  const otherSecs = tabSections.filter((s) => s.uiLayout !== 'card' && s.uiLayout !== 'matrix');
  const writable = tabSections.some((s) => s.writeMode === 'apply-button' && s.fields.some((f) => f.access === 'read-write' && f.valueSource !== 'static' && f.valueSource !== 'calc'));
  const saveLabel = hd.saveLabel || 'Save';

  return (
    <div className={`dv-root ${design ? 'dv-design' : ''}`}>
      <div className="dv-header">
        {/* Header values come from the device (data sources set in the builder); typed text is only the fallback / sample.
            An item with a data source is edited in the Inspector, not by typing over its sample here. */}
        <div className="dv-hd-item dv-hd-val" style={{ left: 90, top: 22 }}>
          <Ed value={hd.productName ?? ''} placeholder={screenName} onCommit={ed && !hasSource(hd, 'productName') ? (v) => ed.header({ productName: v }) : undefined}>
            {header ? (header.productName ?? '—') : ((hd.bind?.productName && (runtime ? runtime.byField(hd.bind.productName) : values?.[hd.bind.productName])) || hd.productName || screenName)}
          </Ed>
        </div>
        <div className="dv-hd-item dv-hd-val" style={{ left: 90, top: 44 }}>
          <Ed value={hd.versionLine ?? ''} placeholder="version / serial" onCommit={ed && !hasSource(hd, 'versionLine') ? (v) => ed.header({ versionLine: v }) : undefined}>
            {header ? (header.versionLine ?? '—') : ((hd.bind?.versionLine && (runtime ? runtime.byField(hd.bind.versionLine) : values?.[hd.bind.versionLine])) || hd.versionLine)}
          </Ed>
        </div>
        <div className="dv-hd-item dv-hd-lbl" style={{ left: 322, top: 34 }}>Uptime</div>
        <div className="dv-hd-item dv-hd-val" style={{ left: 403, top: 34 }}>
          <Ed value={hd.uptime ?? ''} placeholder="uptime" onCommit={ed && !hasSource(hd, 'uptime') ? (v) => ed.header({ uptime: v }) : undefined}>
            {header ? (header.uptime ?? '—') : ((hd.bind?.uptime && (runtime ? runtime.byField(hd.bind.uptime) : values?.[hd.bind.uptime])) || hd.uptime || '—')}
          </Ed>
        </div>
        {(header ? header.radios : radios).slice(0, 3).map((r, i) => {
          const own = radios[i];
          const sourced = !!(own?.modeSource || own?.labelSource);
          return (
            <div key={i} className="dv-hd-radio" style={{ left: 637 + i * 70 }}>
              <div className="dv-hd-lbl"><Ed value={r.label} onCommit={ed && !own?.labelSource ? (v) => setRadio(i, { label: v }) : undefined} /></div>
              <div className="dv-hd-val" style={{ marginTop: 4 }}>
                <span className={`dv-led ${r.up ? 'up' : ''}`} title={ed && !own?.upSource ? 'Click to toggle status colour' : undefined} onClick={ed && !own?.upSource ? () => setRadio(i, { up: !r.up }) : undefined} />
                <Ed value={r.mode} onCommit={ed && !sourced ? (v) => setRadio(i, { mode: v }) : undefined} />
              </div>
            </div>
          );
        })}
        {ed && radios.length < 3 && (
          <button type="button" className="dv-add inline" style={{ position: 'absolute', left: 637 + radios.length * 70, top: 30, width: 'auto' }}
            onClick={() => ed.header({ radios: [...radios, { label: `Radio ${radios.length + 1}`, mode: 'AP', up: false }] })}>+ radio</button>
        )}
        {[ICON.home, ICON.save, ICON.power, ICON.out].map((d, i) => (
          <div key={i} className="dv-hd-icon" style={{ left: 908 + i * 53 }}><Svg d={d} /></div>
        ))}
      </div>

      <nav className="dv-sidebar">
        <ul>
          {tree.map((p, pi) => {
            const isOpen = !!open[p.name];
            return (
              <li key={p.name} className="dv-top">
                <div className={`dv-top-a ${nodeProps('page', { page: p.name, parent: '', tab: '' }).cls}`} {...nodeProps('page', { page: p.name, parent: '', tab: '' }).rest} onClick={() => {
                  if (p.direct) pick({ page: p.name, parent: p.parents[0].name, tab: p.parents[0].tabs[0]?.name });
                  else setOpen((o) => ({ ...o, [p.name]: !o[p.name] }));
                }}>
                  <Svg className="dv-ico" d={TOP_ICON(p.name, pi)} />
                  <Ed value={p.name} onCommit={ed ? (v) => ed.renamePage(p.name, v) : undefined} />
                  {!p.direct && <Svg className="dv-chev" d={isOpen ? ICON.down : ICON.right} />}
                  <Ctl level="page" pg={p.name} />
                </div>
                {(p.direct ? false : isOpen) && (
                  <ul className="dv-sub">
                    {p.parents.map((r) => (
                      <li key={r.name} className={`${path.page === p.name && path.parent === r.name ? 'active' : ''} ${nodeProps('parent', { page: p.name, parent: r.name, tab: '' }).cls}`} {...nodeProps('parent', { page: p.name, parent: r.name, tab: '' }).rest}>
                        <a onClick={() => pick({ page: p.name, parent: r.name, tab: r.tabs[0]?.name })}>
                          <Svg className="dv-ico" d={ICON.wifi} />
                          <Ed value={r.name} onCommit={ed ? (v) => ed.renameParent(p.name, r.name, v) : undefined} />
                        </a>
                        <Ctl level="parent" pg={p.name} pr={r.name} />
                      </li>
                    ))}
                    {ed && <li><button type="button" className="dv-add" onClick={() => ed.addParent(p.name)}>+ Add menu item</button></li>}
                  </ul>
                )}
              </li>
            );
          })}
          {ed && <li className="dv-top"><button type="button" className="dv-add" style={{ margin: '12px 0 12px 14px' }} onClick={() => ed.addPage()}>+ Add menu section</button></li>}
        </ul>
      </nav>

      <main className="dv-content" {...(ed ? {
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault(); setHint(null);
          const pl = readPayload(e); if (!pl) return;
          const last = tabSections[tabSections.length - 1];
          if (pl.type === 'mib-object') ed.dropObject(pl.name, last ? { sectionId: last.sectionId } : { page: path.page, parent: path.parent, tab: path.tab });
          else if (pl.type === 'dv-field' && last) ed.moveField({ sectionId: pl.sectionId, fieldId: pl.fieldId }, { sectionId: last.sectionId });
        },
      } : {})}>
        {!parent ? (
          <div className="dv-note">
            {ed ? <button type="button" className="dv-add inline" onClick={() => ed.addPage()}>+ Add the first menu section</button> : 'No sections yet.'}
          </div>
        ) : (<>
          <h2 className="dv-h2"><span>
            <Ed value={parent.title} placeholder={parent.name} onCommit={ed ? (v) => ed.setParentTitle(path.page, path.parent, v) : undefined}>{parent.title || parent.name}</Ed>
          </span></h2>
          {(parent.tabs.length > 1 || ed) && (
            <ul className="dv-tabs">
              {parent.tabs.map((t) => (
                <li key={t.name} className={`dv-tab ${t.name === path.tab ? 'active' : ''} ${nodeProps('tab', { page: path.page, parent: path.parent, tab: t.name }).cls}`} {...nodeProps('tab', { page: path.page, parent: path.parent, tab: t.name }).rest}>
                  <a onClick={() => pick({ tab: t.name })}>
                    <Ed value={t.name} onCommit={ed ? (v) => ed.renameTab(path.page, path.parent, t.name, v) : undefined} />
                  </a>
                  <Ctl level="tab" pg={path.page} pr={path.parent} tb={t.name} />
                </li>
              ))}
              {ed && <li><button type="button" className="dv-add inline" onClick={() => ed.addTab(path.page, path.parent)}>+ tab</button></li>}
            </ul>
          )}
          {cardSecs.length > 0 && renderCards(cardSecs)}
          {otherSecs.map(renderSection)}
          {ed && <button type="button" className="dv-add inline" style={{ margin: '4px 0 12px' }} onClick={() => ed.addSection(path.page, path.parent, path.tab)}>+ Add section to this tab</button>}
          {(tab?.note || ed) && (
            <div className="dv-note">
              <Ed value={tab?.note ?? ''} multiline placeholder="Double-click to add a note under the form"
                onCommit={ed ? (v) => ed.setTabNote(path.page, path.parent, path.tab, v) : undefined} />
            </div>
          )}
          {(writable || ed) && (
            <div className="dv-actions" style={!writable && !runtime ? { opacity: .35 } : undefined}>
              {runtime ? (() => {
                const sids = tabSections.map((x) => x.sectionId);
                const n = runtime.pending(sids);
                return (<>
                  <button type="button" className="dv-btn" disabled={n === 0 || runtime.applying} onClick={() => runtime.onApply(sids)}>
                    {runtime.applying ? 'Saving…' : (n > 0 ? `${saveLabel} (${n})` : saveLabel)}
                  </button>
                  {n > 0 && !runtime.applying && <button type="button" className="dv-btn" style={{ marginLeft: 10 }} onClick={() => runtime.onRevert(sids)}>Revert</button>}
                </>);
              })() : (
                <button type="button" className="dv-btn" title={!writable ? 'Hidden at runtime: no writable section in this tab' : undefined}>
                  <Ed value={hd.saveLabel ?? ''} placeholder="Save" onCommit={ed ? (v) => ed.header({ saveLabel: v }) : undefined}>{saveLabel}</Ed>
                </button>
              )}
            </div>
          )}
        </>)}
      </main>
    </div>
  );
};

export default DeviceUiView;

/**
 * V2MibBuilderV2Page — Custom UI Builder v2 ("device look").
 *
 * Designs a screen that looks exactly like the device web UI: header bar, left menu (Page > Parent), tab row,
 * label-left form rows, note and Save button, summary cards and statistics tables. Everything shown is
 * configurable here and stored on the same descriptor the classic builder uses (additive optional fields only),
 * so descriptors built with the classic Custom UI Builder keep working and keep their layout.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDescriptor, deleteDescriptor, getDescriptor, listDescriptors, publishDescriptor, updateDescriptor,
} from '../../api/uiBuilder.api';
import type { MibObjectSummary, ParseMibResult } from '../../api/productDefinitions.api';
import type {
  DeviceUiConfig, UiDescriptor, UiDescriptorField, UiDescriptorSection, UiDescriptorSummary,
} from '../../api/uiBuilder.api';
import { useToast } from '../components/common/Toast';
import DeviceUiView from '../deviceui/DeviceUiView';
import type { DeviceUiEdit } from '../deviceui/DeviceUiView';
import MibLibraryPanel from '../deviceui/MibLibraryPanel';
import { arrangeObjects, objectToField } from '../deviceui/mibFieldFactory';
import { ALL_WIDGETS, LIVE_OPTIONS, sectionCanBeLive, suggestLiveRefresh } from '../deviceui/sectionSettings';
import { generateUiXml, WidgetRulesScreen } from './V2MibBuilderPage';
import { computeField, computeSource, referencedInputs } from '../deviceui/calcExpr';
import HeaderSourcesEditor, { InputRow } from '../deviceui/HeaderSourcesEditor';
import { previewHeader } from '../deviceui/headerPreview';
import type { ActivePath, DevicePage } from '../deviceui/deviceUiModel';
import {
  buildDeviceTree, firstPath, isBindable, newId, pageOf, parentOf, resolvePath, tabOf,
} from '../deviceui/deviceUiModel';

const LAYOUTS: { v: '' | 'form' | 'card' | 'table' | 'matrix'; l: string }[] = [
  { v: '', l: 'Auto' }, { v: 'form', l: 'Form rows (label left)' }, { v: 'card', l: 'Summary card' }, { v: 'matrix', l: 'Radio columns (matrix)' }, { v: 'table', l: 'Table' },
];

const box: React.CSSProperties = { border: '1px solid var(--vf-border-subtle)', borderRadius: 8, padding: 10, marginBottom: 10, background: 'var(--vf-surface)' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--vf-text-muted)', margin: '8px 0 3px', textTransform: 'uppercase', letterSpacing: 0.3 };
const inp: React.CSSProperties = { width: '100%', fontSize: 12, padding: '5px 7px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', boxSizing: 'border-box' };
const btn: React.CSSProperties = { fontSize: 11, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', cursor: 'pointer' };
type ShowWhenRule = { field: string; in?: string[]; notIn?: string[]; required?: boolean };
/** Parse the "Show this row only when…" text: one rule per line. Lines naming no sibling field are returned in `bad`, never dropped silently. */
function parseShowWhen(text: string, fields: UiDescriptorField[], selfId: string): { rules: ShowWhenRule[]; bad: string[] } {
  const rules: ShowWhenRule[] = []; const bad: string[] = [];
  for (const raw of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const req = /\(required\)\s*$/i.test(raw); const l = raw.replace(/\s*\(required\)\s*$/i, '');
    const m = /^(.*?)\s*(!=|=)\s*(.*)$/.exec(l);
    const sib = m ? fields.find((x) => x.fieldId !== selfId && x.label.trim().toLowerCase() === m[1].trim().toLowerCase()) : undefined;
    const vals = m ? m[3].split(',').map((x) => x.trim()).filter(Boolean) : [];
    if (!m || !sib || vals.length === 0) { bad.push(raw); continue; }
    rules.push({ field: sib.fieldId, ...(m[2] === '=' ? { in: vals } : { notIn: vals }), ...(req ? { required: true } : {}) });
  }
  return { rules, bad };
}

const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--vf-accent)', color: '#fff', border: '1px solid var(--vf-accent)' };
const h3: React.CSSProperties = { margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: 'var(--vf-text-primary)' };

function enumToText(m?: Record<string, string>): string {
  return Object.entries(m || {}).filter(([k]) => k !== 'columns').map(([k, v]) => `${k}=${v}`).join('\n');
}
function textToEnum(t: string, keep?: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (keep && (keep as Record<string, unknown>).columns !== undefined) (out as Record<string, unknown>).columns = (keep as Record<string, unknown>).columns;
  return Object.keys(out).length ? out : undefined;
}

/** The gateway's reason for a refused request (e.g. "2 device(s) still use this screen …"). */
function serverMessage(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
  return m || fallback;
}

/** Screens: every saved screen with open / rename / duplicate / delete (the classic builder's draft cards). */
const ScreensPanel: React.FC<{
  list: UiDescriptorSummary[]; currentId?: string; onOpen: (id: string) => void; onChanged: () => void; onCurrentDeleted: () => void;
  toast: { error: (m: string) => void; success: (m: string) => void };
}> = ({ list, currentId, onOpen, onChanged, onCurrentDeleted, toast }) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const rename = async (id: string) => {
    if (!name.trim()) return; setBusy(id);
    try { await updateDescriptor(id, { screenName: name.trim() }); setEditing(null); toast.success('Renamed'); onChanged(); } catch { toast.error('Rename failed'); } finally { setBusy(null); }
  };
  const duplicate = async (id: string) => {
    setBusy(id);
    try {
      const d = await getDescriptor(id);
      await createDescriptor({ screenName: `${d.screenName} (copy)`, deviceProfile: d.deviceProfile, vendor: d.vendor, productFamily: d.productFamily, mibModule: d.mibModule,
        sections: d.sections, deviceUi: d.deviceUi ?? undefined, layoutMode: d.layoutMode ?? undefined, defaultPollInterval: d.defaultPollInterval ?? undefined, selectedObjects: d.selectedObjects });
      toast.success('Duplicated as a new draft'); onChanged();
    } catch { toast.error('Duplicate failed'); } finally { setBusy(null); }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try { await deleteDescriptor(id); setConfirm(null); toast.success('Deleted'); if (id === currentId) onCurrentDeleted(); onChanged(); }
    catch (e) { setConfirm(null); toast.error(serverMessage(e, 'Delete failed')); } finally { setBusy(null); }
  };
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', maxHeight: 280, overflowY: 'auto' }}>
      <b style={{ fontSize: 12 }}>Screens ({list.length})</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 8, marginTop: 8 }}>
        {list.map((d) => (
          <div key={d.descriptorId} style={{ border: `1px solid ${d.descriptorId === currentId ? 'var(--vf-accent)' : 'var(--vf-border-subtle)'}`, borderRadius: 8, padding: 8, background: 'var(--vf-elevated)' }}>
            {editing === d.descriptorId ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <input autoFocus style={inp} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(d.descriptorId); if (e.key === 'Escape') setEditing(null); }} />
                <button style={btn} disabled={busy === d.descriptorId} onClick={() => void rename(d.descriptorId)}>✓</button>
              </div>
            ) : <div style={{ fontSize: 12, fontWeight: 700 }}>{d.screenName}</div>}
            <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', margin: '2px 0 6px' }}>
              {d.status} · {d.sectionCount} sections · {d.objectCount} objects · {d.layoutMode === 'device' ? 'device layout' : 'classic layout'} · {ago(d.updatedAt)}
            </div>
            {confirm === d.descriptorId ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'var(--vf-danger)', flex: 1 }}>{d.status === 'published' ? 'Delete this PUBLISHED screen? Its Node View layout is removed.' : 'Delete this draft?'}</span>
                <button style={{ ...btn, color: 'var(--vf-danger)' }} disabled={busy === d.descriptorId} onClick={() => void remove(d.descriptorId)}>Delete</button>
                <button style={btn} onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button style={{ ...btn, background: 'var(--vf-accent)', color: '#fff', borderColor: 'var(--vf-accent)' }} onClick={() => onOpen(d.descriptorId)}>Open</button>
                <button style={btn} onClick={() => { setEditing(d.descriptorId); setName(d.screenName); }}>✏ Rename</button>
                <button style={btn} disabled={busy === d.descriptorId} onClick={() => void duplicate(d.descriptorId)}>Duplicate</button>
                <button style={{ ...btn, color: 'var(--vf-danger)' }}
                  title={d.status === 'published' ? 'Delete this published screen (refused while a device still uses it)' : 'Delete this draft'} onClick={() => setConfirm(d.descriptorId)}>🗑</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const V2MibBuilderV2Page: React.FC = () => {
  const { addToast } = useToast();
  const toast = useMemo(() => ({
    error: (m: string) => addToast(m, 'error'),
    success: (m: string) => addToast(m, 'success'),
  }), [addToast]);
  const [list, setList] = useState<UiDescriptorSummary[]>([]);
  const [draft, setDraft] = useState<UiDescriptor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showWhenDraft, setShowWhenDraft] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<ActivePath>({ page: '', parent: '', tab: '' });
  const [selField, setSelField] = useState<{ sectionId: string; fieldId: string } | null>(null);
  const [selSection, setSelSection] = useState<string>('');
  const [zoom, setZoom] = useState(0.8);
  const [newSec, setNewSec] = useState({ page: '', parent: '', tab: '' });
  const [panel, setPanel] = useState<'inspect' | 'mib'>('inspect');
  const [showNew, setShowNew] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [needsRepublish, setNeedsRepublish] = useState(false);
  const [lastParse, setLastParse] = useState<ParseMibResult | null>(null);
  const [showScreens, setShowScreens] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [nu, setNu] = useState({ name: '', profile: '' });

  // keyboard: Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo / redo; Delete removes the selected field (not while typing)
  const kbRef = useRef<{ undo: () => void; redo: () => void; del: () => void }>({ undo: () => undefined, redo: () => undefined, del: () => undefined });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) kbRef.current.redo(); else kbRef.current.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); kbRef.current.redo(); }
      else if (e.key === 'Delete') kbRef.current.del();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshList = useCallback(async () => {
    try { setList(await listDescriptors()); } catch { toast.error('Could not load descriptors'); }
  }, [toast]);
  useEffect(() => { void refreshList(); }, [refreshList]);
  // deep link: /v2/mib-builder-v2?id=<descriptorId>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) void (async () => { try { const d = await getDescriptor(id); setDraftSync(d); resetHistory(); setActive(firstPath(buildDeviceTree(d.screenName, d.sections))); } catch { /* ignore */ } })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (id: string) => {
    if (!id) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    try {
      const d = await getDescriptor(id);
      setDraftSync(d); resetHistory(); setDirty(false); setNeedsRepublish(false); setSelField(null); setSelSection('');
      setActive(firstPath(buildDeviceTree(d.screenName, d.sections)));
    } catch { toast.error('Could not open descriptor'); }
  };

  // Every edit goes through update(): the draft lives in a ref so several edits in one handler see each other, and each
  // burst of edits (typing in a box counts as one) is one undo step.
  const draftRef = useRef<UiDescriptor | null>(null);
  const undoStack = useRef<UiDescriptor[]>([]);
  const redoStack = useRef<UiDescriptor[]>([]);
  const lastPush = useRef(0);
  const [, setHist] = useState(0);
  const setDraftSync = (d: UiDescriptor | null) => { draftRef.current = d; setDraft(d); };
  const resetHistory = () => { undoStack.current = []; redoStack.current = []; setHist((t) => t + 1); };
  const update = (fn: (d: UiDescriptor) => UiDescriptor) => {
    const prev = draftRef.current; if (!prev) return;
    const next = fn(prev); if (next === prev) return;
    const now = Date.now();
    if (now - lastPush.current > 600) { undoStack.current.push(prev); if (undoStack.current.length > 80) undoStack.current.shift(); }
    lastPush.current = now; redoStack.current = [];
    draftRef.current = next; setDraft(next); setDirty(true); setHist((t) => t + 1);
  };
  const undo = () => {
    const prev = undoStack.current.pop(); if (!prev || !draftRef.current) return;
    redoStack.current.push(draftRef.current); lastPush.current = 0;
    draftRef.current = prev; setDraft(prev); setDirty(true); setHist((t) => t + 1);
  };
  const redo = () => {
    const nxt = redoStack.current.pop(); if (!nxt || !draftRef.current) return;
    undoStack.current.push(draftRef.current); lastPush.current = 0;
    draftRef.current = nxt; setDraft(nxt); setDirty(true); setHist((t) => t + 1);
  };
  const patchSection = (sid: string, patch: Partial<UiDescriptorSection>) =>
    update((d) => ({ ...d, sections: d.sections.map((s) => (s.sectionId === sid ? { ...s, ...patch } : s)) }));
  const patchField = (sid: string, fid: string, patch: Partial<UiDescriptorField>) =>
    update((d) => ({ ...d, sections: d.sections.map((s) => (s.sectionId !== sid ? s : { ...s, fields: s.fields.map((f) => (f.fieldId === fid ? { ...f, ...patch } : f)) })) }));

  const tree = useMemo(() => (draft ? buildDeviceTree(draft.screenName, draft.sections) : []), [draft]);
  const path = useMemo(() => resolvePath(tree, active), [tree, active]);
  const tabSections = useMemo(
    () => draft?.sections.filter((s) => pageOf(s, draft.screenName) === path.page && parentOf(s) === path.parent && tabOf(s) === path.tab) ?? [],
    [draft, path],
  );
  const curSection = draft?.sections.find((s) => s.sectionId === (selField?.sectionId || selSection)) ?? tabSections[0];
  const curField = selField && curSection ? curSection.fields.find((f) => f.fieldId === selField.fieldId) : undefined;
  // design-time values: fixed text as typed, calculated fields from the sample inputs (the gateway computes the real ones)
  const previewValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const sec of draft?.sections ?? []) for (const f of sec.fields) {
      if (f.valueSource === 'static') out[f.fieldId] = f.staticValue ?? '';
      else if (f.valueSource === 'calc' && (f.calc?.expr || f.calc?.template)) {
        const raw: Record<string, string> = {};
        (f.calc.inputs ?? []).forEach((i) => { raw[i.name] = i.sample ?? ''; });
        const r = computeSource({ ...f.calc, kind: f.calc.template ? 'template' : 'calc' }, raw);
        out[f.fieldId] = r.ok ? r.text : '⚠ ' + r.error;
      }
    }
    return out;
  }, [draft]);
  // objects the header can map to: the screen's MIB list plus anything already placed on the screen (a placed field may not be in the list)
  const headerObjects = useMemo(() => {
    const m = new Map<string, MibObjectSummary>();
    for (const o of draft?.selectedObjects ?? []) m.set(o.name, o);
    for (const sec of draft?.sections ?? []) for (const f of sec.fields) {
      // only scalar system objects: a per-radio field's OID already carries its table row, which is not a base OID
      if (f.mibObject && f.oid && !m.has(f.mibObject) && /^sys/.test(f.mibObject)) m.set(f.mibObject, { name: f.mibObject, oid: f.oid, nmsDataType: f.syntax ?? '', access: f.access ?? 'read-only', indexType: f.elementType === 'table-block' ? 'SINGLE_INDEX' : 'SCALAR', indexLabel: '', section: '', subSection: '', isEnum: false, enumValueCount: 0 } as MibObjectSummary);
    }
    return [...m.values()];
  }, [draft]);
  const allFieldOptions = useMemo(() => (draft?.sections ?? []).flatMap((s) => s.fields.filter(isBindable).map((f) => ({ id: f.fieldId, text: `${f.label || f.mibObject} — ${s.title}` }))), [draft]);
  const usedObjects = useMemo(() => new Set((draft?.sections ?? []).flatMap((s) => s.fields.map((f) => f.mibObject).filter(Boolean) as string[])), [draft]);

  const save = async () => {
    if (!draft?.descriptorId) return;
    setBusy(true);
    try {
      const d = await updateDescriptor(draft.descriptorId, {
        screenName: draft.screenName, sections: draft.sections, deviceUi: draft.deviceUi ?? null, layoutMode: draft.layoutMode === 'classic' ? 'classic' : 'device', defaultPollInterval: draft.defaultPollInterval ?? 30,
        selectedObjects: draft.selectedObjects, mibModule: draft.mibModule, vendor: draft.vendor, productFamily: draft.productFamily,
        deviceProfile: draft.deviceProfile,
      });
      setDraftSync(d); setDirty(false); if (d.status === 'published') setNeedsRepublish(true); toast.success(d.status === 'published' ? 'Saved — republish to make it live' : 'Saved'); void refreshList();
    } catch { toast.error('Save failed'); } finally { setBusy(false); }
  };
  const saveCopy = async () => {
    if (!draft) return;
    const name = window.prompt('Name for the new copy', `${draft.screenName} (device UI)`);
    if (!name) return;
    setBusy(true);
    try {
      const d = await createDescriptor({
        screenName: name, deviceProfile: draft.deviceProfile, vendor: draft.vendor, productFamily: draft.productFamily,
        mibModule: draft.mibModule, sections: draft.sections.map(({ ...s }) => s), deviceUi: draft.deviceUi ?? undefined, layoutMode: draft.layoutMode === 'classic' ? 'classic' : 'device', defaultPollInterval: draft.defaultPollInterval ?? 30,
        selectedObjects: draft.selectedObjects,
      });
      setDraftSync(d); resetHistory(); setDirty(false); toast.success('Copy created'); void refreshList();
    } catch { toast.error('Copy failed'); } finally { setBusy(false); }
  };
  /** Publish (or republish). When there are unsaved edits they are saved first, in one step. */
  const publish = async () => {
    if (!draft?.descriptorId) return;
    const again = draft.status === 'published';
    if (!window.confirm(again
      ? 'Republish this screen? Devices that use it get the updated layout, labels, refresh times and calculated fields in Node View.'
      : 'Publish this screen? It becomes the Node View layout for devices that use it.')) return;
    setBusy(true);
    try {
      if (dirty) {
        await updateDescriptor(draft.descriptorId, {
          screenName: draft.screenName, sections: draft.sections, deviceUi: draft.deviceUi ?? null, layoutMode: draft.layoutMode === 'classic' ? 'classic' : 'device', defaultPollInterval: draft.defaultPollInterval ?? 30,
          selectedObjects: draft.selectedObjects, mibModule: draft.mibModule, vendor: draft.vendor, productFamily: draft.productFamily, deviceProfile: draft.deviceProfile,
        });
      }
      setDraftSync(await publishDescriptor(draft.descriptorId)); setDirty(false); setNeedsRepublish(false);
      toast.success(again ? 'Republished' : 'Published'); void refreshList();
    } catch { toast.error('Publish failed'); } finally { setBusy(false); }
  };

  // ── structure edits ──────────────────────────────────────────────────────
  const moveSection = (sid: string, dir: -1 | 1) => update((d) => {
    const arr = [...d.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const i = arr.findIndex((s) => s.sectionId === sid), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return d;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return { ...d, sections: arr.map((s, k) => ({ ...s, order: k })) };
  });
  const moveField = (sid: string, fid: string, dir: -1 | 1) => update((d) => ({
    ...d, sections: d.sections.map((s) => {
      if (s.sectionId !== sid) return s;
      const arr = [...s.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const i = arr.findIndex((f) => f.fieldId === fid), j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return s;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...s, fields: arr.map((f, k) => ({ ...f, order: k })) };
    }),
  }));
  const deleteField = (sid: string, fid: string) => { update((d) => ({ ...d, sections: d.sections.map((s) => (s.sectionId === sid ? { ...s, fields: s.fields.filter((f) => f.fieldId !== fid) } : s)) })); setSelField(null); };
  kbRef.current = { undo, redo, del: () => { if (selField) deleteField(selField.sectionId, selField.fieldId); } };
  const deleteSection = (sid: string) => {
    if (!window.confirm('Delete this section and all its fields?')) return;
    update((d) => ({ ...d, sections: d.sections.filter((s) => s.sectionId !== sid) })); setSelField(null); setSelSection('');
  };
  const moveFieldTo = (fromSid: string, fid: string, toSid: string) => update((d) => {
    const f = d.sections.find((s) => s.sectionId === fromSid)?.fields.find((x) => x.fieldId === fid);
    if (!f || fromSid === toSid) return d;
    return { ...d, sections: d.sections.map((s) => {
      if (s.sectionId === fromSid) return { ...s, fields: s.fields.filter((x) => x.fieldId !== fid) };
      if (s.sectionId === toSid) return { ...s, fields: [...s.fields, { ...f, order: s.fields.length }] };
      return s;
    }) };
  });
  const addSection = () => {
    if (!draft) return;
    const page = newSec.page.trim() || path.page || draft.screenName, parent = newSec.parent.trim() || path.parent, tab = newSec.tab.trim() || parent;
    if (!parent) { toast.error('Enter a Parent'); return; }
    const s: UiDescriptorSection = { sectionId: newId('s'), title: tab, columns: 2, pollInterval: draft.defaultPollInterval ?? 30, writeMode: 'read-only', uiPage: page, uiParent: parent, uiTab: tab, fields: [], order: draft.sections.length };
    update((d) => ({ ...d, sections: [...d.sections, s] }));
    setSelSection(s.sectionId); setSelField(null); setActive({ page, parent, tab }); setNewSec({ page: '', parent: '', tab: '' });
  };
  const addElement = (sid: string, type: 'heading' | 'sub-heading' | 'divider') => {
    const sec = draft?.sections.find((x) => x.sectionId === sid); if (!sec) return;
    const f: UiDescriptorField = { fieldId: newId('f'), elementType: type, label: type === 'divider' ? '' : (type === 'heading' ? 'Heading' : 'Sub-heading'), labelLevel: type === 'divider' ? 'field' : type, order: sec.fields.length };
    update((d) => ({ ...d, sections: d.sections.map((x) => (x.sectionId === sid ? { ...x, fields: [...x.fields, f] } : x)) }));
    setSelField({ sectionId: sid, fieldId: f.fieldId });
  };
  // ── drag & drop + bind helpers ───────────────────────────────────────────
  const reindex = (fs: UiDescriptorField[]) => fs.map((f, i) => ({ ...f, order: i }));
  const sortedFields = (s: UiDescriptorSection) => [...s.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const insertAt = (s: UiDescriptorSection, f: UiDescriptorField, fieldId?: string, position: 'before' | 'after' = 'after'): UiDescriptorSection => {
    const arr = sortedFields(s);
    let idx = arr.length;
    if (fieldId) { const i = arr.findIndex((x) => x.fieldId === fieldId); if (i >= 0) idx = i + (position === 'after' ? 1 : 0); }
    arr.splice(idx, 0, f);
    return { ...s, fields: reindex(arr), writeMode: f.access === 'read-write' ? 'apply-button' : s.writeMode };
  };
  const bindObjectTo = (sid: string, fid: string, o: MibObjectSummary) => {
    const f = objectToField(o, 0);
    patchField(sid, fid, { mibObject: f.mibObject, oid: f.oid, syntax: f.syntax, access: f.access, units: f.units, enumMap: f.enumMap, widget: f.widget, elementType: f.elementType, valueSource: 'mib' });
  };
  const addBlank = (sid: string, type: 'field-label' | 'table-block') => {
    const sec = draft?.sections.find((x) => x.sectionId === sid); if (!sec) return;
    const f: UiDescriptorField = {
      fieldId: newId('f'), elementType: type, label: type === 'table-block' ? 'Table' : 'New field', labelLevel: 'field',
      widget: type === 'table-block' ? 'Data table' : 'Text value', access: 'read-only', pollInterval: draft?.defaultPollInterval ?? 30, order: sec.fields.length,
    };
    update((d) => ({ ...d, sections: d.sections.map((x) => (x.sectionId === sid ? { ...x, fields: [...x.fields, f] } : x)) }));
    setSelField({ sectionId: sid, fieldId: f.fieldId });
  };

  const addObjects = (objs: MibObjectSummary[]) => {
    if (!curSection) { toast.error('Select a section in the preview first'); return; }
    const have = new Set(curSection.fields.map((f) => f.mibObject));
    update((d) => ({ ...d, sections: d.sections.map((s) => {
      if (s.sectionId !== curSection.sectionId) return s;
      const add = objs.filter((o) => !have.has(o.name)).map((o, i) => objectToField(o, s.fields.length + i));
      const rw = add.some((f) => f.access === 'read-write');
      return { ...s, fields: [...s.fields, ...add], writeMode: rw ? 'apply-button' : s.writeMode };
    }) }));
  };
  const arrange = (objs: MibObjectSummary[]) => {
    if (!draft) return;
    const sections = arrangeObjects(draft.screenName, draft.sections, objs, draft.defaultPollInterval ?? 30);
    update((d) => ({ ...d, sections }));
    const first = sections.find((s) => !draft.sections.some((o) => o.sectionId === s.sectionId));
    if (first) setActive({ page: pageOf(first, draft.screenName), parent: parentOf(first), tab: tabOf(first) });
  };
  const removeObjects = (names: string[]) => update((d) => ({ ...d, selectedObjects: (d.selectedObjects ?? []).filter((o) => !names.includes(o.name)) }));
  const onParsed = (r: ParseMibResult) => { setLastParse(r); update((d) => {
    const have = new Map((d.selectedObjects ?? []).map((o) => [o.name, o] as const));
    r.objects.forEach((o) => have.set(o.name, o));
    return { ...d, selectedObjects: [...have.values()], mibModule: d.mibModule || r.moduleName, vendor: d.vendor || r.vendor, productFamily: d.productFamily || r.productLine };
  }); };

  // ── from scratch ─────────────────────────────────────────────────────────
  const createScreen = async () => {
    const name = nu.name.trim();
    if (!name) { toast.error('Enter a screen name'); return; }
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setBusy(true);
    try {
      const d = await createDescriptor({ screenName: name, deviceProfile: nu.profile.trim() || undefined, sections: [], selectedObjects: [], deviceUi: { productName: name }, layoutMode: 'device', defaultPollInterval: 30 });
      setDraftSync(d); resetHistory(); setDirty(false); setShowNew(false); setNu({ name: '', profile: '' }); setPanel('mib');
      setSelField(null); setSelSection(''); setActive({ page: '', parent: '', tab: '' });
      toast.success('Screen created — upload a MIB to start'); void refreshList();
    } catch { toast.error('Could not create the screen'); } finally { setBusy(false); }
  };
  const removeDraft = async () => {
    if (!draft?.descriptorId) return;
    const pub = draft.status === 'published';
    if (!window.confirm(pub
      ? `Delete the PUBLISHED screen “${draft.screenName}”? Its Node View layout is removed. This is refused while a device still uses it, and cannot be undone.`
      : `Delete draft “${draft.screenName}”? This cannot be undone.`)) return;
    try { await deleteDescriptor(draft.descriptorId); setDraftSync(null); resetHistory(); setDirty(false); toast.success('Deleted'); void refreshList(); }
    catch (e) { toast.error(serverMessage(e, 'Delete failed')); }
  };

  // ── structure + inline edits (Page > Parent > Tab) ───────────────────────
  const uniq = (base: string, taken: string[]) => { let n = base, i = 2; while (taken.includes(n)) n = `${base} ${i++}`; return n; };
  const inPath = (s: UiDescriptorSection, pg: string, pr?: string, tb?: string) =>
    !!draft && pageOf(s, draft.screenName) === pg && (pr === undefined || parentOf(s) === pr) && (tb === undefined || tabOf(s) === tb);
  const mapSections = (pred: (s: UiDescriptorSection) => boolean, patch: (s: UiDescriptorSection) => Partial<UiDescriptorSection>) =>
    update((d) => ({ ...d, sections: d.sections.map((s) => (pred(s) ? { ...s, ...patch(s) } : s)) }));
  const flatten = (t: DevicePage[]) => t.flatMap((p) => p.parents.flatMap((r) => r.tabs.flatMap((x) => x.sections))).map((s, i) => ({ ...s, order: i }));
  const clash = (what: string) => toast.error(`${what} name already exists here`);

  const edit: DeviceUiEdit = {
    header: (patch) => setHd(patch),
    renamePage: (page, to) => {
      const v = to.trim(); if (!v || v === page) return;
      if (tree.some((p) => p.name === v)) { clash('Menu section'); return; }
      mapSections((s) => inPath(s, page), (s) => ({ uiPage: v, ...(parentOf(s) === page ? { uiParent: v } : {}) }));
      if (path.page === page) setActive({ ...path, page: v, parent: path.parent === page ? v : path.parent });
    },
    renameParent: (page, parent, to) => {
      const v = to.trim(); if (!v || v === parent) return;
      if (tree.find((p) => p.name === page)?.parents.some((r) => r.name === v)) { clash('Menu item'); return; }
      mapSections((s) => inPath(s, page, parent), () => ({ uiParent: v }));
      if (path.page === page && path.parent === parent) setActive({ ...path, parent: v });
    },
    renameTab: (page, parent, tab, to) => {
      const v = to.trim(); if (!v || v === tab) return;
      if (tree.find((p) => p.name === page)?.parents.find((r) => r.name === parent)?.tabs.some((t) => t.name === v)) { clash('Tab'); return; }
      mapSections((s) => inPath(s, page, parent, tab), () => ({ uiTab: v }));
      if (path.page === page && path.parent === parent && path.tab === tab) setActive({ ...path, tab: v });
    },
    setParentTitle: (page, parent, v) => mapSections((s) => inPath(s, page, parent), () => ({ uiTitle: v })),
    setTabNote: (page, parent, tab, v) => {
      let first = true;
      mapSections((s) => inPath(s, page, parent, tab), () => { const r = { uiNote: first ? v : '' }; first = false; return r; });
    },
    setSectionTitle: (sid, v) => patchSection(sid, { title: v }),
    patchSection: (sid, patch) => patchSection(sid, patch),
    setFieldLabel: (sid, fid, v) => patchField(sid, fid, { label: v }),
    setFieldHint: (sid, fid, v) => patchField(sid, fid, { helpText: v }),
    addPage: () => {
      if (!draft) return;
      const page = uniq('New menu section', tree.map((p) => p.name));
      const s: UiDescriptorSection = { sectionId: newId('s'), title: 'New tab', columns: 2, pollInterval: draft.defaultPollInterval ?? 30, writeMode: 'read-only', uiPage: page, uiParent: 'New item', uiTab: 'New tab', fields: [], order: draft.sections.length };
      update((d) => ({ ...d, sections: [...d.sections, s] })); setActive({ page, parent: 'New item', tab: 'New tab' }); setSelSection(s.sectionId); setSelField(null);
    },
    addParent: (page) => {
      if (!draft) return;
      const parent = uniq('New item', tree.find((p) => p.name === page)?.parents.map((r) => r.name) ?? []);
      const s: UiDescriptorSection = { sectionId: newId('s'), title: 'New tab', columns: 2, pollInterval: draft.defaultPollInterval ?? 30, writeMode: 'read-only', uiPage: page, uiParent: parent, uiTab: 'New tab', fields: [], order: draft.sections.length };
      update((d) => {
        const idx = d.sections.reduce((m, x, i) => (pageOf(x, d.screenName) === page ? i : m), d.sections.length - 1);
        const arr = [...d.sections]; arr.splice(idx + 1, 0, s); return { ...d, sections: arr.map((x, i) => ({ ...x, order: i })) };
      });
      setActive({ page, parent, tab: 'New tab' }); setSelSection(s.sectionId); setSelField(null);
    },
    addTab: (page, parent) => {
      if (!draft) return;
      const tab = uniq('New tab', tree.find((p) => p.name === page)?.parents.find((r) => r.name === parent)?.tabs.map((t) => t.name) ?? []);
      const s: UiDescriptorSection = { sectionId: newId('s'), title: tab, columns: 2, pollInterval: draft.defaultPollInterval ?? 30, writeMode: 'read-only', uiPage: page, uiParent: parent, uiTab: tab, fields: [], order: draft.sections.length };
      update((d) => {
        const idx = d.sections.reduce((m, x, i) => (pageOf(x, d.screenName) === page && parentOf(x) === parent ? i : m), d.sections.length - 1);
        const arr = [...d.sections]; arr.splice(idx + 1, 0, s); return { ...d, sections: arr.map((x, i) => ({ ...x, order: i })) };
      });
      setActive({ page, parent, tab }); setSelSection(s.sectionId); setSelField(null);
    },
    addSection: (page, parent, tab) => {
      if (!draft) return;
      const inTab = draft.sections.filter((x) => pageOf(x, draft.screenName) === page && parentOf(x) === parent && tabOf(x) === tab);
      const card = inTab.some((x) => x.uiLayout === 'card');
      const s: UiDescriptorSection = {
        sectionId: newId('s'), title: uniq('New section', inTab.map((x) => x.title)), columns: 2, pollInterval: draft.defaultPollInterval ?? 30, writeMode: 'read-only',
        uiPage: page, uiParent: parent, uiTab: tab, ...(card ? { uiLayout: 'card' as const } : {}), fields: [], order: draft.sections.length,
      };
      update((d) => {
        const idx = d.sections.reduce((m, x, i) => (pageOf(x, d.screenName) === page && parentOf(x) === parent && tabOf(x) === tab ? i : m), d.sections.length - 1);
        const arr = [...d.sections]; arr.splice(idx + 1, 0, s); return { ...d, sections: arr.map((x, i) => ({ ...x, order: i })) };
      });
      setSelSection(s.sectionId); setSelField(null); setPanel('inspect');
    },
    dropObject: (name, t) => {
      if (!draft) return;
      const o = (draft.selectedObjects ?? []).find((x) => x.name === name);
      if (!o) { toast.error('That object is not in this screen’s MIB list'); return; }
      let sectionId = t.sectionId;
      update((d) => {
        let sections = [...d.sections];
        if (!sectionId) {
          const page = t.page || d.screenName || 'Screen', parent = t.parent || 'New item', tab = t.tab || 'New tab';
          const ns: UiDescriptorSection = { sectionId: newId('s'), title: tab, columns: 2, pollInterval: d.defaultPollInterval ?? 30, writeMode: 'read-only', uiPage: page, uiParent: parent, uiTab: tab, fields: [], order: sections.length };
          sections = [...sections, ns]; sectionId = ns.sectionId;
          setActive({ page, parent, tab });
        }
        const field = objectToField(o, 0);
        return { ...d, sections: sections.map((x) => (x.sectionId === sectionId ? insertAt(x, field, t.fieldId, t.position) : x)) };
      });
      if (sectionId) { setSelSection(sectionId); setPanel('inspect'); }
    },
    moveField: (from, target) => {
      if (!draft) return;
      if (from.sectionId === target.sectionId && from.fieldId === target.fieldId) return;
      update((d) => {
        const src = d.sections.find((x) => x.sectionId === from.sectionId);
        const f = src?.fields.find((x) => x.fieldId === from.fieldId);
        if (!f) return d;
        let secs = d.sections.map((x) => (x.sectionId === from.sectionId ? { ...x, fields: reindex(sortedFields(x).filter((y) => y.fieldId !== from.fieldId)) } : x));
        secs = secs.map((x) => (x.sectionId === target.sectionId ? insertAt(x, f, target.fieldId, target.position) : x));
        return { ...d, sections: secs };
      });
      setSelField({ sectionId: target.sectionId, fieldId: from.fieldId }); setSelSection(target.sectionId);
    },
    moveNode: (level, from, to, position) => {
      if (!draft) return;
      const t = buildDeviceTree(draft.screenName, draft.sections);
      let arr: { name: string }[] | undefined; let fromName = '', toName = '';
      if (level === 'page') { arr = t; fromName = from.page; toName = to.page; }
      else if (from.page !== to.page) return;
      else if (level === 'parent') { arr = t.find((x) => x.name === from.page)?.parents; fromName = from.parent; toName = to.parent; }
      else if (from.parent !== to.parent) return;
      else { arr = t.find((x) => x.name === from.page)?.parents.find((x) => x.name === from.parent)?.tabs; fromName = from.tab; toName = to.tab; }
      if (!arr || fromName === toName) return;
      const fi = arr.findIndex((x) => x.name === fromName); if (fi < 0) return;
      const [item] = arr.splice(fi, 1);
      let ti = arr.findIndex((x) => x.name === toName); if (ti < 0) return;
      if (position === 'after') ti += 1;
      arr.splice(ti, 0, item);
      update((d) => ({ ...d, sections: flatten(t) }));
    },
    move: (level, page, parent, tab, dir) => {
      if (!draft) return;
      const t = buildDeviceTree(draft.screenName, draft.sections);
      const swap = <T,>(arr: T[], i: number) => { const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
      const p = t.find((x) => x.name === page);
      if (level === 'page') swap(t, t.findIndex((x) => x.name === page));
      else if (p && level === 'parent') swap(p.parents, p.parents.findIndex((x) => x.name === parent));
      else if (p) { const r = p.parents.find((x) => x.name === parent); if (r) swap(r.tabs, r.tabs.findIndex((x) => x.name === tab)); }
      update((d) => ({ ...d, sections: flatten(t) }));
    },
    remove: (level, page, parent, tab) => {
      const what = level === 'page' ? `menu section “${page}”` : level === 'parent' ? `menu item “${parent}”` : `tab “${tab}”`;
      if (!window.confirm(`Delete ${what} with all its sections and fields?`)) return;
      update((d) => ({ ...d, sections: d.sections.filter((s) => !(
        pageOf(s, d.screenName) === page && (level === 'page' || (parentOf(s) === parent && (level === 'parent' || tabOf(s) === tab))))) }));
      setSelField(null); setSelSection('');
    },
  };

  const hd: DeviceUiConfig = draft?.deviceUi || {};
  const setHd = (p: Partial<DeviceUiConfig>) => update((d) => ({ ...d, deviceUi: { ...(d.deviceUi || {}), ...p } }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)', minHeight: 600 }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--vf-border-subtle)', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Custom UI Builder v2</strong>
        <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>device-look screens · the classic builder is unchanged</span>
        <select style={{ ...inp, width: 260 }} value={draft?.descriptorId ?? ''} onChange={(e) => void open(e.target.value)}>
          <option value="">Open a descriptor…</option>
          {list.map((d) => <option key={d.descriptorId} value={d.descriptorId}>{d.screenName} · {d.status} · {d.objectCount} objects</option>)}
        </select>
        <label style={{ fontSize: 11 }}>Zoom&nbsp;
          <select style={{ ...inp, width: 70, display: 'inline-block' }} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 0.9, 0.8, 0.7, 0.6, 0.5].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
        </label>
        <button style={btn} onClick={() => setShowNew((v) => !v)}>+ New screen</button>
        <button style={btn} onClick={() => setShowScreens((v) => !v)}>Screens</button>
        <button style={btn} disabled={!undoStack.current.length} title="Undo (Ctrl+Z)" onClick={undo}>↶ Undo</button>
        <button style={btn} disabled={!redoStack.current.length} title="Redo (Ctrl+Shift+Z)" onClick={redo}>↷ Redo</button>
        {draft && (
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }} title="Default poll interval for new sections (seconds). Each section can override it.">
            Default poll
            <input type="number" min={5} style={{ ...inp, width: 54 }} value={draft.defaultPollInterval ?? 30}
              onChange={(e) => update((d) => ({ ...d, defaultPollInterval: Number(e.target.value) || 30 }))} />s
            <button style={btn} title="Set every section's poll interval to this value"
              onClick={() => update((d) => ({ ...d, sections: d.sections.map((x) => ({ ...x, pollInterval: d.defaultPollInterval ?? 30 })) }))}>Apply to all</button>
          </label>
        )}
        <button style={btn} onClick={() => setShowRules((v) => !v)}>Widget rules</button>
        <span style={{ flex: 1 }} />
        {dirty && <span style={{ fontSize: 11, color: 'var(--vf-warning, #b7791f)' }}>unsaved changes</span>}
        <button style={btnPrimary} disabled={!draft || !dirty || busy} onClick={() => void save()}>Save</button>
        <button style={btn} disabled={!draft} onClick={() => setShowXml((v) => !v)}>{showXml ? 'Hide XML' : 'View XML'}</button>
        <button style={btn} disabled={!draft || busy} onClick={() => void saveCopy()}>Save as copy</button>
        <button style={btn} disabled={!draft || busy} onClick={() => void publish()}>{draft?.status === 'published' ? (dirty ? 'Save & republish' : 'Republish') : (dirty ? 'Save & publish' : 'Publish')}</button>
        {draft && <button style={{ ...btn, color: 'var(--vf-danger)' }} disabled={busy} onClick={() => void removeDraft()}>{draft.status === 'published' ? 'Delete screen' : 'Delete draft'}</button>}
      </div>

      {showNew && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '10px 14px', borderBottom: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', flexWrap: 'wrap' }}>
          <div style={{ width: 260 }}><label style={lbl}>Screen name *</label>
            <input style={inp} autoFocus value={nu.name} placeholder="e.g. UBR660 default UI" onChange={(e) => setNu({ ...nu, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void createScreen(); }} /></div>
          <div style={{ width: 260 }}><label style={lbl}>Device profile (vendor - product family)</label>
            <input style={inp} value={nu.profile} placeholder="Vendor - Product family" onChange={(e) => setNu({ ...nu, profile: e.target.value })} /></div>
          <button style={btnPrimary} disabled={busy} onClick={() => void createScreen()}>Create blank screen</button>
          <button style={btn} onClick={() => setShowNew(false)}>Cancel</button>
          <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>Then upload a MIB, add objects, and shape the menu, tabs and labels directly in the preview.</span>
        </div>
      )}

      {draft?.status === 'published' && (dirty || needsRepublish) && (
        <div style={{ padding: '6px 14px', fontSize: 12, background: 'var(--vf-warning-subtle, #fff4e0)', color: 'var(--vf-warning, #8a5a00)', borderBottom: '1px solid var(--vf-border-subtle)' }}>
          You are editing a <b>published</b> screen. Node View keeps showing the last published version until you click <b>{dirty ? 'Save & republish' : 'Republish'}</b>.
        </div>
      )}

      {showScreens && (
        <ScreensPanel
          list={list}
          currentId={draft?.descriptorId}
          onOpen={(id) => { setShowScreens(false); void open(id); }}
          onChanged={() => void refreshList()}
          onCurrentDeleted={() => { setDraftSync(null); resetHistory(); setDirty(false); }}
          toast={toast}
        />
      )}

      {showRules && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowRules(false)}>
          <div style={{ background: 'var(--vf-surface)', borderRadius: 10, width: 'min(900px, 92vw)', maxHeight: '86vh', overflow: 'auto', padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', marginBottom: 8 }}><b style={{ flex: 1 }}>Widget rules</b><button style={btn} onClick={() => setShowRules(false)}>Close</button></div>
            <WidgetRulesScreen descriptor={draft ? ({ ...draft, defaultPollInterval: draft.defaultPollInterval ?? 30 } as never) : null} />
          </div>
        </div>
      )}

      {showXml && draft && (() => {
        const xml = generateUiXml({ ...draft, defaultPollInterval: 30 } as unknown as Parameters<typeof generateUiXml>[0]);
        const fileName = `${(draft.screenName || 'screen').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}.xml`;
        return (
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <b style={{ fontSize: 12 }}>Generated screen XML</b>
              <span style={{ fontSize: 10, color: 'var(--vf-text-muted)' }}>updates live as you edit (same generator as the classic builder)</span>
              <span style={{ flex: 1 }} />
              <button style={btn} onClick={() => { void navigator.clipboard?.writeText(xml); toast.success('XML copied'); }}>Copy</button>
              <button style={btn} onClick={() => {
                const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
                const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
              }}>Download</button>
            </div>
            <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', fontSize: 11, background: 'var(--vf-canvas)', padding: 8, borderRadius: 6, border: '1px solid var(--vf-border-subtle)' }}>{xml}</pre>
          </div>
        );
      })()}

      {!draft ? (
        <div style={{ padding: 30, color: 'var(--vf-text-muted)', fontSize: 13 }}>
          Open a descriptor above, or click <b>+ New screen</b> to build one from scratch: upload a MIB, pick objects, then rename and
          arrange everything directly in the device-style preview (double-click any text to edit it). Use <b>Save as copy</b> to keep an original untouched.
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* preview */}
          <div style={{ flex: 1, overflow: 'auto', background: '#e4e6ea' }}>
            <div style={{ zoom }}>
              <DeviceUiView
                design
                screenName={draft.screenName}
                sections={draft.sections}
                deviceUi={draft.deviceUi}
                header={previewHeader(draft.deviceUi)}
                edit={edit}
                values={previewValues}
                active={path}
                onActiveChange={(p) => { setActive(p); setSelField(null); setSelSection(''); }}
                selectedFieldId={selField?.fieldId}
                selectedSectionId={selField?.sectionId || selSection}
                onSelectField={(sectionId, fieldId) => { setSelField({ sectionId, fieldId }); setSelSection(sectionId); }}
                onSelectSection={(sid) => { setSelSection(sid); setSelField(null); }}
              />
            </div>
          </div>

          {/* inspector */}
          <div style={{ width: 350, overflowY: 'auto', padding: 12, borderLeft: '1px solid var(--vf-border-subtle)' }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button style={{ ...btn, flex: 1, ...(panel === 'inspect' ? { borderColor: 'var(--vf-accent)', color: 'var(--vf-accent)' } : {}) }} onClick={() => setPanel('inspect')}>Inspector</button>
              <button style={{ ...btn, flex: 1, ...(panel === 'mib' ? { borderColor: 'var(--vf-accent)', color: 'var(--vf-accent)' } : {}) }} onClick={() => setPanel('mib')}>MIB objects ({draft.selectedObjects?.length ?? 0})</button>
            </div>
            {panel === 'mib' && (
              <div style={box}>
                <div style={h3}>MIB library</div>
                <MibLibraryPanel
                  objects={draft.selectedObjects ?? []}
                  usedNames={usedObjects}
                  targetLabel={curSection ? `${pageOf(curSection, draft.screenName)} › ${parentOf(curSection)} › ${tabOf(curSection)}` : ''}
                  selectedFieldLabel={curField && isBindable(curField) ? (curField.label || curField.mibObject) : undefined}
                  parseInfo={lastParse}
                  onParsed={onParsed}
                  onAddToSection={addObjects}
                  onArrange={arrange}
                  onBindToSelected={(o) => { if (selField) bindObjectTo(selField.sectionId, selField.fieldId, o); }}
                  onRemove={removeObjects}
                />
              </div>
            )}
            {panel === 'inspect' && (<>
            <div style={box}>
              <div style={h3}>Screen</div>
              <label style={lbl}>Screen name</label>
              <input style={inp} value={draft.screenName} onChange={(e) => update((d) => ({ ...d, screenName: e.target.value }))} />
              <label style={lbl}>Device profile (vendor - product family)</label>
              <input style={inp} value={draft.deviceProfile ?? ''} placeholder="Vendor - Product family" onChange={(e) => update((d) => ({ ...d, deviceProfile: e.target.value }))} />
              <label style={lbl}>Node View style (default for this screen)</label>
              <select style={inp} value={draft.layoutMode === 'classic' ? 'classic' : 'device'} onChange={(e) => update((d) => ({ ...d, layoutMode: e.target.value as 'device' | 'classic' }))}>
                <option value="device">Device look — like the device's own web UI</option>
                <option value="classic">Classic cards — one card per section</option>
              </select>
              <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 3 }}>Whoever opens a device can still switch between the two on its Node View page. Republish to apply.</div>
              <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 8 }}>The header bar (name, version, uptime, radio badges) is set up in the box below.</div>
            </div>

            <div style={box}>
              <div style={h3}>Header bar — data</div>
              <HeaderSourcesEditor ui={hd} onChange={(p) => setHd(p)} objects={headerObjects} />
            </div>

            {curSection && (
              <div style={box}>
                <div style={h3}>Section · {curSection.title}</div>
                {tabSections.length > 1 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                    {tabSections.map((s) => (
                      <button key={s.sectionId} style={{ ...btn, ...(s.sectionId === curSection.sectionId ? { borderColor: 'var(--vf-accent)' } : {}) }}
                        onClick={() => { setSelSection(s.sectionId); setSelField(null); }}>{s.title}</button>
                    ))}
                  </div>
                )}
                {(['uiPage', 'uiParent', 'uiTab'] as const).map((k) => (
                  <React.Fragment key={k}>
                    <label style={lbl}>{k === 'uiPage' ? 'Page (top menu)' : k === 'uiParent' ? 'Parent (sub menu)' : 'Tab'}</label>
                    <input style={inp} value={curSection[k] ?? ''} onChange={(e) => {
                      const v = e.target.value; patchSection(curSection.sectionId, { [k]: v });
                      setActive({ page: k === 'uiPage' ? v : path.page, parent: k === 'uiParent' ? v : path.parent, tab: k === 'uiTab' ? v : path.tab });
                    }} />
                  </React.Fragment>
                ))}
                <label style={lbl}>Page heading (shown above the tabs)</label>
                <input style={inp} value={curSection.uiTitle ?? ''} placeholder={curSection.uiParent || ''} onChange={(e) => patchSection(curSection.sectionId, { uiTitle: e.target.value })} />
                <label style={lbl}>Section title (card legend)</label>
                <input style={inp} value={curSection.title} onChange={(e) => patchSection(curSection.sectionId, { title: e.target.value })} />
                <label style={lbl}>Note under the form</label>
                <textarea style={{ ...inp, height: 56 }} value={curSection.uiNote ?? ''} onChange={(e) => patchSection(curSection.sectionId, { uiNote: e.target.value })} />
                <label style={lbl}>Layout</label>
                <select style={inp} value={curSection.uiLayout ?? ''} onChange={(e) => patchSection(curSection.sectionId, { uiLayout: (e.target.value || undefined) as UiDescriptorSection['uiLayout'] })}>
                  {LAYOUTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
                {(curSection.uiLayout === 'card' || curSection.uiLayout === 'matrix') && (<>
                  <label style={lbl}>Card column (Summary page)</label>
                  <select style={inp} value={curSection.uiColumn ?? ''} onChange={(e) => patchSection(curSection.sectionId, { uiColumn: (e.target.value || undefined) as UiDescriptorSection['uiColumn'] })}>
                    <option value="">Flow (side by side)</option><option value="left">Left column</option><option value="right">Right column</option>
                  </select>
                </>)}
                {curSection.uiLayout === 'matrix' && (() => {
                  const mx = curSection.uiMatrix ?? { columns: [] };
                  const cols = mx.columns ?? [];
                  const setMx = (p: Partial<typeof mx>) => patchSection(curSection.sectionId, { uiMatrix: { ...mx, ...p } });
                  return (<>
                    <label style={lbl}>Radio columns (table row · heading)</label>
                    {cols.map((c, k) => (
                      <div key={k} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                        <input style={{ ...inp, width: 54 }} title="Table row index (the number at the end of the OID)" value={c.index}
                          onChange={(e) => setMx({ columns: cols.map((x, j) => (j === k ? { ...x, index: e.target.value } : x)) })} />
                        <input style={{ ...inp, flex: 1 }} value={c.label} placeholder="Heading, e.g. Radio 2"
                          onChange={(e) => setMx({ columns: cols.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} />
                        <input style={{ ...inp, width: 96 }} title="Show values of this column as, e.g. ap=BTS, sta=CPE (a radio's role)" placeholder="show as…"
                          value={Object.entries(c.map ?? {}).map(([a, z]) => `${a}=${z}`).join(', ')}
                          onChange={(e) => { const m: Record<string, string> = {}; for (const part of e.target.value.split(',')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim()) m[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } setMx({ columns: cols.map((x, j) => (j === k ? { ...x, map: Object.keys(m).length ? m : undefined } : x)) }); }} />
                        <button style={btn} title="Remove this column" onClick={() => setMx({ columns: cols.filter((_, j) => j !== k) })}>✕</button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button style={btn} onClick={() => setMx({ columns: [...cols, { index: String(Math.max(0, ...cols.map((c) => parseInt(c.index, 10) || 0)) + 1), label: `Radio ${cols.length + 1}` }] })}>+ Radio column</button>
                      <button style={btn} title="Table rows 2, 3, 1 as on the UBR650/660 radios — check them on your device"
                        onClick={() => setMx({ columns: [{ index: '2', label: 'Radio 1' }, { index: '3', label: 'Radio 2' }, { index: '1', label: '2.4 GHz' }] })}>Preset: Radio 1, Radio 2, 2.4 GHz</button>
                    </div>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, marginTop: 8 }}>
                      <input type="checkbox" checked={mx.hideEmptyColumns !== false} onChange={(e) => setMx({ hideEmptyColumns: e.target.checked })} />
                      Hide a column when the device returns no data for it
                    </label>
                    <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 3 }}>
                      Each row of the matrix is a field bound to a table <b>column</b> OID; column “2” shows table row 2. A one-radio device shows one column, a two-radio device two.
                    </div>
                  </>);
                })()}
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, marginTop: 8 }}
                  title="In Node View, this section (and a tab, menu item or menu section left empty by it) is skipped when the device returns no data for it">
                  <input type="checkbox" checked={!!curSection.uiHideWhenEmpty} onChange={(e) => patchSection(curSection.sectionId, { uiHideWhenEmpty: e.target.checked || undefined })} />
                  Hide this section when the device has no data for it
                </label>
                <label style={lbl}>Write mode (Save button)</label>
                <select style={inp} value={curSection.writeMode ?? 'read-only'} onChange={(e) => patchSection(curSection.sectionId, { writeMode: e.target.value as UiDescriptorSection['writeMode'] })}>
                  <option value="apply-button">Apply button</option><option value="direct">Direct</option><option value="read-only">Read-only</option>
                </select>

                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Poll interval (s)</label>
                    <input style={inp} type="number" min={5} value={curSection.pollInterval ?? 30} title="How often Node View re-reads this section (seconds)"
                      onChange={(e) => patchSection(curSection.sectionId, { pollInterval: Number(e.target.value) })} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Columns</label>
                    <select style={inp} value={curSection.columns} onChange={(e) => patchSection(curSection.sectionId, { columns: Number(e.target.value) as 1 | 2 })}>
                      <option value={1}>1 column</option><option value={2}>2 columns</option>
                    </select>
                  </div>
                </div>
                {(() => {
                  const canLive = sectionCanBeLive(curSection);
                  const live = canLive ? (curSection.liveRefreshSeconds ?? 0) : 0;
                  const suggested = suggestLiveRefresh(curSection);
                  return (<>
                    <label style={lbl}>Live refresh (real-time, read-only sections)</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select style={inp} value={live} disabled={!canLive} onChange={(e) => patchSection(curSection.sectionId, { liveRefreshSeconds: Number(e.target.value) })}
                        title={canLive ? 'How often Node View re-reads this whole section in real time. Off = normal refresh.' : 'Live refresh needs every field in the section to be read-only.'}>
                        {LIVE_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'Live: off' : `Live: every ${n}s`}</option>)}
                      </select>
                      {canLive && live === 0 && suggested > 0 && (
                        <button style={{ ...btn, borderStyle: 'dashed', whiteSpace: 'nowrap' }} title="This section holds counters/measurements"
                          onClick={() => patchSection(curSection.sectionId, { liveRefreshSeconds: suggested })}>⚡ {suggested}s?</button>
                      )}
                    </div>
                    {!canLive && <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 3 }}>Only for sections where every field is read-only.</div>}
                  </>);
                })()}
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, marginTop: 8 }}>
                  <input type="checkbox" checked={!!curSection.fullWidth} onChange={(e) => patchSection(curSection.sectionId, { fullWidth: e.target.checked })} /> Full width (tables)
                </label>

                <label style={lbl}>Add element to this section</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {([['heading', 'Heading'], ['sub-heading', 'Sub-heading'], ['divider', 'Divider']] as const).map(([t, l]) => (
                    <button key={t} style={btn} onClick={() => addElement(curSection.sectionId, t)}>+ {l}</button>
                  ))}
                  <button style={btn} title="An empty field you bind to a MIB object, fixed text or a calculation later" onClick={() => addBlank(curSection.sectionId, 'field-label')}>+ Field (blank)</button>
                  <button style={btn} title="An empty table column you bind to a MIB object later" onClick={() => addBlank(curSection.sectionId, 'table-block')}>+ Table column (blank)</button>
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button style={btn} onClick={() => moveSection(curSection.sectionId, -1)}>Move earlier ↑</button>
                  <button style={btn} onClick={() => moveSection(curSection.sectionId, 1)}>Move later ↓</button>
                  <button style={{ ...btn, color: 'var(--vf-danger)' }} onClick={() => deleteSection(curSection.sectionId)}>Delete</button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 6 }}>Menu and tab order follow section order.</div>
              </div>
            )}

            {curSection && curField && (() => {
              const bindable = isBindable(curField);
              const patch = (p: Partial<UiDescriptorField>) => patchField(curSection.sectionId, curField.fieldId, p);
              return (
              <div style={box}>
                <div style={h3}>{bindable ? `Field · ${curField.mibObject || curField.fieldId}` : `Element · ${curField.elementType}`}</div>
                <label style={lbl}>Label (shown as on the device)</label>
                <input style={inp} value={curField.label} onChange={(e) => patch({ label: e.target.value })} />
                <label style={lbl}>Label level</label>
                <select style={inp} value={curField.labelLevel ?? (curField.elementType === 'heading' ? 'heading' : curField.elementType === 'sub-heading' ? 'sub-heading' : 'field')}
                  onChange={(e) => patch({ labelLevel: e.target.value as UiDescriptorField['labelLevel'] })}>
                  <option value="heading">Heading</option><option value="sub-heading">Sub-heading</option><option value="field">Field</option>
                </select>

                {bindable && (() => {
                  const src = curField.valueSource ?? 'mib';
                  const obj = (draft.selectedObjects ?? []).find((o) => o.name === curField.mibObject);
                  const setCalc = (c: Partial<NonNullable<UiDescriptorField['calc']>>) => patch({ calc: { expr: '', inputs: [], ...(curField.calc || {}), ...c } });
                  const inputs = curField.calc?.inputs ?? [];
                  const isTpl = curField.calc?.template != null;
                  const res = (curField.calc?.expr || curField.calc?.template) ? computeSource({ ...curField.calc, kind: isTpl ? 'template' : 'calc' }, Object.fromEntries(inputs.map((i) => [i.name, i.sample ?? '']))) : null;
                  let unknown: string[] = [];
                  try { unknown = (!isTpl && curField.calc?.expr) ? referencedInputs(curField.calc.expr).filter((n) => !inputs.some((i) => i.name === n)) : []; } catch { /* syntax error shown via res */ }
                  return (<>
                    <label style={lbl}>Label taken from</label>
                    <select style={inp} value={curField.labelSource ?? 'custom'} onChange={(e) => {
                      const v = e.target.value as NonNullable<UiDescriptorField['labelSource']>;
                      if (v === 'mibName') patch({ labelSource: v, label: curField.mibObject || curField.label });
                      else if (v === 'mibDescription') patch({ labelSource: v, label: (obj?.description || curField.mibObject || curField.label).slice(0, 80) });
                      else patch({ labelSource: v });
                    }}>
                      <option value="custom">Typed text (hard-coded)</option>
                      <option value="mibName" disabled={!curField.mibObject}>MIB object name</option>
                      <option value="mibDescription" disabled={!obj?.description}>MIB description</option>
                    </select>
                    <label style={lbl}>Value comes from</label>
                    <select style={inp} value={src} onChange={(e) => {
                      const v = e.target.value as 'mib' | 'static' | 'calc';
                      patch(v === 'mib' ? { valueSource: 'mib' } : { valueSource: v, widget: 'Text value', access: 'read-only', elementType: 'field-label' });
                    }}>
                      <option value="mib">MIB parameter (OID read from the device)</option>
                      <option value="static">Fixed text (hard-coded)</option>
                      <option value="calc">Calculated from device values</option>
                    </select>
                    {src === 'static' && (<>
                      <label style={lbl}>Fixed value</label>
                      <input style={inp} value={curField.staticValue ?? ''} placeholder="e.g. UBR660" onChange={(e) => patch({ staticValue: e.target.value })} />
                    </>)}
                    {src === 'calc' && (<>
                      <button style={{ ...btn, marginTop: 8 }} title="sysUpTime ticks → days / hours / minutes / seconds"
                        onClick={() => patch({ label: curField.label || 'Uptime', calc: { expr: '{ticks} / 100', format: 'duration', decimals: null, inputs: [{ name: 'ticks', oid: '.1.3.6.1.2.1.1.3', sample: '12695600' }] } })}>
                        Preset: Uptime from sysUpTime
                      </button>
                      <label style={lbl}>Kind</label>
                      <select style={inp} value={isTpl ? 'template' : 'calc'} onChange={(e) => setCalc(e.target.value === 'template' ? { template: curField.calc?.template ?? '{value}' } : { template: null })}>
                        <option value="calc">Calculation (a number: uptime, percent, Mbps…)</option>
                        <option value="template">Text template (several values, e.g. 77 ( 6335 MHz ))</option>
                      </select>
                      {isTpl ? (<>
                        <label style={lbl}>Template — {'{name}'} = a device value; {'[[ expr ]]'} or {'[[ expr | duration | 2 ]]'} = a calculation</label>
                        <input style={{ ...inp, fontFamily: 'monospace' }} value={curField.calc?.template ?? ''} placeholder="{ch} ( [[5950 + 5*{ch}]] MHz )" onChange={(e) => setCalc({ template: e.target.value })} />
                        <label style={lbl}>If the template cannot be computed (a value is missing or not a number), show</label>
                        <input style={{ ...inp, fontFamily: 'monospace' }} value={curField.calc?.fallback ?? ''} placeholder="{ch}  (leave empty to show “—”)" onChange={(e) => setCalc({ fallback: e.target.value || null })} />
                      </>) : (<>
                        <label style={lbl}>Expression — use {'{input}'}, + - * / %, ( ), round(x,n) floor ceil abs min max if(c,a,b)</label>
                        <input style={{ ...inp, fontFamily: 'monospace' }} value={curField.calc?.expr ?? ''} placeholder="{ticks} / 100" onChange={(e) => setCalc({ expr: e.target.value })} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 2 }}><label style={lbl}>Show result as</label>
                            <select style={inp} value={curField.calc?.format ?? 'none'} onChange={(e) => setCalc({ format: e.target.value })}>
                              <option value="none">Number</option><option value="duration">Duration (seconds → 1d 2h 3m 4s)</option><option value="duration-short">Duration, short (1d 2h 3m)</option>
                              <option value="bytes">Bytes (KB / MB / GB)</option><option value="percent">Percent</option><option value="mbps">Mbps (bits/s in)</option>
                            </select></div>
                          <div style={{ flex: 1 }}><label style={lbl}>Decimals</label>
                            <input style={inp} type="number" min={0} max={6} value={curField.calc?.decimals ?? ''} onChange={(e) => setCalc({ decimals: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                        </div>
                      </>)}
                      <label style={lbl}>Device values (read from each device · empty markers -1 / -NA- count as no value)</label>
                      {inputs.map((i, k) => (
                        <InputRow key={k} i={i} objects={headerObjects}
                          onChange={(n) => setCalc({ inputs: inputs.map((x, j) => (j === k ? n : x)) })}
                          onRemove={() => setCalc({ inputs: inputs.filter((_, j) => j !== k) })} />
                      ))}
                      <button style={btn} onClick={() => setCalc({ inputs: [...inputs, { name: `v${inputs.length + 1}`, oid: '', sample: '' }] })}>+ Add input</button>
                      {unknown.length > 0 && <div style={{ fontSize: 11, color: 'var(--vf-danger)', marginTop: 4 }}>Not defined as an input: {unknown.map((n) => `{${n}}`).join(', ')}</div>}
                      {res && <div style={{ fontSize: 12, marginTop: 6, padding: 6, borderRadius: 6, background: 'var(--vf-canvas)', border: '1px solid var(--vf-border-subtle)', color: res.ok ? 'var(--vf-text-primary)' : 'var(--vf-danger)' }}>
                        Preview: <b>{res.ok ? res.text : res.error}</b>
                      </div>}
                      <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 4 }}>The gateway evaluates this on every Node View refresh using the live values of the inputs.</div>
                    </>)}
                  </>);
                })()}

                {bindable && (<>
                  {(curField.valueSource ?? 'mib') === 'mib' && (<>
                  <label style={lbl}>MIB binding</label>
                  {curField.mibObject ? (
                    <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                      <div><b>{curField.mibObject}</b></div>
                      <div style={{ color: 'var(--vf-text-muted)', wordBreak: 'break-all' }}>{curField.oid}</div>
                      <div>{[curField.syntax, curField.units, curField.access].filter(Boolean).join(' · ')}</div>
                      <button style={{ ...btn, marginTop: 4 }} onClick={() => patch({ mibObject: undefined, oid: undefined, syntax: undefined })}>Unset binding</button>
                    </div>
                  ) : <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>Not bound to a MIB object.</div>}
                  <label style={lbl}>{curField.mibObject ? 'Rebind to another MIB object' : 'Bind to a MIB object'}</label>
                  <select style={inp} value="" onChange={(e) => {
                    const o = (draft.selectedObjects ?? []).find((x) => x.name === e.target.value);
                    if (!o) return;
                    const f = objectToField(o, curField.order);
                    patch({ mibObject: f.mibObject, oid: f.oid, syntax: f.syntax, access: f.access, units: f.units ?? curField.units, enumMap: f.enumMap, widget: f.widget, elementType: f.elementType });
                  }}>
                    <option value="">Choose from the MIB objects ({(draft.selectedObjects ?? []).length})…</option>
                    {(draft.selectedObjects ?? []).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                  </select>
                  </>)}

                  <label style={lbl}>Widget</label>
                  <select style={inp} value={curField.widget ?? ''} onChange={(e) => patch({ widget: e.target.value })}>
                    {!ALL_WIDGETS.includes(curField.widget ?? '') && <option value={curField.widget}>{curField.widget}</option>}
                    {ALL_WIDGETS.map((w) => <option key={w}>{w}</option>)}
                  </select>
                  <label style={lbl}>Access</label>
                  <select style={inp} value={curField.access ?? 'read-only'} onChange={(e) => patch({ access: e.target.value as UiDescriptorField['access'] })}>
                    <option value="read-only">read-only</option><option value="read-write">read-write</option><option value="not-accessible">not-accessible</option>
                  </select>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}><label style={lbl}>Min</label>
                      <input style={inp} type="number" value={curField.minValue ?? ''} onChange={(e) => patch({ minValue: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
                    <div style={{ flex: 1 }}><label style={lbl}>Max</label>
                      <input style={inp} type="number" value={curField.maxValue ?? ''} onChange={(e) => patch({ maxValue: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}><label style={lbl}>Poll interval (s)</label>
                      <input style={inp} type="number" min={1} value={curField.pollInterval ?? 30} onChange={(e) => patch({ pollInterval: Number(e.target.value) })} /></div>
                    <div style={{ flex: 1 }}><label style={lbl}>Write mode</label>
                      <select style={inp} value={curField.writeMode ?? 'apply-button'} onChange={(e) => patch({ writeMode: e.target.value as UiDescriptorField['writeMode'] })}>
                        <option value="apply-button">Apply button</option><option value="direct">Direct</option>
                      </select></div>
                  </div>
                  <label style={lbl}>Hint after the control, e.g. (1-32) characters</label>
                  <input style={inp} value={curField.helpText ?? ''} onChange={(e) => patch({ helpText: e.target.value })} />
                  <label style={lbl}>Units</label>
                  <input style={inp} value={curField.units ?? ''} onChange={(e) => patch({ units: e.target.value })} />
                  <label style={lbl}>Values that mean “no value” (shown as —)</label>
                  <input style={inp} placeholder="default: -1, -NA-, NA, -   ·   type  none  to show them as they are"
                    value={curField.emptyValues === undefined ? '' : curField.emptyValues.join(', ')}
                    onChange={(e) => { const t = e.target.value.trim(); patch({ emptyValues: t === '' ? undefined : (t.toLowerCase() === 'none' ? [] : t.split(',').map((x) => x.trim()).filter(Boolean)) }); }} />
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, marginTop: 8 }}>
                    <input type="checkbox" checked={!!curField.uiHideWhenEmpty} onChange={(e) => patch({ uiHideWhenEmpty: e.target.checked || undefined })} /> Hide this row when the device has no value (rows the device UI hides by radio mode)
                  </label>
                  <label style={lbl}>Show this row only when… (one rule per line: <b>Field label = raw1, raw2</b> or <b>Field label != raw</b>; add <b>(required)</b> to hide the row too while that field has no value)</label>
                  {(() => {
                    const derived = (curField.uiShowWhen ?? []).map((c) => { const sib = curSection?.fields.find((x) => x.fieldId === c.field); return `${sib?.label ?? c.field} ${c.in ? '=' : '!='} ${(c.in ?? c.notIn ?? []).join(', ')}${c.required ? ' (required)' : ''}`; }).join('\n');
                    const text = showWhenDraft?.id === curField.fieldId ? showWhenDraft.text : derived;
                    const { bad } = parseShowWhen(text, curSection?.fields ?? [], curField.fieldId);
                    return (<>
                      <textarea style={{ ...inp, height: 54, fontFamily: 'monospace' }} placeholder="e.g.  Radio Mode = ap    (rows the device UI shows only for a BTS radio)"
                        value={text}
                        onChange={(e) => {
                          // commit as you type: the draft turns "unsaved" at once, so Save works without leaving the box first
                          const t = e.target.value;
                          setShowWhenDraft({ id: curField.fieldId, text: t });
                          const { rules } = parseShowWhen(t, curSection?.fields ?? [], curField.fieldId);
                          patch({ uiShowWhen: rules.length ? rules : undefined });
                        }}
                        onBlur={() => { if (bad.length === 0) setShowWhenDraft(null); }} />
                      {bad.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--vf-warning, #b7791f)', marginTop: 3 }}>
                          Not saved — no field with that label in this section: {bad.map((b) => `“${b}”`).join(', ')}. Use <b>Field label = value</b> with a label exactly as shown in this section.
                        </div>
                      )}
                    </>);
                  })()}
                  {curField.optionsBy && (
                    <div style={{ marginTop: 8, padding: '6px 8px', border: '1px solid var(--vf-border-subtle)', borderRadius: 5, fontSize: 11 }}>
                      <b>Options follow other fields</b>
                      <div style={{ marginTop: 3 }}>
                        Depends on: {curField.optionsBy.dependsOn.map((id) => curSection?.fields.find((x) => x.fieldId === id)?.label ?? id).join(' → ')}
                        {' · '}{Object.keys(curField.optionsBy.table).length} combination(s)
                        {curField.optionsBy.resetOnChange ? ` · resets to “${curField.optionsBy.resetTo ?? 'first option'}” when they change` : ''}
                      </div>
                      <button style={{ ...btn, marginTop: 5 }} onClick={() => patch({ optionsBy: undefined })}>Remove</button>
                      <div style={{ marginTop: 3, color: 'var(--vf-text-muted)' }}>The lists come from the device (crawled) and are set by <code>apply_dependent_options.py</code>.</div>
                    </div>
                  )}
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, marginTop: 8 }}>
                    <input type="checkbox" checked={!!curField.confirmWrite} onChange={(e) => patch({ confirmWrite: e.target.checked })} /> Ask for confirmation before writing
                  </label>
                  <label style={lbl}>Dropdown options (value=label per line)</label>
                  <textarea style={{ ...inp, height: 70, fontFamily: 'monospace' }} value={enumToText(curField.enumMap)}
                    onChange={(e) => patch({ enumMap: textToEnum(e.target.value, curField.enumMap) })} />
                  {curField.elementType === 'table-block' && (<>
                    <label style={lbl}>Table columns (auto, or comma-separated)</label>
                    <input style={inp} value={String((curField.enumMap as Record<string, unknown> | undefined)?.columns ?? 'auto')}
                      onChange={(e) => patch({ enumMap: { ...(curField.enumMap || {}), columns: e.target.value } as Record<string, string> })} />
                  </>)}
                  {(curField.valueSource ?? 'mib') === 'mib' && (<>
                  <label style={lbl}>OID</label>
                  <input style={{ ...inp, fontFamily: 'monospace' }} value={curField.oid ?? ''} onChange={(e) => patch({ oid: e.target.value })} />
                  <label style={lbl}>Row type</label>
                  <select style={inp} value={curField.elementType} onChange={(e) => patch({ elementType: e.target.value as UiDescriptorField['elementType'] })}>
                    <option value="field-label">Form row / value</option><option value="table-block">Table column</option>
                  </select>
                  </>)}
                </>)}

                <label style={lbl}>Move to section</label>
                <select style={inp} value={curSection.sectionId} onChange={(e) => moveFieldTo(curSection.sectionId, curField.fieldId, e.target.value)}>
                  {draft.sections.map((s) => <option key={s.sectionId} value={s.sectionId}>{pageOf(s, draft.screenName)} › {parentOf(s)} › {tabOf(s)} · {s.title}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button style={btn} onClick={() => moveField(curSection.sectionId, curField.fieldId, -1)}>↑ Up</button>
                  <button style={btn} onClick={() => moveField(curSection.sectionId, curField.fieldId, 1)}>↓ Down</button>
                  <button style={{ ...btn, color: 'var(--vf-danger)' }} onClick={() => deleteField(curSection.sectionId, curField.fieldId)}>Remove</button>
                </div>
              </div>
              );
            })()}

            <div style={box}>
              <div style={h3}>New section</div>
              <label style={lbl}>Page</label>
              <input style={inp} value={newSec.page} placeholder={path.page} onChange={(e) => setNewSec({ ...newSec, page: e.target.value })} />
              <label style={lbl}>Parent</label>
              <input style={inp} value={newSec.parent} placeholder={path.parent} onChange={(e) => setNewSec({ ...newSec, parent: e.target.value })} />
              <label style={lbl}>Tab</label>
              <input style={inp} value={newSec.tab} placeholder="Properties" onChange={(e) => setNewSec({ ...newSec, tab: e.target.value })} />
              <button style={{ ...btn, marginTop: 8 }} onClick={addSection}>Add section</button>
            </div>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
};

export default V2MibBuilderV2Page;

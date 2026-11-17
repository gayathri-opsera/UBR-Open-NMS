/**
 * MibLibraryPanel — the "MIB Library" step of the classic builder, inside v2: upload a MIB, browse its objects as a
 * tree grouped by MIB section, drag objects onto the screen (or add / bind them with the buttons), remove objects.
 */
import React, { useMemo, useRef, useState } from 'react';
import { extractApiError, parseMibFile } from '../../api/productDefinitions.api';
import type { MibObjectSummary, ParseMibResult } from '../../api/productDefinitions.api';

const inp: React.CSSProperties = { width: '100%', fontSize: 12, padding: '5px 7px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', boxSizing: 'border-box' };
const btn: React.CSSProperties = { fontSize: 11, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', cursor: 'pointer' };
const MAX_ROWS = 400;

export interface MibLibraryPanelProps {
  objects: MibObjectSummary[];
  usedNames: Set<string>;
  targetLabel: string;                    // "Wireless › Radio 1 › Properties" or '' when no section selected
  selectedFieldLabel?: string;            // label of the field selected in the preview (for "Bind to selected field")
  parseInfo?: ParseMibResult | null;      // last upload, for the module / statistics / warnings summary
  onParsed: (r: ParseMibResult) => void;
  onAddToSection: (objs: MibObjectSummary[]) => void;
  onArrange: (objs: MibObjectSummary[]) => void;
  onBindToSelected?: (obj: MibObjectSummary) => void;
  onRemove: (names: string[]) => void;
}

const MibLibraryPanel: React.FC<MibLibraryPanelProps> = ({
  objects, usedNames, targetLabel, selectedFieldLabel, parseInfo, onParsed, onAddToSection, onArrange, onBindToSelected, onRemove,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'unused' | 'scalar' | 'table' | 'rw'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setMsg('');
    try {
      const r = await parseMibFile(file);
      onParsed(r);
      setMsg(`${r.moduleName}: ${r.statistics?.totalObjects ?? r.objects.length} objects${r.warnings?.length ? ` · ${r.warnings.length} warning(s)` : ''}`);
    } catch (e) {
      setMsg(`Parse failed: ${extractApiError(e)?.error?.message ?? 'unknown error'}`);
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return objects.filter((o) => {
      if (kind === 'unused' && usedNames.has(o.name)) return false;
      if (kind === 'scalar' && o.indexType !== 'SCALAR') return false;
      if (kind === 'table' && o.indexType === 'SCALAR') return false;
      if (kind === 'rw' && !o.access.toLowerCase().includes('write')) return false;
      return !t || o.name.toLowerCase().includes(t) || (o.oid ?? '').includes(t) || (o.section ?? '').toLowerCase().includes(t);
    });
  }, [objects, q, kind, usedNames]);

  const groups = useMemo(() => {
    const m = new Map<string, MibObjectSummary[]>();
    for (const o of rows.slice(0, MAX_ROWS)) { const k = (o.section || 'general').trim(); if (!m.has(k)) m.set(k, []); m.get(k)!.push(o); }
    return [...m.entries()];
  }, [rows]);
  const totals = useMemo(() => {
    const m = new Map<string, { on: number; all: number }>();
    for (const o of objects) { const k = (o.section || 'general').trim(); const t = m.get(k) ?? { on: 0, all: 0 }; t.all++; if (usedNames.has(o.name)) t.on++; m.set(k, t); }
    return m;
  }, [objects, usedNames]);

  const chosen = objects.filter((o) => picked.has(o.name));
  const toggle = (n: string) => setPicked((p) => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  const searching = q.trim() !== '';
  const on = objects.filter((o) => usedNames.has(o.name)).length;

  return (
    <div>
      <div style={{ border: '1px dashed var(--vf-border-default)', borderRadius: 8, padding: 10, marginBottom: 10 }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files?.[0]); }}>
        <input ref={fileRef} type="file" accept=".mib,.my,.txt,.smi" style={{ display: 'none' }} onChange={(e) => void upload(e.target.files?.[0])} />
        <button style={btn} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Parsing…' : 'Upload MIB file'}</button>
        <span style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginLeft: 8 }}>.mib / .my / .txt — or drop here. Objects are added to this screen.</span>
        {msg && <div style={{ fontSize: 11, marginTop: 6, color: msg.startsWith('Parse failed') ? 'var(--vf-danger)' : 'var(--vf-text-secondary)' }}>{msg}</div>}
        {parseInfo && (
          <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6, color: 'var(--vf-text-secondary)' }}>
            <div><b>{parseInfo.moduleName}</b>{parseInfo.vendor ? ` · ${parseInfo.vendor}` : ''}{parseInfo.productLine ? ` · ${parseInfo.productLine}` : ''}{parseInfo.enterpriseOid ? ` · ${parseInfo.enterpriseOid}` : ''}</div>
            {parseInfo.statistics && <div>{parseInfo.statistics.totalObjects} objects · {parseInfo.statistics.scalarCount} scalar · {parseInfo.statistics.singleIndexCount + parseInfo.statistics.doubleIndexCount + parseInfo.statistics.tripleIndexCount} table columns · {parseInfo.statistics.enumCount} enums</div>}
            {parseInfo.warnings && parseInfo.warnings.length > 0 && (
              <details><summary style={{ cursor: 'pointer', color: 'var(--vf-warning, #b7791f)' }}>{parseInfo.warnings.length} warning(s)</summary>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{parseInfo.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
          </div>
        )}
      </div>

      <input style={inp} placeholder="Search name, OID or MIB section…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '6px 0' }}>
        {([['all', 'All'], ['unused', 'Not on screen'], ['scalar', 'Scalars'], ['table', 'Table columns'], ['rw', 'Writable']] as const).map(([k, l]) => (
          <button key={k} style={{ ...btn, ...(kind === k ? { borderColor: 'var(--vf-accent)', color: 'var(--vf-accent)' } : {}) }} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginBottom: 4 }}>
        {objects.length ? <><b style={{ color: 'var(--vf-success)' }}>{on}</b> / {objects.length} on screen · showing {Math.min(rows.length, MAX_ROWS)} of {rows.length}{rows.length > MAX_ROWS ? ' (refine the search)' : ''} · drag an object onto the screen</> : 'No MIB loaded yet — upload one above.'}
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--vf-border-subtle)', borderRadius: 6 }}>
        {groups.map(([sec, objs]) => {
          const isOpen = searching || open.has(sec);
          const t = totals.get(sec) ?? { on: 0, all: objs.length };
          return (
            <div key={sec}>
              <button type="button" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(sec)) n.delete(sec); else n.add(sec); return n; })}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '5px 8px', border: 0, borderBottom: '1px solid var(--vf-border-subtle)', background: 'var(--vf-surface)', cursor: 'pointer', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--vf-text-secondary)' }}>
                <span style={{ fontSize: 8 }}>{isOpen ? '▼' : '▶'}</span>
                <span style={{ flex: 1 }}>{sec}</span>
                <span style={{ fontWeight: 400, color: t.on === t.all ? 'var(--vf-success)' : 'var(--vf-text-muted)' }}>{t.on}/{t.all}</span>
              </button>
              {isOpen && objs.map((o) => (
                <label key={o.name} draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'mib-object', name: o.name })); e.dataTransfer.effectAllowed = 'copy'; }}
                  style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '5px 8px 5px 16px', borderBottom: '1px solid var(--vf-border-subtle)', fontSize: 11, cursor: 'grab', background: usedNames.has(o.name) ? 'var(--vf-success-subtle)' : 'transparent' }}>
                  <input type="checkbox" checked={picked.has(o.name)} onChange={() => toggle(o.name)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ wordBreak: 'break-all', fontFamily: 'var(--vf-font-mono)' }}>{o.name}</b>{usedNames.has(o.name) && <span style={{ color: 'var(--vf-success)' }}> ✓</span>}
                    <div style={{ color: 'var(--vf-text-muted)', fontSize: 10 }}>{o.indexType === 'SCALAR' ? 'scalar' : 'table col'} · {o.access}{o.isEnum ? ` · enum(${o.enumValueCount})` : ''}</div>
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button style={btn} onClick={() => setPicked(new Set(rows.slice(0, MAX_ROWS).map((o) => o.name)))} disabled={!rows.length}>Select all shown</button>
        <button style={btn} onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
        <button style={{ ...btn, color: 'var(--vf-danger)' }} disabled={!chosen.length}
          title="Remove the ticked objects from this screen's MIB list (fields already on the screen keep their binding)"
          onClick={() => { if (window.confirm(`Remove ${chosen.length} object(s) from the MIB list?`)) { onRemove(chosen.map((o) => o.name)); setPicked(new Set()); } }}>
          Remove {chosen.length || ''}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button style={{ ...btn, background: 'var(--vf-accent)', color: '#fff', borderColor: 'var(--vf-accent)' }} disabled={!chosen.length || !targetLabel}
          title={targetLabel ? '' : 'Select a section in the preview first'}
          onClick={() => { onAddToSection(chosen); setPicked(new Set()); }}>
          Add {chosen.length || ''} to {targetLabel || 'a section'}
        </button>
        <button style={btn} disabled={!chosen.length} onClick={() => { onArrange(chosen); setPicked(new Set()); }}
          title="Create sections from the MIB's own sections (Page › MIB section › sub-section)">
          Auto-arrange {chosen.length || ''}
        </button>
        {onBindToSelected && (
          <button style={btn} disabled={chosen.length !== 1 || !selectedFieldLabel}
            title={selectedFieldLabel ? `Bind the field “${selectedFieldLabel}” to the ticked object` : 'Select a field in the preview, then tick exactly one object'}
            onClick={() => { onBindToSelected(chosen[0]); setPicked(new Set()); }}>
            Bind to selected field{selectedFieldLabel ? ` (${selectedFieldLabel})` : ''}
          </button>
        )}
      </div>
    </div>
  );
};

export default MibLibraryPanel;

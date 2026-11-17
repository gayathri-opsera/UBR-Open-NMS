/**
 * HeaderSourcesEditor — maps the header bar to REAL device data. The design (what is shown and where) is fixed in the
 * builder; every value is filled in from each device when the screen is shown. Typed text is only the preview / fallback.
 */
import React from 'react';
import type { MibObjectSummary } from '../../api/productDefinitions.api';
import type { DataSource, DeviceUiConfig, HeaderRadio } from '../../api/uiBuilder.api';
import { computeSource } from './calcExpr';
import { previewHeader } from './headerPreview';

const inp: React.CSSProperties = { width: '100%', fontSize: 12, padding: '5px 7px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', boxSizing: 'border-box' };
const btn: React.CSSProperties = { fontSize: 11, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', cursor: 'pointer' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--vf-text-muted)', margin: '8px 0 3px', textTransform: 'uppercase', letterSpacing: 0.3 };
const card: React.CSSProperties = { border: '1px solid var(--vf-border-subtle)', borderRadius: 8, padding: 8, marginBottom: 8, background: 'var(--vf-canvas)' };

const mapToText = (m?: Record<string, string>) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
const textToMap = (t: string): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const part of t.split(',')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim()) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return Object.keys(out).length ? out : undefined;
};

type Input = NonNullable<DataSource['inputs']>[number];

/** one device value: name · OID (pick a MIB object or type it) · sample for the preview · optional value map */
export const InputRow: React.FC<{ i: Input; objects: MibObjectSummary[]; onChange: (i: Input) => void; onRemove?: () => void }> = ({ i, objects, onChange, onRemove }) => (
  <div style={{ marginBottom: 6 }}>
    <div style={{ display: 'flex', gap: 4 }}>
      <input style={{ ...inp, width: 64 }} placeholder="name" value={i.name} onChange={(e) => onChange({ ...i, name: e.target.value })} />
      <select style={{ ...inp, width: 96 }} value="" title="Fill the OID from a MIB object" onChange={(e) => { const o = objects.find((x) => x.name === e.target.value); if (o?.oid) onChange({ ...i, oid: o.oid, name: i.name || o.name.replace(/^.*?([A-Z][a-z]+)$/, '$1').toLowerCase() }); }}>
        <option value="">MIB object…</option>{objects.filter((o) => o.oid).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
      </select>
      {onRemove && <button style={btn} title="Remove" onClick={onRemove}>✕</button>}
    </div>
    <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
      <input style={{ ...inp, flex: 2, fontFamily: 'monospace' }} placeholder=".1.3.6.1…" value={i.oid ?? ''} onChange={(e) => onChange({ ...i, oid: e.target.value })} />
      <input style={{ ...inp, flex: 1 }} placeholder="sample" title="Only used by this preview" value={i.sample ?? ''} onChange={(e) => onChange({ ...i, sample: e.target.value })} />
    </div>
    <input style={{ ...inp, marginTop: 3 }} placeholder="show as, e.g. ap=BTS, sta=CPE (optional)" value={mapToText(i.map)} onChange={(e) => onChange({ ...i, map: textToMap(e.target.value) })} />
    <input style={{ ...inp, marginTop: 3, fontFamily: 'monospace' }} placeholder="remove text matching (regex, optional), e.g.  [A-Z]{2,4}(?= \d{4}$)" value={i.strip ?? ''} onChange={(e) => onChange({ ...i, strip: e.target.value || undefined })} />
  </div>
);

const SourceBox: React.FC<{
  title: string; typed: string; onTyped: (v: string) => void; source?: DataSource; onSource: (s?: DataSource) => void; objects: MibObjectSummary[];
  presets: { label: string; source: DataSource | null }[];
}> = ({ title, typed, onTyped, source, onSource, objects, presets }) => {
  const kind = source?.kind ?? 'text';
  const inputs = source?.inputs ?? [];
  const set = (p: Partial<DataSource>) => onSource({ kind: 'template', ...(source ?? {}), ...p } as DataSource);
  const raw = Object.fromEntries(inputs.map((i) => [i.name, i.sample ?? '']));
  const res = source ? computeSource(source, raw) : null;
  return (
    <div style={card}>
      <div style={{ fontSize: 12, fontWeight: 700 }}>{title}</div>
      <label style={lbl}>Value comes from</label>
      <select style={inp} value={kind === 'text' ? 'typed' : kind} onChange={(e) => {
        const v = e.target.value;
        if (v === 'typed') onSource(undefined);
        else if (v === 'template') set({ kind: 'template', template: source?.template ?? '{value}', inputs: inputs.length ? inputs : [{ name: 'value', oid: '' }] });
        else set({ kind: 'calc', expr: source?.expr ?? '{value}', inputs: inputs.length ? inputs : [{ name: 'value', oid: '' }] });
      }}>
        <option value="typed">Typed text (same on every device)</option>
        <option value="template">Device values in a text template</option>
        <option value="calc">Calculation (e.g. uptime)</option>
      </select>
      {presets.some((p) => p.source) && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {presets.filter((p) => p.source).map((p) => <button key={p.label} style={btn} onClick={() => onSource(p.source!)}>{p.label}</button>)}
        </div>
      )}
      {kind === 'text' && (<><label style={lbl}>Text</label><input style={inp} value={typed} onChange={(e) => onTyped(e.target.value)} /></>)}
      {kind === 'template' && (<>
        <label style={lbl}>Template — {'{name}'} is replaced by that device value</label>
        <input style={{ ...inp, fontFamily: 'monospace' }} value={source?.template ?? ''} onChange={(e) => set({ template: e.target.value })} />
      </>)}
      {kind === 'calc' && (<>
        <label style={lbl}>Expression — {'{name}'}, + - * / %, round(x,n) …</label>
        <input style={{ ...inp, fontFamily: 'monospace' }} value={source?.expr ?? ''} onChange={(e) => set({ expr: e.target.value })} />
        <div style={{ display: 'flex', gap: 4 }}>
          <select style={{ ...inp, flex: 2 }} value={source?.format ?? 'none'} onChange={(e) => set({ format: e.target.value })}>
            <option value="none">Number</option><option value="duration">Duration (seconds → 1d 2h 3m 4s)</option><option value="duration-short">Duration, short</option>
            <option value="bytes">Bytes</option><option value="percent">Percent</option><option value="mbps">Mbps</option>
          </select>
        </div>
      </>)}
      {kind !== 'text' && (<>
        <label style={lbl}>Device values (read from each device)</label>
        {inputs.map((i, k) => (
          <InputRow key={k} i={i} objects={objects} onChange={(n) => set({ inputs: inputs.map((x, j) => (j === k ? n : x)) })} onRemove={() => set({ inputs: inputs.filter((_, j) => j !== k) })} />
        ))}
        <button style={btn} onClick={() => set({ inputs: [...inputs, { name: `v${inputs.length + 1}`, oid: '' }] })}>+ device value</button>
        {res && <div style={{ fontSize: 11, marginTop: 6, color: res.ok ? 'var(--vf-text-primary)' : 'var(--vf-danger)' }}>Preview with the samples: <b>{res.ok ? res.text : res.error}</b></div>}
        <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 3 }}>On a device that returns nothing for a value, this shows “—” — never the sample.</div>
      </>)}
    </div>
  );
};

export interface HeaderSourcesEditorProps {
  ui: DeviceUiConfig;
  onChange: (patch: Partial<DeviceUiConfig>) => void;
  /** MIB objects of the screen plus the objects of the fields already placed on it (name + OID) */
  objects: MibObjectSummary[];
}

const HeaderSourcesEditor: React.FC<HeaderSourcesEditorProps> = ({ ui, onChange, objects }) => {
  const obj = (name: string) => objects.find((o) => o.name === name);
  const oidOf = (name: string, fallback = '') => obj(name)?.oid ?? fallback;
  const sources = ui.sources ?? {};
  const setSource = (k: 'productName' | 'versionLine' | 'uptime', s?: DataSource) => {
    const next = { ...sources }; if (s) next[k] = s; else delete next[k];
    onChange({ sources: Object.keys(next).length ? next : undefined });
  };
  const radios = ui.radios ?? [];
  const setRadio = (i: number, p: Partial<HeaderRadio>) => onChange({ radios: radios.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  const pv = previewHeader(ui);

  const presets = {
    productName: [{ label: 'Model from the device', source: obj('sysInventoryModelName') ? { kind: 'template', template: '{model}', inputs: [{ name: 'model', oid: oidOf('sysInventoryModelName'), sample: 'UBR660' }] } as DataSource : null }],
    versionLine: [{
      label: 'Firmware + serial number',
      source: obj('sysInventoryBuildno') && obj('sysInventorySerialNo')
        ? { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw', oid: oidOf('sysInventoryBuildno'), sample: '1.0.0-183' }, { name: 'sn', oid: oidOf('sysInventorySerialNo'), sample: '2641XCT0026K' }] } as DataSource : null,
    }],
    uptime: [{ label: 'Uptime from sysUpTime', source: { kind: 'calc', expr: '{ticks} / 100', format: 'duration', inputs: [{ name: 'ticks', oid: '.1.3.6.1.2.1.1.3', sample: '12695600' }] } as DataSource }],
  };

  /** a radio's badge text + LED from the device's radio table (row = the table row of that radio) */
  const fillRadio = (i: number, row: string, role: 'bts' | 'ap') => {
    const modeBase = oidOf('wirelessRadioMode', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.2');
    const statusBase = oidOf('wirelessRadioStatus', '.1.3.6.1.4.1.14125.123.1.1.1.1.1.33');
    setRadio(i, {
      modeSource: { kind: 'template', template: '{mode}', inputs: [{ name: 'mode', oid: `${modeBase}.${row}`, sample: 'ap', map: role === 'bts' ? { ap: 'BTS', sta: 'CPE' } : { ap: 'AP', sta: 'STA' } }] },
      upSource: { oid: `${statusBase}.${row}`, upValues: ['0'], sample: '0' },
    });
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', margin: '4px 0 8px', lineHeight: 1.5 }}>
        The header is <b>designed here once</b>; each value is read from the device it is shown for. Typed text is only a sample for this preview.
      </div>
      <SourceBox title="Product name" typed={ui.productName ?? ''} onTyped={(v) => onChange({ productName: v })} source={sources.productName} onSource={(s) => setSource('productName', s)} objects={objects} presets={presets.productName} />
      <SourceBox title="Version line" typed={ui.versionLine ?? ''} onTyped={(v) => onChange({ versionLine: v })} source={sources.versionLine} onSource={(s) => setSource('versionLine', s)} objects={objects} presets={presets.versionLine} />
      <SourceBox title="Uptime" typed={ui.uptime ?? ''} onTyped={(v) => onChange({ uptime: v })} source={sources.uptime} onSource={(s) => setSource('uptime', s)} objects={objects} presets={presets.uptime} />

      <div style={{ fontSize: 12, fontWeight: 700, margin: '10px 0 4px' }}>Radio badges</div>
      {radios.map((r, i) => {
        const m = r.modeSource?.inputs?.[0];
        return (
          <div key={i} style={card}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input style={inp} value={r.label} placeholder="Heading, e.g. Radio 1" onChange={(e) => setRadio(i, { label: e.target.value })} />
              <button style={btn} title="Remove this badge" onClick={() => onChange({ radios: radios.filter((_, k) => k !== i) })}>✕</button>
            </div>
            <label style={lbl}>Fill from the device’s radio table</label>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11 }}>table row</span>
              <input id={`row-${i}`} style={{ ...inp, width: 50 }} defaultValue={String(i === 0 ? 2 : i === 1 ? 1 : 3)} />
              <button style={btn} title="Badge text: BTS / CPE" onClick={() => fillRadio(i, (document.getElementById(`row-${i}`) as HTMLInputElement).value, 'bts')}>Fill (BTS/CPE)</button>
              <button style={btn} title="Badge text: AP / STA" onClick={() => fillRadio(i, (document.getElementById(`row-${i}`) as HTMLInputElement).value, 'ap')}>Fill (AP/STA)</button>
            </div>
            <label style={lbl}>Badge text (from the device)</label>
            {m ? <InputRow i={m} objects={objects} onChange={(n) => setRadio(i, { modeSource: { ...(r.modeSource as DataSource), inputs: [n] } })} />
              : <input style={inp} placeholder="typed text, e.g. AP (same on every device)" value={r.mode} onChange={(e) => setRadio(i, { mode: e.target.value })} />}
            {m && <button style={btn} onClick={() => setRadio(i, { modeSource: undefined })}>Use typed text instead</button>}
            <label style={lbl}>LED is green when this OID’s value is…</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={{ ...inp, flex: 2, fontFamily: 'monospace' }} placeholder="status OID, e.g. …1.33.2" value={r.upSource?.oid ?? ''}
                onChange={(e) => setRadio(i, { upSource: { upValues: r.upSource?.upValues ?? ['0'], sample: r.upSource?.sample, oid: e.target.value } })} />
              <input style={{ ...inp, flex: 1 }} placeholder="0" title="Values that count as up, comma-separated" value={(r.upSource?.upValues ?? ['0']).join(', ')}
                onChange={(e) => setRadio(i, { upSource: { oid: r.upSource?.oid ?? '', sample: r.upSource?.sample, upValues: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
            </div>
            {r.modeSource && <div style={{ fontSize: 10, color: 'var(--vf-text-muted)', marginTop: 3 }}>A device without this radio (no value for the badge text) does not show this badge. Preview: <b>{pv.radios[i]?.label} · {pv.radios[i]?.mode}</b></div>}
          </div>
        );
      })}
      {radios.length < 3 && <button style={btn} onClick={() => onChange({ radios: [...radios, { label: `Radio ${radios.length + 1}`, mode: 'AP', up: false }] })}>+ Radio badge</button>}
    </div>
  );
};

export default HeaderSourcesEditor;

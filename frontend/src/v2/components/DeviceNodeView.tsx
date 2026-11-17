/**
 * DeviceNodeView — Node View in the device's own look for screens built in Custom UI Builder v2.
 * A thin adapter: wireframe groups → the renderer's sections, live values / edits / Save → its runtime binding.
 * All the state (polling, live refresh, edits, Apply) stays in NodeViewParameters; nothing is duplicated here.
 */
import React, { useMemo, useState } from 'react';
import type { DeviceUiConfig, ResolvedHeader, UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import type { NodeViewValues, ParameterValueRecord, WireframeGroup, WireframeParameter } from '../../api/nodeView.types';
import { valueKey } from '../../api/nodeView.types';
import { isEmptyRaw } from '../deviceui/calcExpr';
import DeviceUiView from '../deviceui/DeviceUiView';
import type { DeviceUiRuntime } from '../deviceui/DeviceUiView';
import { firstPath, buildDeviceTree, resolvePath } from '../deviceui/deviceUiModel';
import type { ActivePath } from '../deviceui/deviceUiModel';

const editKey = (g: string, p: string, i: string) => `${g}::${p}::${i}`;

/** wireframe → the renderer's section/field shape (+ lookup from the renderer's field back to the wireframe parameter) */
export function wireframeToSections(groups: WireframeGroup[]): { sections: UiDescriptorSection[]; paramOf: Map<string, WireframeParameter> } {
  const paramOf = new Map<string, WireframeParameter>();
  const sections: UiDescriptorSection[] = [...groups].filter((g) => g.groupId !== '__header').sort((a, b) => a.displayOrder - b.displayOrder).map((g, gi) => {
    const fields: UiDescriptorField[] = [];
    for (const p of g.parameters) {
      if (p.hidden) continue;
      const fid = p.fieldId || p.parameterId;
      paramOf.set(`${g.groupId}::${fid}`, p);
      fields.push({
        fieldId: fid,
        elementType: p.elementType === 'table-block' ? 'table-block' : 'field-label',
        label: p.displayName,
        mibObject: p.parameterId,
        oid: p.snmpOid ?? undefined,
        widget: p.uiWidget ?? undefined,
        access: p.readOnly ? 'read-only' : 'read-write',
        helpText: p.description ?? undefined,
        units: p.unit ?? undefined,
        valueSource: p.valueSource ?? undefined,
        emptyValues: p.emptyValues,
        staticValue: p.staticValue ?? undefined,
        minValue: p.minValue ?? undefined,
        maxValue: p.maxValue ?? undefined,
        enumMap: p.options?.length ? Object.fromEntries(p.options.map((o) => [o.value, o.label])) : undefined,
        order: p.uiOrder ?? p.displayOrder,
      });
    }
    for (const it of g.layoutItems ?? []) {
      fields.push({ fieldId: it.fieldId, elementType: it.elementType, label: it.label, order: it.uiOrder });
    }
    const writable = g.parameters.some((p) => !p.hidden && !p.readOnly && !!p.snmpOid);
    return {
      sectionId: g.groupId, title: g.label, columns: 2, order: gi,
      writeMode: writable ? 'apply-button' : 'read-only',
      uiPage: g.uiPage, uiParent: g.uiParent, uiTab: g.uiTab,
      uiTitle: g.uiTitle || undefined, uiNote: g.uiNote || undefined,
      uiLayout: (g.uiLayout || undefined) as UiDescriptorSection['uiLayout'],
      uiColumn: (g.uiColumn || undefined) as UiDescriptorSection['uiColumn'],
      uiHideWhenEmpty: g.uiHideWhenEmpty || undefined,
      uiMatrix: g.uiMatrix ?? undefined,
      fields,
    };
  });
  return { sections, paramOf };
}

/** option label for a raw value ("0" → "enable"), or null when the field has no such option */
const labelOf = (f: UiDescriptorField, raw: string | null): string | null => (raw != null && f.enumMap && f.enumMap[raw] != null ? String(f.enumMap[raw]) : null);

/** a unit after a read-only value (42.0 → "42.0 °C", 0 → "0 %"), like the device's own pages */
const withUnit = (f: UiDescriptorField, t: string | null): string | null => (t != null && t !== '' && f.units && f.valueSource !== 'calc' && f.valueSource !== 'static' ? `${t} ${f.units}` : t);

/** "No value" markers (-1, -NA-, NA, -) — unless the field gives that value a label of its own (Radio 2 status -1 → Disabled) */
const noValue = (f: UiDescriptorField, raw: string | null): boolean => (f.valueSource === 'static' || f.valueSource === 'calc') ? false : (labelOf(f, raw) == null && isEmptyRaw(raw, f.emptyValues));

const firstRaw = (r?: ParameterValueRecord) => (r ? (r.value ?? r.instances?.[0]?.value ?? null) : null);
const firstShown = (r?: ParameterValueRecord) => (r ? (r.display ?? r.value ?? r.instances?.[0]?.display ?? r.instances?.[0]?.value ?? null) : null);

export interface DeviceNodeViewProps {
  screenName: string;
  wireframe: WireframeGroup[];
  deviceUi?: DeviceUiConfig | null;
  /** the header resolved from this device's own values (name, version, uptime, radio badges) */
  header?: ResolvedHeader | null;
  values: NodeViewValues;
  canEdit: boolean;
  edits: Record<string, string>;
  errors: Record<string, string>;
  pendingFor: (groupId: string) => number;
  onEdit: (key: string, value: string, original: string | null) => void;
  applying: boolean;
  onApplyGroups: (groupIds: string[]) => void;
  onRevertGroups: (groupIds: string[]) => void;
  collectedAt?: string | null;
  pollStatus?: string;
  refreshing: boolean;
  onRefresh: () => void;
}

export const DeviceNodeView: React.FC<DeviceNodeViewProps> = ({
  screenName, wireframe, deviceUi, header, values, canEdit, edits, errors, pendingFor, onEdit, applying,
  onApplyGroups, onRevertGroups, collectedAt, pollStatus, refreshing, onRefresh,
}) => {
  const { sections, paramOf } = useMemo(() => wireframeToSections(wireframe), [wireframe]);
  const [active, setActive] = useState<ActivePath>(() => firstPath(buildDeviceTree(screenName, sections)));
  const path = useMemo(() => resolvePath(buildDeviceTree(screenName, sections), active), [screenName, sections, active]);

  const rec = (sid: string, f: UiDescriptorField): ParameterValueRecord | undefined => {
    const p = paramOf.get(`${sid}::${f.fieldId}`);
    return p ? values[valueKey(sid, p.parameterId)] : undefined;
  };
  const keyOf = (sid: string, f: UiDescriptorField) => {
    const p = paramOf.get(`${sid}::${f.fieldId}`);
    return p ? editKey(sid, p.parameterId, '') : '';
  };

  const runtime: DeviceUiRuntime = {
    canEdit,
    rawValue: (sid, f) => { const raw = firstRaw(rec(sid, f)); return noValue(f, raw) ? null : raw; },
    // a value with option labels (enable/disable, ptp/ptmp…) shows the label alone, as the device's own UI does
    display: (sid, f) => { const r = rec(sid, f); const raw = firstRaw(r); return noValue(f, raw) ? null : withUnit(f, labelOf(f, raw) ?? firstShown(r)); },
    rows: (sid, f) => {
      const r = rec(sid, f);
      if (!r) return [];
      if (r.instances?.length) return r.instances.filter((i) => !noValue(f, i.value)).map((i) => ({ index: i.index, text: withUnit(f, labelOf(f, i.value) ?? i.display ?? i.value) ?? '' }));
      const raw = firstRaw(r);
      const one = noValue(f, raw) ? null : withUnit(f, labelOf(f, raw) ?? firstShown(r));
      return one == null ? [] : [{ index: '', text: one }];
    },
    edited: (sid, f) => edits[keyOf(sid, f)],
    onEdit: (sid, f, v) => onEdit(keyOf(sid, f), v, firstRaw(rec(sid, f))),
    error: (sid, f) => errors[keyOf(sid, f)],
    stale: (sid, f) => { const r = rec(sid, f); return r?.freshnessState === 'STALE' || r?.freshnessState === 'FAILED'; },
    pending: (sids) => sids.reduce((n, sid) => n + pendingFor(sid), 0),
    applying,
    onApply: onApplyGroups,
    onRevert: onRevertGroups,
    ready: Object.keys(values).length > 0,
    byField: (fid) => {
      for (const [k, p] of paramOf) {
        if (!k.endsWith(`::${fid}`)) continue;
        const sid = k.slice(0, k.length - fid.length - 2);
        return firstShown(values[valueKey(sid, p.parameterId)]);
      }
      return null;
    },
  };

  const status = pollStatus && pollStatus !== 'OK' ? pollStatus : null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--vf-text-muted)', padding: '4px 2px 8px' }}>
        <span>{collectedAt ? `Last read ${new Date(collectedAt).toLocaleTimeString()}` : 'No reading yet'}</span>
        {status && <span style={{ color: 'var(--vf-warning, #b7791f)' }}>· {status}</span>}
        <button type="button" onClick={onRefresh} disabled={refreshing}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--vf-border-subtle)', background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)', cursor: 'pointer' }}>
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>
      <div style={{ overflowX: 'auto', borderRadius: 8 }}>
        <DeviceUiView screenName={screenName} sections={sections} deviceUi={deviceUi} header={header ?? undefined} active={path} onActiveChange={setActive} runtime={runtime} />
      </div>
    </div>
  );
};

export default DeviceNodeView;

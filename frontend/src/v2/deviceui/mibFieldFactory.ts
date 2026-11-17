/**
 * MIB object → builder field, mirroring the classic Custom UI Builder's rules (widget suggestion, access, enum map)
 * so a screen built from scratch in v2 binds objects exactly the same way.
 */
import type { MibObjectSummary } from '../../api/productDefinitions.api';
import type { UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import { newId } from './deviceUiModel';

export function normalizeAccess(access: string): UiDescriptorField['access'] {
  const a = (access || '').toLowerCase();
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

export function objectToField(obj: MibObjectSummary, order: number): UiDescriptorField {
  const enumMap = obj.isEnum && obj.enumValues ? { ...obj.enumValues } : undefined;
  return {
    fieldId: newId('f'),
    elementType: obj.indexType !== 'SCALAR' ? 'table-block' : 'field-label',
    label: obj.name,
    labelLevel: 'field',
    mibObject: obj.name,
    oid: obj.oid ?? undefined,
    syntax: obj.nmsDataType,
    access: normalizeAccess(obj.access),
    widget: suggestWidget(obj),
    units: obj.units || undefined,
    pollInterval: 30,
    enumMap,
    order,
  };
}

const titleCase = (t: string) => t.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/**
 * Place objects on the screen: one section per MIB sub-section, grouped Page (screen) › Parent (MIB section) › Tab
 * (MIB sub-section). Objects already on the screen are skipped. Existing sections with the same path are reused.
 */
export function arrangeObjects(
  screen: string, existing: UiDescriptorSection[], objects: MibObjectSummary[], defaultPoll = 30,
): UiDescriptorSection[] {
  const used = new Set(existing.flatMap((s) => s.fields.map((f) => f.mibObject)));
  const out = existing.map((s) => ({ ...s, fields: [...s.fields] }));
  for (const o of objects) {
    if (used.has(o.name)) continue;
    const parent = titleCase(o.section || 'General');
    const sub = (o.subSection || '').split('.').pop() || '';
    const tab = titleCase(sub && sub.toLowerCase() !== (o.section || '').toLowerCase() ? sub : parent);
    let sec = out.find((s) => (s.uiPage || screen) === screen && s.uiParent === parent && s.uiTab === tab);
    if (!sec) {
      sec = { sectionId: newId('s'), title: tab, columns: 2, pollInterval: defaultPoll, writeMode: 'read-only', uiPage: screen, uiParent: parent, uiTab: tab, fields: [], order: out.length };
      out.push(sec);
    }
    const f = objectToField(o, sec.fields.length);
    sec.fields.push(f);
    if (f.access === 'read-write') sec.writeMode = 'apply-button';
    used.add(o.name);
  }
  return out;
}

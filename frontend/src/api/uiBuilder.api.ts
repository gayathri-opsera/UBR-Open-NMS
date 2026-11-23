import { apiClient } from './client';
import type { MibObjectSummary } from './productDefinitions.api';

export type { MibObjectSummary };

export interface UiDescriptorField {
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
  enumMap?: Record<string, string>;
  /** Where the value comes from: MIB parameter (default), fixed text, or a calculation over device values. */
  valueSource?: 'mib' | 'static' | 'calc';
  staticValue?: string;
  calc?: { expr: string; template?: string | null; fallback?: string | null; format?: string; decimals?: number | null; inputs?: { name: string; oid: string; sample?: string; map?: Record<string, string>; strip?: string; emptyValues?: string[] }[] };
  /** Values that mean "no value" for this field (default -1, -NA-, NA, -) — shown as an empty value. [] = show them as they are. */
  emptyValues?: string[];
  /** Device layout: leave this row out of Node View while the device has no value for it (rows the device UI hides by mode). */
  uiHideWhenEmpty?: boolean;
  /** Device layout: show this row only while sibling fields have these raw values (all conditions must hold). */
  uiShowWhen?: { field: string; in?: string[]; notIn?: string[]; required?: boolean }[];
  /** Device layout: polled but never drawn (feeds "show when" rules and "options from"). */
  uiHidden?: boolean;
  /** Device layout: dropdown options come from this sibling field's value ("36( 5180 MHz ),37( 5185 MHz )…"), not the fixed list. */
  optionsFrom?: string;
  /** How the label was chosen (the label text itself is always stored). */
  labelSource?: 'custom' | 'mibName' | 'mibDescription';
  order: number;
}

export interface UiDescriptorSection {
  sectionId: string;
  title: string;
  columns: 1 | 2;
  fullWidth?: boolean;
  pollInterval?: number;
  /** Real-time refresh in Node View, seconds (0/absent = off). Only honoured for read-only sections. */
  liveRefreshSeconds?: number;
  writeMode?: 'apply-button' | 'direct' | 'read-only';
  /** Optional Node View tree position (Page > Parent > Tab). */
  uiPage?: string;
  uiParent?: string;
  uiTab?: string;
  /** Device-style view (Builder v2): heading, note under the form, and how the section is drawn. */
  uiTitle?: string;
  uiNote?: string;
  uiLayout?: 'form' | 'card' | 'table' | 'matrix';
  uiColumn?: 'left' | 'right';
  /** Skip this section (and an emptied tab / menu item) in Node View when the device returns no data for it. */
  uiHideWhenEmpty?: boolean;
  /** 'matrix' layout: one column per table row (e.g. radio), rows = the section's fields. */
  uiMatrix?: { columns: { index: string; label: string; map?: Record<string, string> }[]; hideEmptyColumns?: boolean };
  fields: UiDescriptorField[];
  order: number;
}

/**
 * Where a header value comes from. The design (what is shown, where) is fixed in the builder; the data comes from each
 * device: typed text, a template over device values ("{fw} SNo. {sn}"), or a calculation. `map` turns a raw device value
 * into display text ({ ap: 'BTS', sta: 'CPE' }); `sample` is only used by the builder preview.
 */
export interface DataSource {
  kind: 'text' | 'template' | 'calc';
  text?: string;
  template?: string;
  expr?: string;
  /** template only: used when the main template cannot be computed (a missing / non-numeric value) */
  fallback?: string | null;
  format?: string;
  decimals?: number | null;
  inputs?: { name: string; oid: string; sample?: string; map?: Record<string, string>; strip?: string; emptyValues?: string[] }[];
}

export interface HeaderRadio {
  label: string;
  mode: string;
  up?: boolean;
  /** where the badge text (BTS / CPE / AP …) comes from; a radio whose source returns nothing is left out on that device */
  modeSource?: DataSource;
  labelSource?: DataSource;
  /** the LED is green when the OID's value is one of upValues; `sample` is only for the preview */
  upSource?: { oid: string; upValues: string[]; sample?: string };
}

/** Device-style header shown by Builder v2 (all optional). */
export interface DeviceUiConfig {
  productName?: string;
  versionLine?: string;
  uptime?: string;
  saveLabel?: string;
  /** Header items fed by a field of the screen (fixed text, MIB value or calculated), by fieldId. */
  bind?: { productName?: string; versionLine?: string; uptime?: string };
  /** Header items read from the device (preferred over `bind` and over the typed text, which then only serves the preview) */
  sources?: { productName?: DataSource; versionLine?: DataSource; uptime?: DataSource };
  radios?: HeaderRadio[];
}

/** The header resolved for ONE device (Node View) or from the samples (builder preview). null = no data → "—". */
export interface ResolvedHeader {
  productName: string | null;
  versionLine: string | null;
  uptime: string | null;
  radios: { label: string; mode: string; up: boolean }[];
}

export interface UiDescriptor {
  descriptorId: string;
  screenName: string;
  deviceProfile?: string;
  productDefinitionId?: string;
  vendor?: string;
  productFamily?: string;
  mibModule?: string;
  status: 'draft' | 'published';
  sections: UiDescriptorSection[];
  deviceUi?: DeviceUiConfig | null;
  /** 'device' = Builder v2 screen (Node View renders it in the device's own look). */
  layoutMode?: 'classic' | 'device' | null;
  /** Screen-wide default poll interval (seconds) for new sections. */
  defaultPollInterval?: number | null;
  generatedXml?: string;
  /** MIB objects selected during Stage 1; stored for session restore. */
  selectedObjects?: MibObjectSummary[];
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UiDescriptorSummary extends Omit<UiDescriptor, 'sections' | 'generatedXml' | 'selectedObjects'> {
  sectionCount: number;
  objectCount: number;
  /** Main radios the screen serves (min..max); null when it has no 'Radio n' menu. */
  radios?: { min: number; max: number } | null;
}

const BASE = '/ui-builder';

interface Envelope<T> {
  status: string;
  data: T;
}

function unwrap<T>(body: Envelope<T>): T {
  return body.data;
}

export async function listDescriptors(): Promise<UiDescriptorSummary[]> {
  const res = await apiClient.get<Envelope<UiDescriptorSummary[]>>(`${BASE}/descriptors`);
  return unwrap(res.data);
}

export async function createDescriptor(data: Partial<UiDescriptor>): Promise<UiDescriptor> {
  const res = await apiClient.post<Envelope<UiDescriptor>>(`${BASE}/descriptors`, data);
  return unwrap(res.data);
}

export async function getDescriptor(id: string): Promise<UiDescriptor> {
  const res = await apiClient.get<Envelope<UiDescriptor>>(`${BASE}/descriptors/${encodeURIComponent(id)}`);
  return unwrap(res.data);
}

export async function updateDescriptor(id: string, data: Partial<UiDescriptor>): Promise<UiDescriptor> {
  const res = await apiClient.put<Envelope<UiDescriptor>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}`,
    data,
  );
  return unwrap(res.data);
}

export async function publishDescriptor(
  id: string,
  options?: { productDefinitionId?: string },
): Promise<UiDescriptor> {
  const res = await apiClient.post<Envelope<UiDescriptor>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}/publish`,
    options ?? {},
  );
  return unwrap(res.data);
}

export async function deleteDescriptor(id: string): Promise<void> {
  await apiClient.delete(`${BASE}/descriptors/${encodeURIComponent(id)}`);
}

export async function getDescriptorXml(id: string): Promise<string> {
  const res = await apiClient.get<Envelope<{ descriptorId: string; xml: string }>>(
    `${BASE}/descriptors/${encodeURIComponent(id)}/xml`,
  );
  return unwrap(res.data).xml;
}

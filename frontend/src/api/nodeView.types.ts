/**
 * Node View Types — Pre-built wireframe architecture.
 *
 * The wireframe is generated once at definition activation time and
 * persisted. At runtime the UI receives:
 *   wireframe  — static layout (groups, sub-groups, parameters + widget metadata)
 *   values     — dynamic live data keyed by parameterId
 *
 * The frontend performs a simple O(1) binding: wireframe.parameter.id → values[id]
 * and renders. No grouping, sorting, or template construction at runtime.
 */

import type { UiWidget } from './framework-panels.types';
import type { FreshnessState, ParameterReadStatus } from './framework-parameters.types';

// ── Wireframe types (static, from DB) ────────────────────────────────────────

export interface WireframeParameter {
  parameterId:     string;
  displayName:     string;
  dataType:        string;
  unit:            string | null;
  uiWidget:        string | null;
  effectiveWidget: UiWidget;
  readOnly:        boolean;
  snmpOid:         string | null;
  hidden:          boolean;
  displayOrder:    number;
  subGroup:        string | null;
  enumValues:      string[];
  /** Dropdown options parsed from the definition's enumValues ("Label(raw)"). */
  options:         Array<{ value: string; label: string }>;
  /** Credential-like parameter — shown masked. */
  sensitive?:      boolean;
  minValue:        number | null;
  maxValue:        number | null;
  defaultValue:    string | null;
  description:     string | null;
  thresholds:      { high?: number; low?: number } | null;
  /** Custom UI (device layout): the builder field, what it is, its position, and where its value comes from. */
  fieldId?:        string | null;
  elementType?:    string | null;
  uiOrder?:        number;
  valueSource?:    'mib' | 'static' | 'calc' | null;
  emptyValues?:    string[];
  uiHideWhenEmpty?: boolean;
  uiShowWhen?:     { field: string; in?: string[]; notIn?: string[]; required?: boolean }[];
  uiHidden?:       boolean;
  optionsFrom?:    string;
  optionsBy?: { dependsOn: string[]; table: Record<string, string>; defaults?: Record<string, string>; resetOnChange?: boolean; resetTo?: string };
  /** a LIST of numeric ids (VLAN trunk list): this object adds one id per SET, `deleteParam` removes one */
  idList?: { deleteParam: string; max: number; minId: number; maxId: number };
  staticValue?:    string | null;
}

export interface WireframeGroup {
  groupId:             string;
  label:               string;
  displayOrder:        number;
  pollIntervalSeconds: number;
  /** Real-time refresh in seconds set by the Builder author on a read-only section; null/absent = off. */
  liveRefreshSeconds?: number | null;
  subGroups:           string[];
  parameters:          WireframeParameter[];
  /** Sidebar hierarchy — mirrors real device left-nav structure */
  uiPage?:   string;   // top-level nav: 'Wireless' | 'Network' | 'Management' | 'Monitor'
  uiParent?: string;   // sub-item:      'Radio 1' | 'Radio 2' | '2.4 GHz Radio' | 'QoS' | 'IP Configuration' | …
  uiTab?:    string;   // tab label:     'Properties' | 'DDRS/ATPC' | 'DFS' | 'DCS' | …
  /** Custom UI (device layout) */
  uiTitle?:  string;
  uiNote?:   string;
  uiLayout?: string;
  uiColumn?: string;
  uiHideWhenEmpty?: boolean;
  uiMatrix?: { columns: { index: string; label: string; map?: Record<string, string> }[]; hideEmptyColumns?: boolean } | null;
  uiCharts?: import('./uiBuilder.api').UiChartsConfig | null;
  layoutItems?: Array<{ fieldId: string; elementType: 'heading' | 'sub-heading' | 'divider'; label: string; uiOrder: number }>;
}

export interface NodeViewWireframe {
  productDefinitionId: string;
  versionId:           string;
  registryVersion:     string;
  parameterCount:      number;
  groupCount:          number;
  groups:              WireframeGroup[];
  /** Custom UI (device layout): header config; layoutMode 'device' = render in the device's own look. */
  deviceUi?:           import('./uiBuilder.api').DeviceUiConfig | null;
  layoutMode?:         string | null;
}

// ── Live value types (dynamic, from SNMP poll) ────────────────────────────────

export interface ParameterValueRecord {
  value:          string | null;
  display:        string | null;
  freshnessState: FreshnessState;
  readStatus:     ParameterReadStatus;
  collectedAt:    string | null;
  isTable:        boolean;
  instances:      Array<{ index: string; value: string; display: string }>;
  unit:           string | null;
  failureReason:  string | null;
  /** Where a value came from when the vendor OID could not supply it: 'standard-mib' (IP-MIB / IF-MIB over SNMP, no device
   *  credentials) or 'web' (the device web UI, with a stored login). Both are shown read-only. */
  source?:        'web' | 'standard-mib';
}

/** Live value records keyed `${groupId}::${parameterId}` (parameter ids repeat across groups). */
export type NodeViewValues = Record<string, ParameterValueRecord>;

export const valueKey = (groupId: string, parameterId: string): string => `${groupId}::${parameterId}`;

// ── Combined response ─────────────────────────────────────────────────────────

export interface NodeViewDevice {
  id:                  string;
  productDefinitionId: string;
  deviceType:          string;
  status:              string;
  ipAddress:           string | null;
}

export interface NodeViewData {
  device:      NodeViewDevice;
  wireframe:   NodeViewWireframe;
  values:      NodeViewValues;
  /** Device-layout screens: the header bar resolved from this device's own values. */
  header?:     import('./uiBuilder.api').ResolvedHeader | null;
  /** Whether the gateway can write to this device (an SNMP write community is configured). */
  writable?:   { enabled: boolean };
  pollStatus:  string;
  collectedAt: string | null;
  /** True when no product definition is linked — wireframe contains basic SNMP MIB-2 system info only */
  noFramework?: boolean;
}

export interface NodeViewResponse {
  status: 'ok' | 'NO_ACTIVE_FRAMEWORK' | 'error';
  source?: 'cache' | 'db' | 'built';
  data?:   NodeViewData;
  error?:  { code: string; message: string; correlationId?: string };
}

export interface WireframeOnlyResponse {
  status: 'ok' | 'error';
  source?: 'cache' | 'db';
  data?:   Omit<NodeViewData, 'device' | 'values' | 'pollStatus' | 'collectedAt'> & {
    wireframe: NodeViewWireframe;
    createdAt?: string;
    updatedAt?: string;
  };
  error?: { code: string; message: string; correlationId?: string };
}

// ── Apply (write) ─────────────────────────────────────────────────────────────

export interface NodeViewChange {
  groupId:     string;
  parameterId: string;
  /** SNMP instance index ('' for a scalar). */
  instance:    string;
  value:       string;
}

export interface NodeViewChangeResult extends NodeViewChange {
  ok:     boolean;
  code?:  string;
  error?: string;
}

export interface NodeViewApplyResponse {
  status:  'ok' | 'partial' | 'error';
  results?: NodeViewChangeResult[];
  error?:  { code: string; message: string; correlationId?: string };
}

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
}

export interface WireframeGroup {
  groupId:             string;
  label:               string;
  displayOrder:        number;
  pollIntervalSeconds: number;
  subGroups:           string[];
  parameters:          WireframeParameter[];
}

export interface NodeViewWireframe {
  productDefinitionId: string;
  versionId:           string;
  registryVersion:     string;
  parameterCount:      number;
  groupCount:          number;
  groups:              WireframeGroup[];
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

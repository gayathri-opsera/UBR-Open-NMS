/**
 * WO-014: Mock fixtures for the framework adaptive UI template API.
 *
 * Covers:
 *   - Multi-group Product Definition with all widget types
 *   - Role-restricted parameters (absent from response after server-side filtering)
 *   - Stale values overlaid on a template group
 *   - Threshold alarm annotations
 *   - Adapter failure context
 *   - Empty group (forbidden state)
 *   - 404/403/503 error responses
 */

import type {
  AdaptiveUiTemplateResponse,
  AdaptiveUiTemplateData,
  AdaptiveParameterGroup,
  AdaptiveParameter,
} from '../framework-panels.types';

// ── Fixture parameters ────────────────────────────────────────────────────────

const paramIfIn: AdaptiveParameter = {
  parameterId:     'ifInOctets',
  label:           'Inbound Octets',
  dataType:        'counter',
  unit:            'bytes',
  readOnly:        true,
  effectiveWidget: 'counter',
};

const paramIfOut: AdaptiveParameter = {
  parameterId:     'ifOutOctets',
  label:           'Outbound Octets',
  dataType:        'counter',
  unit:            'bytes',
  readOnly:        true,
  effectiveWidget: 'counter',
};

const paramCPU: AdaptiveParameter = {
  parameterId:     'cpuLoad',
  label:           'CPU Load',
  description:     'Percentage CPU utilisation across all cores.',
  dataType:        'gauge',
  unit:            '%',
  readOnly:        true,
  minValue:        0,
  maxValue:        100,
  uiWidget:        'slider',
  effectiveWidget: 'slider',
  thresholds:      { high: 90, low: 5 },
};

const paramRxPower: AdaptiveParameter = {
  parameterId:     'rxPower',
  label:           'RX Optical Power',
  dataType:        'gauge',
  unit:            'dBm',
  readOnly:        true,
  minValue:        -40,
  maxValue:        0,
  effectiveWidget: 'slider',
  thresholds:      { low: -35 },
};

const paramAdminState: AdaptiveParameter = {
  parameterId:     'adminState',
  label:           'Admin State',
  dataType:        'enum',
  enumValues:      ['UP', 'DOWN', 'TESTING'],
  readOnly:        true,
  effectiveWidget: 'dropdown',
};

const paramEnabled: AdaptiveParameter = {
  parameterId:     'linkEnabled',
  label:           'Link Enabled',
  dataType:        'boolean',
  readOnly:        true,
  effectiveWidget: 'toggle',
};

const paramSysName: AdaptiveParameter = {
  parameterId:     'sysName',
  label:           'System Name',
  dataType:        'string',
  readOnly:        true,
  effectiveWidget: 'textfield',
};

// ── Fixture groups ────────────────────────────────────────────────────────────

export const mockInterfaceGroup: AdaptiveParameterGroup = {
  groupId:    'grp-interface',
  label:      'Interface Statistics',
  parameters: [paramIfIn, paramIfOut, paramCPU],
};

export const mockOpticalGroup: AdaptiveParameterGroup = {
  groupId:    'grp-optical',
  label:      'Optical Power',
  parameters: [paramRxPower],
};

export const mockControlGroup: AdaptiveParameterGroup = {
  groupId:    'grp-control',
  label:      'Control',
  parameters: [paramAdminState, paramEnabled, paramSysName],
};

// ── Full success response ─────────────────────────────────────────────────────

export const mockTemplateData: AdaptiveUiTemplateData = {
  deviceId:            'dev-001',
  productDefinitionId: 'pd-cisco-ios-router',
  registryVersion:     'registry-v1',
  renderedAt:          '2026-09-17T10:00:00Z',
  groups:              [mockInterfaceGroup, mockOpticalGroup, mockControlGroup],
  adapterContext: {
    activeAdapter:            'SNMP',
    lastSuccessfulProtocol:   'SNMP',
    lastFailureCategory:      undefined,
    lastFailureReason:        undefined,
  },
};

export const mockTemplateResponse: AdaptiveUiTemplateResponse = {
  status: 'ok',
  data:   mockTemplateData,
};

// ── Adapter failure context ───────────────────────────────────────────────────

export const mockTemplateWithAdapterFailure: AdaptiveUiTemplateResponse = {
  status: 'ok',
  data: {
    ...mockTemplateData,
    adapterContext: {
      activeAdapter:          'SNMP',
      lastSuccessfulProtocol: 'ICMP',
      lastFailureCategory:    'AUTH_FAILURE',
      lastFailureReason:
        'management access was rejected — verify the vault reference configured for this device',
    },
  },
};

// ── Role-restricted response (only one group visible) ─────────────────────────

export const mockTemplateReadOnly: AdaptiveUiTemplateResponse = {
  status: 'ok',
  data: {
    ...mockTemplateData,
    // Control group is absent because admin-only parameters were filtered server-side.
    groups: [mockInterfaceGroup, mockOpticalGroup],
  },
};

// ── Version mismatch scenario ─────────────────────────────────────────────────

export const mockTemplateVersionMismatch: AdaptiveUiTemplateResponse = {
  status: 'ok',
  data: {
    ...mockTemplateData,
    registryVersion: 'registry-v2',  // newer than v1 used by current values
  },
};

// ── Error responses ───────────────────────────────────────────────────────────

export const mockTemplateForbiddenResponse: AdaptiveUiTemplateResponse = {
  status: 'error',
  error: {
    code:          'FORBIDDEN_ACTION',
    message:       'Your current role does not have access to this device\'s parameters.',
    correlationId: 'corr-403-001',
  },
};

export const mockTemplateNotFoundResponse: AdaptiveUiTemplateResponse = {
  status: 'error',
  error: {
    code:          'DEVICE_NOT_FOUND',
    message:       'device is not associated with any active Product Definition',
    correlationId: 'corr-404-001',
  },
};

export const mockTemplateServiceUnavailableResponse: AdaptiveUiTemplateResponse = {
  status: 'error',
  error: {
    code:          'SERVICE_UNAVAILABLE',
    message:       'parameter registry is temporarily unavailable — please retry',
    correlationId: 'corr-503-001',
  },
};

// ── All fixture responses for table-driven tests ──────────────────────────────

export const mockAllTemplateResponses: AdaptiveUiTemplateResponse[] = [
  mockTemplateResponse,
  mockTemplateWithAdapterFailure,
  mockTemplateReadOnly,
  mockTemplateVersionMismatch,
];

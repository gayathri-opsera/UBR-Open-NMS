/**
 * WO-012: Mock fixtures for the framework parameter current-value API.
 *
 * One fixture set per required scenario:
 *   1. SNMP-first device — all parameters FRESH with numeric values.
 *   2. REST-first device — all parameters FRESH.
 *   3. CLI-only device   — all parameters FRESH.
 *   4. Stale device      — parameters last collected beyond the staleness threshold.
 *   5. Failed device     — all parameters FAILED (auth failure).
 *   6. Unmapped device   — no active Product Definition associated.
 *
 * All fixtures are synthetic — no real IPs, OIDs, or credentials are embedded.
 */

import type {
  ParameterCurrentValue,
  ParameterCurrentValueGroup,
  ParameterCurrentValueResponse,
} from '../framework-parameters.types';

// ── Shared timestamps ─────────────────────────────────────────────────────────

const NOW        = '2026-09-17T10:00:00Z';
const LAST_OK    = '2026-09-17T09:59:00Z';
const STALE_OK   = '2026-09-17T09:45:00Z';  // 15 min ago — stale for 60s interval

// ── SNMP-first device: ifInOctets + ifOutOctets ───────────────────────────────

const snmpIn: ParameterCurrentValue = {
  deviceId:            'dev-snmp-001',
  groupId:             'grp-interface',
  parameterId:         'ifInOctets',
  label:               'Inbound Octets',
  dataType:            'counter',
  unit:                'bytes',
  value:               '9876543',
  valueNumeric:        9876543,
  source:              'SNMP',
  collectedAt:         NOW,
  pollIntervalSeconds: 60,
  freshnessState:      'FRESH',
  readStatus:          'SUCCESS',
  lastSuccessAt:       LAST_OK,
  registryVersion:     'registry-v1',
  productDefinitionId: 'pd-cisco-ios-router',
};

const snmpOut: ParameterCurrentValue = {
  ...snmpIn,
  parameterId:  'ifOutOctets',
  label:        'Outbound Octets',
  value:        '1234567',
  valueNumeric: 1234567,
};

export const mockSNMPFirstGroup: ParameterCurrentValueGroup = {
  groupId:    'grp-interface',
  label:      'Interface Statistics',
  parameters: [snmpIn, snmpOut],
};

export const mockSNMPFirstResponse: ParameterCurrentValueResponse = {
  status: 'ok',
  data: {
    deviceId:            'dev-snmp-001',
    productDefinitionId: 'pd-cisco-ios-router',
    registryVersion:     'registry-v1',
    groups:              [mockSNMPFirstGroup],
  },
};

// ── REST-first device: rx/tx optical power ───────────────────────────────────

const restRx: ParameterCurrentValue = {
  deviceId:            'dev-rest-001',
  groupId:             'grp-optical',
  parameterId:         'rxPower',
  label:               'RX Power',
  dataType:            'gauge',
  unit:                'dBm',
  value:               '-3.2',
  valueNumeric:        -3.2,
  source:              'REST',
  collectedAt:         NOW,
  pollIntervalSeconds: 60,
  freshnessState:      'FRESH',
  readStatus:          'SUCCESS',
  lastSuccessAt:       LAST_OK,
  registryVersion:     'registry-v1',
  productDefinitionId: 'pd-nokia-sr',
};

const restTx: ParameterCurrentValue = {
  ...restRx,
  parameterId:  'txPower',
  label:        'TX Power',
  value:        '-1.8',
  valueNumeric: -1.8,
};

export const mockRESTFirstGroup: ParameterCurrentValueGroup = {
  groupId:    'grp-optical',
  label:      'Optical Power',
  parameters: [restRx, restTx],
};

export const mockRESTFirstResponse: ParameterCurrentValueResponse = {
  status: 'ok',
  data: {
    deviceId:            'dev-rest-001',
    productDefinitionId: 'pd-nokia-sr',
    registryVersion:     'registry-v1',
    groups:              [mockRESTFirstGroup],
  },
};

// ── CLI-only device: cpu + memory ─────────────────────────────────────────────

const cliCPU: ParameterCurrentValue = {
  deviceId:            'dev-cli-001',
  groupId:             'grp-chassis',
  parameterId:         'cpuLoad',
  label:               'CPU Load',
  dataType:            'gauge',
  unit:                '%',
  value:               '42',
  valueNumeric:        42,
  source:              'CLI',
  collectedAt:         NOW,
  pollIntervalSeconds: 60,
  freshnessState:      'FRESH',
  readStatus:          'SUCCESS',
  lastSuccessAt:       LAST_OK,
  registryVersion:     'registry-v1',
  productDefinitionId: 'pd-juniper-mx',
};

const cliMem: ParameterCurrentValue = {
  ...cliCPU,
  parameterId:  'memUtil',
  label:        'Memory Utilisation',
  value:        '68',
  valueNumeric: 68,
};

export const mockCLIOnlyGroup: ParameterCurrentValueGroup = {
  groupId:    'grp-chassis',
  label:      'Chassis Health',
  parameters: [cliCPU, cliMem],
};

export const mockCLIOnlyResponse: ParameterCurrentValueResponse = {
  status: 'ok',
  data: {
    deviceId:            'dev-cli-001',
    productDefinitionId: 'pd-juniper-mx',
    registryVersion:     'registry-v1',
    groups:              [mockCLIOnlyGroup],
  },
};

// ── Stale device: values from 15 minutes ago ─────────────────────────────────

const staleParam: ParameterCurrentValue = {
  ...snmpIn,
  deviceId:       'dev-stale-001',
  collectedAt:    STALE_OK,
  freshnessState: 'STALE',
  readStatus:     'TIMEOUT',
  lastSuccessAt:  STALE_OK,
  failureCategory: 'TIMEOUT',
  failureReason:  'protocol read request timed out — device did not respond within the configured interval',
};

export const mockStaleGroup: ParameterCurrentValueGroup = {
  groupId:    'grp-interface',
  label:      'Interface Statistics',
  parameters: [staleParam, { ...staleParam, parameterId: 'ifOutOctets', label: 'Outbound Octets' }],
};

export const mockStaleResponse: ParameterCurrentValueResponse = {
  status: 'ok',
  data: {
    deviceId:            'dev-stale-001',
    productDefinitionId: 'pd-cisco-ios-router',
    registryVersion:     'registry-v1',
    groups:              [mockStaleGroup],
  },
};

// ── Failed device: all parameters AUTH_FAILURE ────────────────────────────────

const failedParam: ParameterCurrentValue = {
  ...snmpIn,
  deviceId:        'dev-failed-001',
  value:           undefined,
  valueNumeric:    undefined,
  source:          undefined,
  freshnessState:  'FAILED',
  readStatus:      'AUTH_FAILURE',
  lastSuccessAt:   undefined,
  failureCategory: 'AUTH_FAILURE',
  failureReason:   'management access was rejected — verify the vault reference configured for this device',
};

export const mockFailedGroup: ParameterCurrentValueGroup = {
  groupId:    'grp-interface',
  label:      'Interface Statistics',
  parameters: [failedParam, { ...failedParam, parameterId: 'ifOutOctets', label: 'Outbound Octets' }],
};

export const mockFailedResponse: ParameterCurrentValueResponse = {
  status: 'ok',
  data: {
    deviceId:            'dev-failed-001',
    productDefinitionId: 'pd-cisco-ios-router',
    registryVersion:     'registry-v1',
    groups:              [mockFailedGroup],
  },
};

// ── Unmapped device: no active PD ────────────────────────────────────────────

export const mockUnmappedResponse: ParameterCurrentValueResponse = {
  status: 'error',
  error: {
    code:          'DEVICE_NOT_FOUND',
    message:       'device is not associated with any active Product Definition',
    correlationId: 'corr-unmapped-001',
  },
};

// ── All response fixtures array for table-driven tests ────────────────────────

export const mockAllCurrentValueResponses: ParameterCurrentValueResponse[] = [
  mockSNMPFirstResponse,
  mockRESTFirstResponse,
  mockCLIOnlyResponse,
  mockStaleResponse,
  mockFailedResponse,
];

/**
 * Mock fixtures for SNMP discovery API types.
 *
 * Used in unit tests (vi.mock) and component development.
 * All data is synthetic — no real IPs or credentials are embedded.
 */
import type {
  DiscoveryRunDetail,
  DiscoveryRunResponse,
  DiscoveryResult,
  DiscoverySchedule,
  ScopeEntry,
} from '../discovery.api';

// ── Scope fixtures ────────────────────────────────────────────────────────────

export const mockScopeEntries: ScopeEntry[] = [
  { type: 'CIDR', value: '192.168.1.0/24' },
  { type: 'IP',   value: '10.0.0.1' },
];

// ── Run response fixtures ─────────────────────────────────────────────────────

/** A newly-created discovery run (status CREATED / QUEUED). */
export const mockDiscoveryRunResponse: DiscoveryRunResponse = {
  runId:             'run-test-001',
  status:            'CREATED',
  normalizedScope:   mockScopeEntries,
  createdBy:         'operator@airtel.in',
  createdAt:         '2026-09-09T10:00:00Z',
  validationSummary: '2 scope entries normalised; 255 hosts estimated.',
};

/** A discovery run currently running with partial sweep progress. */
export const mockDiscoveryRunRunning: DiscoveryRunDetail = {
  ...mockDiscoveryRunResponse,
  runId:   'run-test-002',
  status:  'RUNNING',
  updatedAt: '2026-09-09T10:00:05Z',
  protocol:  'SNMP_V2C',
  sweep: {
    totalHosts:        254,
    hostsScanned:      120,
    reachableHosts:    18,
    sweepStartedAt:    '2026-09-09T10:00:01Z',
  },
};

/** A completed discovery run with full results. */
export const mockDiscoveryRunCompleted: DiscoveryRunDetail = {
  ...mockDiscoveryRunResponse,
  runId:              'run-test-003',
  status:             'COMPLETED',
  updatedAt:          '2026-09-09T10:02:30Z',
  protocol:           'SNMP_V2C',
  snmpAttemptCount:   18,
  snmpSuccessCount:   15,
  sweep: {
    totalHosts:        254,
    hostsScanned:      254,
    reachableHosts:    18,
    sweepStartedAt:    '2026-09-09T10:00:01Z',
    sweepCompletedAt:  '2026-09-09T10:01:00Z',
    sweepDurationMs:   59000,
    workerCount:       10,
  },
};

/** A failed discovery run with a reason. */
export const mockDiscoveryRunFailed: DiscoveryRunDetail = {
  ...mockDiscoveryRunResponse,
  runId:         'run-test-004',
  status:        'FAILED',
  updatedAt:     '2026-09-09T10:00:10Z',
  failureReason: 'SNMP community resolution failed for all hosts in scope.',
};

// ── Result fixtures ───────────────────────────────────────────────────────────

/** A fully classified Cisco Catalyst switch. */
export const mockResultCiscoSwitch: DiscoveryResult = {
  ip:                   '192.168.1.10',
  icmpStatus:           'reachable',
  snmpStatus:           'success',
  vendor:               'Cisco',
  model:                'Catalyst',
  genericDeviceType:    'SWITCH',
  sysObjectID:          '.1.3.6.1.4.1.9.1.516',
  sysDescr:             'Cisco IOS Software, Catalyst 2960 Software',
  sysName:              'core-sw-01',
  sysContact:           'netops@airtel.in',
  sysLocation:          'DC1 Rack A12',
  sysUpTimeSeconds:     864000,
  classificationStatus: 'RECOGNISED',
  correlationId:        'corr-001',
  // MAC address collected via IF-MIB ifPhysAddress walk (simulated by test/snmpsim/agent.py)
  macAddress:           '00:1a:2b:3c:4d:5e',
};

/** A Juniper router classified via OID. */
export const mockResultJuniperRouter: DiscoveryResult = {
  ip:                   '192.168.1.11',
  icmpStatus:           'reachable',
  snmpStatus:           'success',
  vendor:               'Juniper',
  model:                'JunOS',
  genericDeviceType:    'ROUTER',
  sysObjectID:          '.1.3.6.1.4.1.2636.1.1.1.2.39',
  sysDescr:             'Juniper Networks, Inc. mx480 internet router',
  classificationStatus: 'RECOGNISED',
  correlationId:        'corr-002',
};

/** A host that responded to ICMP but failed SNMP authentication. */
export const mockResultSnmpAuthFailed: DiscoveryResult = {
  ip:                   '192.168.1.20',
  icmpStatus:           'reachable',
  snmpStatus:           'auth_failed',
  classificationStatus: 'CLASSIFICATION_ERROR',
  deferReason:          'FINGERPRINT_SNMP_AUTH_FAILED',
  correlationId:        'corr-003',
};

/** A host that responded to ICMP but has an unrecognised OID. */
export const mockResultUnrecognised: DiscoveryResult = {
  ip:                   '192.168.1.30',
  icmpStatus:           'reachable',
  snmpStatus:           'success',
  sysObjectID:          '.1.3.6.1.4.1.99999.1.1',
  sysDescr:             'Unknown Device v1.0',
  classificationStatus: 'DEFERRED_UNSUPPORTED',
  deferReason:          'OID_NOT_IN_RELEASE_SCOPE',
  correlationId:        'corr-004',
};

/** A host that was unreachable via ICMP — SNMP never attempted. */
export const mockResultUnreachable: DiscoveryResult = {
  ip:                   '192.168.1.99',
  icmpStatus:           'unreachable',
  snmpStatus:           'not_attempted',
  classificationStatus: 'CLASSIFICATION_ERROR',
  deferReason:          'FINGERPRINT_SNMP_AUTH_FAILED',
  correlationId:        'corr-005',
};

/** Full set of results for a completed run. */
export const mockDiscoveryResults: DiscoveryResult[] = [
  mockResultCiscoSwitch,
  mockResultJuniperRouter,
  mockResultSnmpAuthFailed,
  mockResultUnrecognised,
  mockResultUnreachable,
];

// ── Schedule fixtures ─────────────────────────────────────────────────────────

export const mockDiscoverySchedule: DiscoverySchedule = {
  scheduleId:       'sched-001',
  scopeRunId:       'run-test-003',
  name:             'Nightly Core Network Scan',
  cronExpression:   '0 2 * * *',
  enabled:          true,
  nextRunAt:        '2026-09-09T02:00:00Z',
  createdAt:        '2026-09-01T09:00:00Z',
};

/** Second Cisco switch with different model for comparison tests (WO-030). */
export const mockResultCiscoSwitchAlt: DiscoveryResult = {
  ...mockResultCiscoSwitch,
  ip:    '192.168.1.12',
  model: 'Catalyst-3850',
  sysName: 'core-sw-02',
};

export const mockComparisonDevices: DiscoveryResult[] = [
  mockResultCiscoSwitch,
  mockResultCiscoSwitchAlt,
];

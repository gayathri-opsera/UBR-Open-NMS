'use strict';

/**
 * WO-006: Product Definition parameter fixtures for visibility testing.
 *
 * Covers: public (default-visible), operator-only, admin-only, superadmin-only,
 * mixed-visibility groups, empty group after filtering, and malformed visibility.
 *
 * These fixtures use placeholder values only — no real credential material.
 */

/**
 * Full parameter groups fixture used in unit and integration tests.
 *
 * Groups:
 *   1. "basic"       — all parameters visible to everyone (no uiVisibleTo / empty)
 *   2. "operational" — mixed: one public, one operator-only, one superadmin-only
 *   3. "security"    — all parameters are superadmin-only (group hidden for Operator/ReadOnly)
 *   4. "malformed"   — uiVisibleTo is an object/number (malformed → deny for all named entries)
 */
const ALL_PARAMETER_GROUPS = [
  {
    groupId:    'basic',
    label:      'Basic Parameters',
    parameters: [
      { parameterId: 'sys_uptime',   label: 'System Uptime',   uiVisibleTo: null },
      { parameterId: 'sys_name',     label: 'System Name',     uiVisibleTo: '' },
      { parameterId: 'sys_location', label: 'System Location', uiVisibleTo: [] },
    ],
  },
  {
    groupId:    'operational',
    label:      'Operational Parameters',
    parameters: [
      { parameterId: 'if_oper_status', label: 'Interface Oper Status', uiVisibleTo: null },
      { parameterId: 'if_in_errors',   label: 'Interface In Errors',   uiVisibleTo: ['Operator', 'SuperAdmin'] },
      { parameterId: 'root_password',  label: 'Root Password Hash',    uiVisibleTo: ['SuperAdmin'] },
    ],
  },
  {
    groupId:    'security',
    label:      'Security Parameters',
    parameters: [
      { parameterId: 'snmp_auth_proto', label: 'SNMP Auth Protocol', uiVisibleTo: 'SuperAdmin' },
      { parameterId: 'ssh_host_key',    label: 'SSH Host Key',        uiVisibleTo: ['SuperAdmin'] },
    ],
  },
  {
    groupId:    'malformed',
    label:      'Malformed Visibility',
    parameters: [
      { parameterId: 'bad_vis', label: 'Bad Visibility', uiVisibleTo: { notAString: true } },
    ],
  },
];

/**
 * Minimal fixture for a device with only public parameters.
 */
const PUBLIC_ONLY_GROUPS = [
  {
    groupId:    'general',
    label:      'General',
    parameters: [
      { parameterId: 'oid',  label: 'OID',       uiVisibleTo: null },
      { parameterId: 'name', label: 'Name',       uiVisibleTo: undefined },
      { parameterId: 'descr', label: 'Description', uiVisibleTo: '' },
    ],
  },
];

/**
 * Fixture where all parameters are operator-only — ReadOnly callers see nothing.
 * The group is omitted entirely for ReadOnly callers.
 */
const OPERATOR_ONLY_GROUPS = [
  {
    groupId:    'mgmt',
    label:      'Management',
    parameters: [
      { parameterId: 'cpu_util',    label: 'CPU Utilisation',  uiVisibleTo: ['Operator', 'SuperAdmin'] },
      { parameterId: 'mem_util',    label: 'Memory Utilisation', uiVisibleTo: ['operator', 'SuperAdmin'] },
    ],
  },
];

module.exports = {
  ALL_PARAMETER_GROUPS,
  PUBLIC_ONLY_GROUPS,
  OPERATOR_ONLY_GROUPS,
};

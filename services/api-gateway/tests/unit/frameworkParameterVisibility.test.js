'use strict';

/**
 * WO-006 Unit tests: frameworkParameterVisibility.js
 *
 * Tests the pure visibility policy module for:
 *  - Role normalisation (all aliases)
 *  - Filtering groups and parameters
 *  - Empty group omission
 *  - Default-visible behaviour
 *  - Forbidden direct parameter reads
 *  - Malformed uiVisibleTo handling
 *  - Edge cases: whitespace, mixed case, duplicate roles, unknown names
 */

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  filterParameterGroups,
  checkParameterAccess,
  parseUiVisibleTo,
  MALFORMED,
} = require('../../src/utils/frameworkParameterVisibility');

const {
  ALL_PARAMETER_GROUPS,
  PUBLIC_ONLY_GROUPS,
  OPERATOR_ONLY_GROUPS,
} = require('../fixtures/parameterDefinitionFixtures');

// ── parseUiVisibleTo ──────────────────────────────────────────────────────────

describe('parseUiVisibleTo — normalise visibility metadata', () => {
  it('null returns null (default-visible)', () => {
    expect(parseUiVisibleTo(null)).toBeNull();
  });
  it('undefined returns null (default-visible)', () => {
    expect(parseUiVisibleTo(undefined)).toBeNull();
  });
  it('empty string returns null (default-visible)', () => {
    expect(parseUiVisibleTo('')).toBeNull();
  });
  it('empty array returns null (default-visible)', () => {
    expect(parseUiVisibleTo([])).toBeNull();
  });

  it('single string is normalised to a lower-cased Set', () => {
    const result = parseUiVisibleTo('SuperAdmin');
    expect(result instanceof Set).toBe(true);
    expect(result.has('superadmin')).toBe(true);
  });

  it('string array is normalised to a lower-cased Set', () => {
    const result = parseUiVisibleTo(['Operator', 'SuperAdmin']);
    expect(result instanceof Set).toBe(true);
    expect(result.has('operator')).toBe(true);
    expect(result.has('superadmin')).toBe(true);
  });

  it('whitespace entries in array are stripped', () => {
    const result = parseUiVisibleTo(['  ', 'Operator', '']);
    expect(result instanceof Set).toBe(true);
    expect(result.has('operator')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('object value returns MALFORMED symbol', () => {
    expect(parseUiVisibleTo({ nested: true })).toBe(MALFORMED);
  });

  it('number value returns MALFORMED symbol', () => {
    expect(parseUiVisibleTo(42)).toBe(MALFORMED);
  });
});

// ── filterParameterGroups — default-visible ───────────────────────────────────

describe('filterParameterGroups — default-visible parameters visible to all', () => {
  it('ReadOnly can see all parameters with null/empty uiVisibleTo', () => {
    const result = filterParameterGroups(PUBLIC_ONLY_GROUPS, 'viewer');
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toHaveLength(3);
  });

  it('Operator sees all default-visible parameters', () => {
    const result = filterParameterGroups(PUBLIC_ONLY_GROUPS, 'operator');
    expect(result[0].parameters).toHaveLength(3);
  });

  it('SuperAdmin sees all default-visible parameters', () => {
    const result = filterParameterGroups(PUBLIC_ONLY_GROUPS, 'admin');
    expect(result[0].parameters).toHaveLength(3);
  });
});

// ── filterParameterGroups — role-restricted parameters ───────────────────────

describe('filterParameterGroups — restricted parameters', () => {
  it('ReadOnly sees only 2 parameters in "basic" group and 1 in "operational"', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'viewer');
    const basic       = result.find((g) => g.groupId === 'basic');
    const operational = result.find((g) => g.groupId === 'operational');
    // basic: all 3 params are default-visible
    expect(basic.parameters).toHaveLength(3);
    // operational: if_oper_status (public) is visible; if_in_errors (Operator+) and root_password (SuperAdmin) are hidden
    expect(operational.parameters).toHaveLength(1);
    expect(operational.parameters[0].parameterId).toBe('if_oper_status');
  });

  it('Operator sees 2 parameters in "operational" group', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'operator');
    const operational = result.find((g) => g.groupId === 'operational');
    // if_oper_status (public) + if_in_errors (Operator+) visible; root_password (SuperAdmin) hidden
    expect(operational.parameters).toHaveLength(2);
    const ids = operational.parameters.map((p) => p.parameterId);
    expect(ids).toContain('if_oper_status');
    expect(ids).toContain('if_in_errors');
    expect(ids).not.toContain('root_password');
  });

  it('SuperAdmin sees all 3 parameters in "operational" group', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'admin');
    const operational = result.find((g) => g.groupId === 'operational');
    expect(operational.parameters).toHaveLength(3);
  });

  it('ReadOnly does not receive the "security" group (all params are SuperAdmin-only)', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'viewer');
    const securityGroup = result.find((g) => g.groupId === 'security');
    expect(securityGroup).toBeUndefined();
  });

  it('Operator does not receive the "security" group', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'operator');
    expect(result.find((g) => g.groupId === 'security')).toBeUndefined();
  });

  it('SuperAdmin sees the "security" group', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'admin');
    const securityGroup = result.find((g) => g.groupId === 'security');
    expect(securityGroup).toBeDefined();
    expect(securityGroup.parameters).toHaveLength(2);
  });
});

// ── filterParameterGroups — empty group omission ─────────────────────────────

describe('filterParameterGroups — empty group omission', () => {
  it('ReadOnly gets no groups when all parameters are Operator-only', () => {
    const result = filterParameterGroups(OPERATOR_ONLY_GROUPS, 'viewer');
    expect(result).toHaveLength(0);
  });

  it('Operator gets the group when parameters are Operator+', () => {
    const result = filterParameterGroups(OPERATOR_ONLY_GROUPS, 'operator');
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toHaveLength(2);
  });
});

// ── filterParameterGroups — malformed visibility ──────────────────────────────

describe('filterParameterGroups — malformed uiVisibleTo handling', () => {
  it('malformed uiVisibleTo hides the parameter for all roles', () => {
    ['viewer', 'operator', 'admin'].forEach((role) => {
      const result = filterParameterGroups(ALL_PARAMETER_GROUPS, role);
      const malformedGroup = result.find((g) => g.groupId === 'malformed');
      // Only 1 param and it has malformed visibility → group is omitted
      expect(malformedGroup).toBeUndefined();
    });
  });
});

// ── filterParameterGroups — edge cases ───────────────────────────────────────

describe('filterParameterGroups — edge cases', () => {
  it('handles null parameterGroups without throwing', () => {
    expect(() => filterParameterGroups(null, 'admin')).not.toThrow();
    expect(filterParameterGroups(null, 'admin')).toEqual([]);
  });

  it('handles undefined parameterGroups without throwing', () => {
    expect(filterParameterGroups(undefined, 'admin')).toEqual([]);
  });

  it('handles unknown caller role as zero capability (no restricted params visible)', () => {
    const result = filterParameterGroups(ALL_PARAMETER_GROUPS, 'unknown_role');
    // Only default-visible params (null/empty uiVisibleTo) survive
    const groupIds = result.map((g) => g.groupId);
    expect(groupIds).toContain('basic'); // basic: all default-visible
    expect(groupIds).not.toContain('security');
  });

  it('uiVisibleTo with mixed-case aliases is handled correctly', () => {
    const groups = [{
      groupId: 'test',
      parameters: [{ parameterId: 'p1', uiVisibleTo: 'OPERATOR' }],
    }];
    const operatorResult = filterParameterGroups(groups, 'operator');
    expect(operatorResult).toHaveLength(1);
    const readOnlyResult = filterParameterGroups(groups, 'viewer');
    expect(readOnlyResult).toHaveLength(0);
  });

  it('duplicate role names in uiVisibleTo do not break visibility', () => {
    const groups = [{
      groupId: 'test',
      parameters: [{ parameterId: 'p1', uiVisibleTo: ['Operator', 'Operator', 'operator'] }],
    }];
    expect(filterParameterGroups(groups, 'operator')).toHaveLength(1);
  });
});

// ── checkParameterAccess ──────────────────────────────────────────────────────

describe('checkParameterAccess — direct parameter reads', () => {
  it('returns "visible" for a public parameter (ReadOnly)', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'p1', uiVisibleTo: null }] }];
    expect(checkParameterAccess(groups, 'p1', 'viewer')).toBe('visible');
  });

  it('returns "forbidden" for an Operator-only param when caller is ReadOnly', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'p1', uiVisibleTo: ['Operator', 'SuperAdmin'] }] }];
    expect(checkParameterAccess(groups, 'p1', 'viewer')).toBe('forbidden');
  });

  it('returns "visible" for an Operator-only param when caller is Operator', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'p1', uiVisibleTo: ['Operator', 'SuperAdmin'] }] }];
    expect(checkParameterAccess(groups, 'p1', 'operator')).toBe('visible');
  });

  it('returns "not_found" when parameterId does not exist', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'p1', uiVisibleTo: null }] }];
    expect(checkParameterAccess(groups, 'nonexistent', 'admin')).toBe('not_found');
  });

  it('returns "not_found" for empty groups', () => {
    expect(checkParameterAccess([], 'any', 'admin')).toBe('not_found');
  });

  it('returns "not_found" for null groups', () => {
    expect(checkParameterAccess(null, 'any', 'admin')).toBe('not_found');
  });

  it('SuperAdmin can access SuperAdmin-only parameter', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'secret_p', uiVisibleTo: 'SuperAdmin' }] }];
    expect(checkParameterAccess(groups, 'secret_p', 'admin')).toBe('visible');
  });

  it('ReadOnly cannot access SuperAdmin-only parameter', () => {
    const groups = [{ groupId: 'g', parameters: [{ parameterId: 'secret_p', uiVisibleTo: 'SuperAdmin' }] }];
    expect(checkParameterAccess(groups, 'secret_p', 'viewer')).toBe('forbidden');
  });
});

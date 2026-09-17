'use strict';

/**
 * WO-006: Framework parameter visibility policy.
 *
 * Pure, side-effect-free module that filters Product Definition parameter
 * groups and parameters based on the caller's framework capability level.
 *
 * Policy rules (in precedence order):
 *  1. A parameter with blank / missing / null / empty uiVisibleTo is visible
 *     to ALL authenticated framework callers (default-visible).
 *  2. A parameter with non-empty uiVisibleTo is visible only to callers whose
 *     mapped framework role appears in the allow-list.
 *  3. Unknown role names in uiVisibleTo never grant access.
 *  4. Malformed uiVisibleTo (not a string or array) is treated as no access
 *     for any named entry — the parameter is hidden for all callers.
 *  5. After filtering, a group with no remaining visible parameters is OMITTED
 *     entirely from the response (not included with an empty parameters array).
 *
 * The caller's effective role is resolved through resolveFrameworkCapability()
 * from rbac.middleware — the same mapping used for route-level authorization.
 * Header-supplied role claims from the client must never be trusted here;
 * only req.user.role (set by the JWT middleware) is used.
 */

const { resolveFrameworkCapability, FRAMEWORK_CAPABILITY } = require('../middleware/rbac.middleware');
const logger = require('../utils/logger');

/**
 * Maps numeric FRAMEWORK_CAPABILITY levels to the canonical capability names
 * that appear in uiVisibleTo metadata.
 */
const CAPABILITY_NAMES_BY_LEVEL = {
  [FRAMEWORK_CAPABILITY.SuperAdmin]: ['SuperAdmin', 'super_admin', 'admin', 'framework_admin', 'system_admin'],
  [FRAMEWORK_CAPABILITY.Operator]:   ['Operator', 'operator', 'nms_operator', 'network_engineer', 'noc_operator'],
  [FRAMEWORK_CAPABILITY.ReadOnly]:   ['ReadOnly', 'readonly', 'viewer', 'compliance', 'auditor', 'user'],
};

/**
 * Build a flat set of canonical role names that apply to or below a given
 * capability level (i.e. a SuperAdmin can see everything Operator and ReadOnly can).
 *
 * @param {number} capabilityLevel - FRAMEWORK_CAPABILITY level of the caller
 * @returns {Set<string>}          - Lower-cased canonical names visible to this role
 */
function buildVisibleRoleSet(capabilityLevel) {
  const names = new Set();
  for (const [level, aliases] of Object.entries(CAPABILITY_NAMES_BY_LEVEL)) {
    if (parseInt(level, 10) <= capabilityLevel) {
      aliases.forEach((a) => names.add(a.toLowerCase()));
    }
  }
  return names;
}

/**
 * Parse and normalise a parameter's uiVisibleTo field.
 *
 * Accepted forms:
 *   - null / undefined / '' / []  → visible to all (return null = default-visible)
 *   - 'SuperAdmin'               → ['superadmin'] (single string)
 *   - ['Operator', 'SuperAdmin'] → ['operator', 'superadmin']
 *
 * Malformed forms (not string/array) → return Symbol('MALFORMED') for deny-all treatment.
 *
 * @param {*} uiVisibleTo - Raw value from the parameter definition
 * @param {{ productDefinitionId?: string, parameterId?: string }} ctx - For logging
 * @returns {null | Set<string> | Symbol}
 */
const MALFORMED = Symbol('MALFORMED_VISIBILITY');

function parseUiVisibleTo(uiVisibleTo, ctx = {}) {
  if (uiVisibleTo === null || uiVisibleTo === undefined || uiVisibleTo === '') {
    return null; // default-visible
  }
  if (Array.isArray(uiVisibleTo)) {
    if (uiVisibleTo.length === 0) return null; // empty array = default-visible
    const normalized = uiVisibleTo
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase());
    if (normalized.length === 0) return null;
    return new Set(normalized);
  }
  if (typeof uiVisibleTo === 'string') {
    const trimmed = uiVisibleTo.trim();
    if (trimmed.length === 0) return null;
    return new Set([trimmed.toLowerCase()]);
  }
  // Anything else (object, number, boolean) is malformed
  logger.warn({
    msg:                 'Malformed uiVisibleTo in Product Definition — parameter hidden for all callers',
    uiVisibleToType:     typeof uiVisibleTo,
    productDefinitionId: ctx.productDefinitionId,
    parameterId:         ctx.parameterId,
  });
  return MALFORMED;
}

/**
 * Determine whether a single parameter is visible to the caller.
 *
 * @param {object}         parameter      - Parameter object with optional uiVisibleTo field
 * @param {Set<string>}    visibleRoleSet - Set of lower-cased role names the caller maps to
 * @param {number}         callerCapability - FRAMEWORK_CAPABILITY level of the caller
 * @param {object}         ctx             - Logging context
 * @returns {boolean}
 */
function isParameterVisible(parameter, visibleRoleSet, callerCapability, ctx = {}) {
  const parsed = parseUiVisibleTo(parameter.uiVisibleTo, {
    ...ctx,
    parameterId: parameter.parameterId || parameter.id,
  });

  if (parsed === null) return true;     // default-visible — no restriction
  if (parsed === MALFORMED) return false; // malformed — deny

  // Intersection check: is any of the caller's role names in the allow-list?
  for (const name of visibleRoleSet) {
    if (parsed.has(name)) return true;
  }
  return false;
}

/**
 * Filter a parameter template response to only include groups and parameters
 * visible to the caller's mapped framework role.
 *
 * @param {object[]} parameterGroups - Array of { groupId, label, parameters: [...] }
 * @param {string}   callerRole      - Raw JWT role string (from req.user.role)
 * @param {object}   ctx             - Logging context ({ productDefinitionId? })
 * @returns {object[]} Filtered parameter groups (empty groups are omitted)
 */
function filterParameterGroups(parameterGroups, callerRole, ctx = {}) {
  if (!Array.isArray(parameterGroups)) return [];

  const callerCapability  = resolveFrameworkCapability(callerRole);
  const visibleRoleSet    = buildVisibleRoleSet(callerCapability);

  const filtered = [];
  for (const group of parameterGroups) {
    if (!group || !Array.isArray(group.parameters)) continue;

    const visibleParams = group.parameters.filter((param) =>
      isParameterVisible(param, visibleRoleSet, callerCapability, ctx),
    );

    // Omit the group entirely if no parameters remain after filtering
    if (visibleParams.length > 0) {
      filtered.push({ ...group, parameters: visibleParams });
    }
  }
  return filtered;
}

/**
 * Check whether a single parameter is accessible to the caller.
 * Used for direct parameter reads.
 *
 * Returns one of:
 *   'visible'   — caller may read this parameter
 *   'forbidden' — parameter exists but is hidden from this role (→ 403)
 *   'not_found' — parameter does not exist in the definition (→ 404)
 *
 * @param {object[]} parameterGroups  - Full list of parameter groups from the definition
 * @param {string}   parameterId      - The parameter identifier to look up
 * @param {string}   callerRole       - Raw JWT role string
 * @returns {'visible'|'forbidden'|'not_found'}
 */
function checkParameterAccess(parameterGroups, parameterId, callerRole) {
  if (!Array.isArray(parameterGroups)) return 'not_found';

  const callerCapability = resolveFrameworkCapability(callerRole);
  const visibleRoleSet   = buildVisibleRoleSet(callerCapability);

  for (const group of parameterGroups) {
    if (!group || !Array.isArray(group.parameters)) continue;
    for (const param of group.parameters) {
      if ((param.parameterId || param.id) === parameterId) {
        // Parameter exists — now check visibility
        return isParameterVisible(param, visibleRoleSet, callerCapability) ? 'visible' : 'forbidden';
      }
    }
  }
  return 'not_found';
}

module.exports = {
  filterParameterGroups,
  checkParameterAccess,
  parseUiVisibleTo,
  buildVisibleRoleSet,
  MALFORMED,
};

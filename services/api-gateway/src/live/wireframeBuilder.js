'use strict';

/**
 * Wireframe Builder
 * =================
 * Converts a set of parameter_registry_entries (from the active product definition)
 * into a persisted Node View wireframe document.
 *
 * Design principles:
 *  - PURE: no I/O. Accepts entries[], returns a wireframe object.
 *  - SINGLE canonical path: XML / JSON / XLS all normalise into the same
 *    parameter_registry_entries shape before reaching here, so one builder
 *    handles every format.
 *  - BUILD-TIME not RUNTIME: this runs once (on activation) and is stored.
 *    The runtime Node View simply loads the stored document — no rebuilding.
 *
 * Wireframe document shape (see nodeViewWireframe.model.js for the Mongoose schema):
 * {
 *   productDefinitionId : string,
 *   versionId           : string,        // product-definition-service version UUID
 *   registryVersion     : string,        // fingerprint/registry version string
 *   status              : 'ACTIVE',
 *   wireframe           : {
 *     groups : [ GroupSpec ]
 *   },
 *   parameterCount      : number,
 *   groupCount          : number,
 *   createdAt           : Date,
 *   updatedAt           : Date,
 * }
 *
 * GroupSpec:
 * {
 *   groupId    : string,
 *   label      : string,
 *   displayOrder : number,
 *   subGroups  : string[],               // ordered, unique sub-group names
 *   parameters : [ ParameterSpec ],
 * }
 *
 * ParameterSpec: all layout/rendering metadata needed at runtime — no SNMP values.
 */

const { parseEnumOptions } = require('./enumOptions');

// ── Widget auto-selection (mirrors the ui-template route) ─────────────────────

/**
 * Derive the effective UI widget from data type + metadata.
 * An explicit `uiWidget` in the definition always wins.
 */
function deriveWidget(entry) {
  if (entry.uiWidget) return entry.uiWidget;
  const dt = (entry.dataType || 'STRING').toString().toLowerCase();
  const hasEnum = Array.isArray(entry.enumValues) && entry.enumValues.length > 0;
  if (dt === 'boolean')                                        return 'toggle';
  if (dt === 'enum' || hasEnum)                               return 'dropdown';
  if (entry.minValue != null && entry.maxValue != null)       return 'slider';
  if (dt === 'gauge')                                         return 'gauge';
  if (dt === 'counter')                                       return 'counter';
  return 'textfield';
}

/** Parameters whose value is a credential — the UI masks them by default. */
const SENSITIVE_RE = /(passphrase|password|passwd|secret|\bkey\b|community)/i;

/** Bump when the persisted wireframe shape changes — older stored wireframes are rebuilt on read. */
const WIREFRAME_SCHEMA_VERSION = 2;

// ── Duplicate-ID deduplication (mirrors Java parser prefix logic) ─────────────

/**
 * Within a single group, parameter IDs must be unique.
 * If the definition has duplicates (same id in different sub-groups), prefix them
 * with their sub-group, matching what the Java XmlProductDefinitionParser does.
 */
function deduplicateIds(params) {
  const seen = new Map();   // parameterId → count
  for (const p of params) {
    seen.set(p.parameterId, (seen.get(p.parameterId) || 0) + 1);
  }
  const prefixed = params.map((p) => {
    if (seen.get(p.parameterId) > 1 && p.subGroup) {
      return { ...p, parameterId: `${p.subGroup}_${p.parameterId}` };
    }
    return p;
  });
  // Last resort: still-colliding ids (same id in the same sub-group) get a numeric suffix,
  // so every parameter of a group has a unique id.
  const used = new Map();
  return prefixed.map((p) => {
    const n = (used.get(p.parameterId) || 0) + 1;
    used.set(p.parameterId, n);
    return n > 1 ? { ...p, parameterId: `${p.parameterId}_${n}` } : p;
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_WIDGETS = new Set(['textfield', 'slider', 'dropdown', 'toggle', 'gauge', 'counter', 'readonly']);
const VALID_DATATYPES = new Set(['STRING', 'INTEGER', 'GAUGE', 'COUNTER', 'BOOLEAN', 'ENUM',
  'IPADDRESS', 'OCTET_STRING', 'TIMETICKS', 'OID', 'BITS']);

/**
 * Validate a parameter entry during wireframe build.
 * Returns an array of validation-error strings (empty = OK).
 */
function validateParameter(entry, groupId) {
  const errs = [];
  if (!entry.parameterId) errs.push(`[${groupId}] parameter missing id`);
  if (!entry.displayName)  errs.push(`[${groupId}::${entry.parameterId}] missing displayName`);
  const dt = (entry.dataType || '').toUpperCase();
  if (dt && !VALID_DATATYPES.has(dt)) errs.push(`[${groupId}::${entry.parameterId}] unknown dataType "${dt}"`);
  if (entry.uiWidget && !VALID_WIDGETS.has(entry.uiWidget))
    errs.push(`[${groupId}::${entry.parameterId}] unknown uiWidget "${entry.uiWidget}"`);
  if (entry.enumValues && !Array.isArray(entry.enumValues))
    errs.push(`[${groupId}::${entry.parameterId}] enumValues must be an array`);
  return errs;
}

// ── Core builder ──────────────────────────────────────────────────────────────

/**
 * Build a Node View wireframe from parameter registry entries.
 *
 * @param {object}   definition   Output of liveParameters.loadDefinition()
 *                                { productDefinitionId, versionId, registryVersion, entries[] }
 * @param {object}   [options]
 * @param {boolean}  [options.strict=false]  Throw on validation errors instead of logging them.
 * @returns {{ wireframe: object, parameterCount: number, groupCount: number, validationErrors: string[] }}
 */
function buildWireframe(definition, { strict = false } = {}) {
  const { productDefinitionId, versionId, registryVersion, entries = [] } = definition;

  if (!productDefinitionId) throw new Error('buildWireframe: productDefinitionId is required');

  // ── 1. Group entries (same logic as liveParameters.groupEntries) ───────────
  const groupMap = new Map();   // groupId → { groupId, displayOrder, params[] }
  for (const entry of entries) {
    const gid = entry.groupId || 'default';
    if (!groupMap.has(gid)) {
      groupMap.set(gid, {
        groupId:      gid,
        displayOrder: entry.groupDisplayOrder || groupMap.size + 1,
        params:       [],
      });
    }
    groupMap.get(gid).params.push(entry);
  }

  // ── 2. Sort groups by their displayOrder ───────────────────────────────────
  const sortedGroups = [...groupMap.values()]
    .sort((a, b) => a.displayOrder - b.displayOrder);

  // ── 3. Build each group ────────────────────────────────────────────────────
  const validationErrors = [];
  let totalParams = 0;

  const groups = sortedGroups.map((g, gi) => {
    // Sort parameters within the group: explicit displayOrder first, then document order
    // (never alphabetical — the definition's own order is the hierarchy order).
    const sortedParams = g.params
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ka = a.e.displayOrder > 0 ? a.e.displayOrder : Number.MAX_SAFE_INTEGER;
        const kb = b.e.displayOrder > 0 ? b.e.displayOrder : Number.MAX_SAFE_INTEGER;
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      })
      .map((x) => x.e);

    // Validate and deduplicate
    const allErrs = sortedParams.flatMap((e) => validateParameter(e, g.groupId));
    validationErrors.push(...allErrs);

    const deduped = deduplicateIds(sortedParams);

    // Collect ordered unique sub-groups (order of first appearance in the definition)
    const subGroups = [];
    for (const p of deduped) {
      if (p.subGroup && !subGroups.includes(p.subGroup)) subGroups.push(p.subGroup);
    }

    // Build parameter specs
    const parameters = deduped.map((e, pi) => {
      const dataType       = (e.dataType || 'STRING').toString();
      const effectiveWidget = deriveWidget(e);
      return {
        parameterId:     e.parameterId,
        displayName:     e.displayName || e.parameterId,
        dataType,
        unit:            e.unit            || null,
        uiWidget:        e.uiWidget        || null,
        effectiveWidget,
        readOnly:        e.readOnly === true,
        snmpOid:         e.snmpOid         || null,
        hidden:          e.hidden === true,
        displayOrder:    pi + 1,                 // final, gap-free position within the group
        subGroup:        e.subGroup        || null,
        enumValues:      Array.isArray(e.enumValues) ? e.enumValues : [],
        options:         parseEnumOptions(e.enumValues),
        minValue:        e.minValue        ?? null,
        maxValue:        e.maxValue        ?? null,
        defaultValue:    e.defaultValue    ?? null,
        description:     e.description     || null,
        thresholds:      e.thresholds      || null,
        sensitive:       SENSITIVE_RE.test(`${e.parameterId} ${e.displayName || ''}`),
        uiVisibleTo:     e.uiVisibleTo     || null,   // kept for server-side role filtering at runtime
      };
    });

    totalParams += parameters.length;

    return {
      groupId:             g.groupId,
      label:               g.groupId.charAt(0).toUpperCase() + g.groupId.slice(1).replace(/[-_]/g, ' '),
      displayOrder:        gi + 1,
      pollIntervalSeconds: parseInt(process.env.LIVE_POLL_INTERVAL_SECONDS || '60', 10),
      subGroups,
      parameters,
    };
  });

  // ── 4. Validate globally ───────────────────────────────────────────────────
  // Duplicate group IDs
  const groupIds = groups.map((g) => g.groupId);
  const dupGroups = groupIds.filter((id, i) => groupIds.indexOf(id) !== i);
  if (dupGroups.length) validationErrors.push(`Duplicate group IDs: ${dupGroups.join(', ')}`);

  // Duplicate parameter IDs within each group
  for (const g of groups) {
    const pids = g.parameters.map((p) => p.parameterId);
    const dups = pids.filter((id, i) => pids.indexOf(id) !== i);
    if (dups.length) validationErrors.push(`[${g.groupId}] duplicate parameter IDs after dedup: ${dups.join(', ')}`);
  }

  if (strict && validationErrors.length > 0) {
    throw new Error(`Wireframe validation failed:\n${validationErrors.join('\n')}`);
  }

  return {
    wireframe: { groups },
    parameterCount: totalParams,
    groupCount:     groups.length,
    validationErrors,
  };
}

module.exports = { buildWireframe, deriveWidget, validateParameter, deduplicateIds, WIREFRAME_SCHEMA_VERSION };

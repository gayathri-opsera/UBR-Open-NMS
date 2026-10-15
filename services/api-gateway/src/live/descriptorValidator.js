'use strict';

/**
 * Descriptor Validator — Lint Step
 * =================================
 * Validates a parsed canonical descriptor against the rules in the PPT (Slide 9)
 * and the PDL requirements (PDL-002 through PDL-009).
 *
 * This runs at the "Lint" stage of the pipeline:
 *   Author → [Lint] → Simulate → Certify → Publish
 *
 * Returns { errors: string[], warnings: string[] }.
 * Errors block activation; warnings are informational.
 *
 * The canonical descriptor shape expected here matches the output of definitionParser.js
 * extended with the 6-part structure:
 * {
 *   identity:     { vendor, productFamily, model, variants, firmwareRange, matchRules[] }
 *   capabilities: { protocols[], features{} }
 *   config:       { groups[{ groupId, label, parameters[{ ... }] }] }
 *   monitor:      { groups[{ ... }] }
 *   alarms:       { mappings[{ ... }] }
 *   operations:   { actions[{ ... }] }
 * }
 */

// ── OID format ────────────────────────────────────────────────────────────────
const OID_RE = /^\.?(\d+\.)*\d+$/;
function isValidOid(s) {
  return s && OID_RE.test(String(s).trim());
}

// ── Canonical ID format: namespace.subns.name (e.g. wireless.ddrs.enable) ────
const CANONICAL_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,}$/;
function isValidCanonicalId(s) {
  return s && CANONICAL_ID_RE.test(String(s).trim());
}

// ── SNMP data types ───────────────────────────────────────────────────────────
const VALID_DATA_TYPES = new Set([
  'STRING', 'INTEGER', 'GAUGE', 'COUNTER', 'COUNTER64', 'BOOLEAN', 'ENUM',
  'IPADDRESS', 'OCTET_STRING', 'TIMETICKS', 'OID', 'BITS', 'UNSIGNED32',
]);

// ── Widget types ──────────────────────────────────────────────────────────────
const VALID_WIDGETS = new Set([
  // Standard widgets
  'textfield', 'text', 'slider', 'dropdown', 'select', 'toggle', 'checkbox',
  'gauge', 'counter', 'readonly', 'datatable', 'number',
  // Secure input
  'password', 'secret',
  // Custom
  'table', 'chart', 'json',
]);

// ── Access modes ──────────────────────────────────────────────────────────────
const VALID_ACCESS = new Set(['read-only', 'read-write', 'write-only', 'ro', 'rw', 'wo']);

// ── Match-rule protocols ──────────────────────────────────────────────────────
const VALID_PROTOCOLS = new Set(['snmp', 'tr069', 'netconf', 'rest']);

/**
 * Validate the Identity section (PDL-002, PDL-003).
 */
function validateIdentity(identity, errors, warnings) {
  if (!identity) { errors.push('Identity section is missing'); return; }

  if (!identity.vendor || !identity.vendor.trim())
    errors.push('Identity.vendor is required');
  if (!identity.model || !identity.model.trim())
    errors.push('Identity.model is required');
  if (!identity.productFamily || !identity.productFamily.trim())
    warnings.push('Identity.productFamily is recommended');
  if (!Array.isArray(identity.variants) || identity.variants.length === 0)
    warnings.push('Identity.variants should list at least one variant (e.g. BTS, CPE)');

  // Match rules (PDL-003)
  if (!Array.isArray(identity.matchRules) || identity.matchRules.length === 0) {
    errors.push('Identity.matchRules must define at least one device-matching rule (PDL-003)');
  } else {
    identity.matchRules.forEach((r, i) => {
      // protocol is optional (new schema uses field+op+value without protocol)
      if (r.protocol && !VALID_PROTOCOLS.has((r.protocol || '').toLowerCase()))
        warnings.push(`Identity.matchRules[${i}]: unknown protocol "${r.protocol}" (snmp|tr069|netconf|rest)`);
      if (!r.field || !String(r.field).trim())
        errors.push(`Identity.matchRules[${i}]: field is required`);
      if (!r.value || !String(r.value).trim())
        errors.push(`Identity.matchRules[${i}]: value is required`);
    });
  }
}

/**
 * Validate a parameter group's parameters (PDL-004, PDL-005).
 * Returns duplicate IDs found within the group.
 */
function validateParameterGroup(group, sectionName, errors, warnings) {
  if (!group.groupId || !group.groupId.trim())
    errors.push(`${sectionName}: a group is missing its groupId`);

  const seenIds = new Map(); // parameterId → count
  const params = group.parameters || [];

  if (params.length === 0) {
    warnings.push(`${sectionName}/${group.groupId || '?'}: group has no parameters`);
    return [];
  }

  params.forEach((p, pi) => {
    const loc = `${sectionName}/${group.groupId || '?'}[${pi}]`;

    // Required: parameterId
    if (!p.parameterId && !p.id)
      errors.push(`${loc}: parameterId is required (PDL-004)`);
    const pid = (p.parameterId || p.id || '').trim();
    if (pid) seenIds.set(pid, (seenIds.get(pid) || 0) + 1);

    // Required: displayName
    if (!p.displayName && !p.label && !p.name)
      warnings.push(`${loc}: displayName is recommended`);

    // Data type validation
    const dt = ((p.dataType || p.type || 'STRING')).toUpperCase();
    if (!VALID_DATA_TYPES.has(dt))
      errors.push(`${loc}: unknown dataType "${dt}"`);

    // SNMP OID format
    if (p.snmpOid && !isValidOid(p.snmpOid))
      errors.push(`${loc}: snmpOid "${p.snmpOid}" is not a valid OID`);

    // Widget
    if (p.uiWidget && !VALID_WIDGETS.has(p.uiWidget))
      warnings.push(`${loc}: unknown uiWidget "${p.uiWidget}"`);

    // Enum: must have enumValues list
    if (dt === 'ENUM' && (!Array.isArray(p.enumValues) || p.enumValues.length === 0))
      errors.push(`${loc}: ENUM parameter must have enumValues list`);

    // Table parameters (PDL-005)
    if (p.uiWidget === 'datatable' || p.isTable) {
      if (!p.tableId && !p.snmpTableOid)
        warnings.push(`${loc}: table parameter should declare tableId or snmpTableOid (PDL-005)`);
      if (!p.rowKey)
        warnings.push(`${loc}: table parameter should declare rowKey (PDL-005)`);
    }

    // Range sanity
    if (p.minValue != null && p.maxValue != null && p.minValue > p.maxValue)
      errors.push(`${loc}: minValue (${p.minValue}) > maxValue (${p.maxValue})`);
  });

  // Report duplicates within the group
  const dups = [];
  for (const [id, count] of seenIds.entries()) {
    if (count > 1) dups.push(id);
  }
  if (dups.length > 0)
    errors.push(`${sectionName}/${group.groupId || '?'}: duplicate parameter IDs: ${dups.join(', ')} (PDL-005)`);

  return dups;
}

/**
 * Validate a section (Config, Monitor) that contains parameter groups.
 * Also checks for duplicates ACROSS all groups in the section (PDL-004).
 */
function validateParameterSection(section, sectionName, errors, warnings) {
  if (!section) { warnings.push(`${sectionName} section is missing`); return; }

  const groups = section.groups || [];
  if (groups.length === 0) { warnings.push(`${sectionName}: no parameter groups defined`); return; }

  const seenGroupIds = new Set();
  const globalIds = new Map(); // parameterId → groupId (first occurrence)

  groups.forEach((g) => {
    if (seenGroupIds.has(g.groupId))
      errors.push(`${sectionName}: duplicate groupId "${g.groupId}"`);
    seenGroupIds.add(g.groupId);

    const params = g.parameters || [];
    params.forEach((p) => {
      const pid = p.parameterId || p.id || '';
      if (!pid) return;
      if (globalIds.has(pid)) {
        // Duplicate across groups — allowed only if they have different subGroups,
        // otherwise error. The wireframe builder deduplicates by subGroup prefix.
        const firstGroup = globalIds.get(pid);
        if (firstGroup === g.groupId) {
          // same group — already caught by validateParameterGroup
        } else {
          warnings.push(`${sectionName}: parameterId "${pid}" appears in both "${firstGroup}" and "${g.groupId}" — wireframe builder will prefix with subGroup`);
        }
      } else {
        globalIds.set(pid, g.groupId);
      }
    });

    validateParameterGroup(g, sectionName, errors, warnings);
  });
}

/**
 * Validate the Alarms section (PPT Slide 3, PDL-007).
 */
function validateAlarms(alarms, errors, warnings) {
  if (!alarms) { warnings.push('Alarms section is missing'); return; }

  const mappings = alarms.mappings || alarms.traps || alarms.events || [];
  if (mappings.length === 0) {
    warnings.push('Alarms: no trap/syslog mappings defined');
    return;
  }

  mappings.forEach((m, i) => {
    // Valid if it has a trapOid, a syslogPattern, an id, an eventId, or a canonicalType
    if (!m.id && !m.trapOid && !m.eventId && !m.syslogPattern && !m.canonicalType)
      errors.push(`Alarms.mappings[${i}]: id, trapOid, canonicalType, or syslogPattern is required`);
    if (!m.canonicalAlarm && !m.severity)
      warnings.push(`Alarms.mappings[${i}]: canonicalAlarm or severity is recommended`);
  });
}

/**
 * Validate the Operations section (PPT Slide 3).
 */
function validateOperations(operations, warnings) {
  if (!operations) { warnings.push('Operations section is missing'); return; }

  const actions = operations.actions || [];
  if (actions.length === 0)
    warnings.push('Operations: no actions defined (reboot, firmware upgrade, etc.)');
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Validate a canonical descriptor object.
 *
 * @param {object} descriptor  - Parsed canonical descriptor
 * @param {string} [version]   - Semantic version string (validated separately)
 * @returns {{ errors: string[], warnings: string[], isValid: boolean }}
 */
function validateDescriptor(descriptor, version) {
  const errors   = [];
  const warnings = [];

  if (!descriptor || typeof descriptor !== 'object') {
    return { errors: ['Descriptor is null or not an object'], warnings: [], isValid: false };
  }

  // ── Version format ─────────────────────────────────────────────────────────
  if (version) {
    const semverRe = /^\d+\.\d+\.\d+$/;
    if (!semverRe.test(String(version).trim()))
      errors.push(`version "${version}" must be in semver format (MAJOR.MINOR.PATCH)`);
  }

  // ── Identity (PDL-002, PDL-003) ────────────────────────────────────────────
  validateIdentity(descriptor.identity, errors, warnings);

  // ── Capabilities (PPT Slide 3) ─────────────────────────────────────────────
  if (!descriptor.capabilities) {
    warnings.push('Capabilities section is missing');
  } else {
    const protocols = descriptor.capabilities.protocols || [];
    protocols.forEach((p) => {
      // protocols may be objects { type, version, defaultPort } or plain strings
      const protoStr = typeof p === 'object' ? (p.type || '') : (p || '');
      if (!VALID_PROTOCOLS.has(protoStr.toLowerCase()))
        warnings.push(`Capabilities: unknown protocol "${protoStr}"`);
    });
  }

  // ── Config section (PDL-004) ───────────────────────────────────────────────
  validateParameterSection(descriptor.config, 'Config', errors, warnings);

  // ── Monitor section (PDL-007) ─────────────────────────────────────────────
  validateParameterSection(descriptor.monitor, 'Monitor', errors, warnings);

  // ── Alarms section ────────────────────────────────────────────────────────
  validateAlarms(descriptor.alarms, errors, warnings);

  // ── Operations section ────────────────────────────────────────────────────
  validateOperations(descriptor.operations, warnings);

  return {
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}

module.exports = { validateDescriptor, validateIdentity, validateParameterGroup };

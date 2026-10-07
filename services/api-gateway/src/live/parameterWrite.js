'use strict';

/**
 * Validation for Node View writes. Everything is decided by the product definition:
 * the parameter must exist in it, carry an OID and not be read-only, and the value must fit
 * the declared type, options and min/max. Nothing the definition does not declare is writable.
 */

const { parseEnumOptions } = require('./enumOptions');
const { normOid } = require('./liveParameters');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAX_VALUE_LENGTH = 255;

/** SNMP instance suffix: digits separated by dots ("1", "2.1"), or empty for a scalar. */
const INSTANCE_RE = /^\d+(\.\d+)*$/;

/**
 * Full OID of the instance to write.
 * A scalar (no instance) is addressed with the definition OID, plus ".0" when it is missing.
 */
function targetOid(entry, instance) {
  const base = normOid(entry.snmpOid);
  if (!base) return null;
  if (instance === '' || instance == null) return /\.0$/.test(base) ? base : `${base}.0`;
  return `${base}.${instance}`;
}

/**
 * @param {object} entry   registry entry (deduped id) for the parameter
 * @param {string} value   proposed value
 * @returns {string|null}  error message, or null when the value is acceptable
 */
function validateValue(entry, value) {
  if (typeof value !== 'string') return 'value must be a string';
  if (value.length > MAX_VALUE_LENGTH) return `value is longer than ${MAX_VALUE_LENGTH} characters`;
  const dataType = String(entry.dataType || '').toUpperCase();
  const options = parseEnumOptions(entry.enumValues);

  if ((dataType === 'ENUM' || entry.uiWidget === 'dropdown') && options.length) {
    const ok = options.some((o) => o.value === value);
    if (ok) return null;
    return `"${value}" is not one of the allowed values (${options.map((o) => o.value).join(', ')})`;
  }
  if (dataType === 'IPADDRESS') {
    return IPV4_RE.test(value) ? null : 'must be an IPv4 address (a.b.c.d)';
  }
  if (dataType === 'INTEGER') {
    if (!/^-?\d+$/.test(value)) return 'must be a whole number';
    const n = Number(value);
    if (entry.minValue != null && n < entry.minValue) return `must be at least ${entry.minValue}`;
    if (entry.maxValue != null && n > entry.maxValue) return `must be at most ${entry.maxValue}`;
    return null;
  }
  // STRING (and anything else): min/max, when declared, bound the length
  if (entry.minValue != null && value.length < entry.minValue) return `must be at least ${entry.minValue} characters`;
  if (entry.maxValue != null && value.length > entry.maxValue) return `must be at most ${entry.maxValue} characters`;
  return null;
}

/**
 * Resolve and validate one requested change against the definition.
 * @returns {{ ok: true, entry: object, oid: string } | { ok: false, code: string, error: string }}
 */
function planChange(definition, change) {
  const { groupId, parameterId } = change || {};
  const instance = change && change.instance != null ? String(change.instance) : '';
  if (!groupId || !parameterId) return { ok: false, code: 'VALIDATION_ERROR', error: 'groupId and parameterId are required' };
  if (instance !== '' && !INSTANCE_RE.test(instance)) return { ok: false, code: 'VALIDATION_ERROR', error: 'invalid instance index' };

  const entry = (definition.entries || []).find((e) => e.groupId === groupId && e.parameterId === parameterId);
  if (!entry) return { ok: false, code: 'UNKNOWN_PARAMETER', error: `"${groupId}/${parameterId}" is not in the product definition` };
  if (!normOid(entry.snmpOid)) return { ok: false, code: 'NOT_WRITABLE', error: 'the definition gives this parameter no OID' };
  if (entry.readOnly === true) return { ok: false, code: 'NOT_WRITABLE', error: 'parameter is read-only in the definition' };

  const err = validateValue(entry, change.value);
  if (err) return { ok: false, code: 'VALIDATION_ERROR', error: err };
  return { ok: true, entry, oid: targetOid(entry, instance), value: change.value };
}

module.exports = { validateValue, planChange, targetOid, INSTANCE_RE };

'use strict';

/**
 * Fixed-text and calculated fields of a Custom UI screen, filled into the Node View values map.
 * The wireframe marks them (valueSource 'static' | 'calc'); calculated fields read their inputs from hidden helper
 * parameters (one per input OID) that the normal poll already collects.
 */
const { computeSource } = require('./calcExpr');

const helperId = (fieldParameterId, name) => `__calc_${fieldParameterId}__${name}`;

function rawOf(rec) {
  if (!rec) return null;
  if (rec.value != null && rec.value !== '') return rec.value;
  const i = Array.isArray(rec.instances) ? rec.instances[0] : null;
  return i ? i.value : null;
}

/**
 * @param {Array} groups   wireframe groups (unfiltered, so hidden helpers are present)
 * @param {object} values  map 'groupId::parameterId' → record, modified in place
 * @returns the same map
 */
function applyDerivedValues(groups, values, now = new Date()) {
  const iso = now.toISOString();
  for (const g of groups || []) {
    for (const p of g.parameters || []) {
      const key = `${g.groupId}::${p.parameterId}`;
      if (p.valueSource === 'static') {
        values[key] = { value: p.staticValue ?? '', display: p.staticValue ?? '', freshnessState: 'FRESH', readStatus: 'SUCCESS', collectedAt: iso, isTable: false, instances: [], unit: p.unit || null, failureReason: null, source: 'static' };
      } else if (p.valueSource === 'calc' && p.calc && (p.calc.expr || p.calc.template)) {
        const raw = {};
        for (const inp of p.calc.inputs || []) raw[inp.name] = rawOf(values[`${g.groupId}::${helperId(p.parameterId, inp.name)}`]);
        const r = computeSource(p.calc.template != null && p.calc.template !== '' ? { ...p.calc, kind: 'template' } : { ...p.calc, kind: 'calc' }, raw);
        values[key] = r.ok
          ? { value: r.text, display: r.text, freshnessState: 'FRESH', readStatus: 'SUCCESS', collectedAt: iso, isTable: false, instances: [], unit: p.unit || null, failureReason: null, source: 'calc' }
          : { value: null, display: null, freshnessState: 'FAILED', readStatus: 'UNKNOWN', collectedAt: null, isTable: false, instances: [], unit: p.unit || null, failureReason: r.error, source: 'calc' };
      }
    }
  }
  return values;
}

module.exports = { applyDerivedValues, helperId };

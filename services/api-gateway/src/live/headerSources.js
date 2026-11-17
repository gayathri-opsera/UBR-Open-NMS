'use strict';

/**
 * Header bar of a device-layout Custom UI screen: product name, version line, uptime and the radio badges.
 * The DESIGN is fixed in the builder; the DATA comes from each device. Every header item has an optional data source
 * (see calcExpr.computeSource). The inputs of those sources are OIDs, read by the normal poll through hidden
 * parameters of a synthetic group, and resolved per device here.
 */
const { computeSource } = require('./calcExpr');

const HEADER_GROUP = '__header';
const ITEMS = ['productName', 'versionLine', 'uptime'];

const paramId = (path, name) => `h:${path}:${name}`;

/** The poll appends the scalar instance itself (.0), so an OID typed with it (sysUpTime.0) is read as the object OID. */
const objectOid = (oid) => String(oid).trim().replace(/\.0$/, '');

/** every { path, source } the header defines (radio badges: path radios.<i>.mode / radios.<i>.label) */
function sourcesOf(deviceUi) {
  const out = [];
  const ui = deviceUi || {};
  for (const k of ITEMS) if (ui.sources && ui.sources[k]) out.push({ path: k, source: ui.sources[k] });
  (ui.radios || []).forEach((r, i) => {
    if (r && r.labelSource) out.push({ path: `radios.${i}.label`, source: r.labelSource });
    if (r && r.modeSource) out.push({ path: `radios.${i}.mode`, source: r.modeSource });
  });
  return out;
}

/** hidden parameters the poll must read for the header: [{ parameterId, oid }] */
function headerInputs(deviceUi) {
  const out = [];
  const seen = new Set();
  const add = (pid, oid) => { if (oid && !seen.has(pid)) { seen.add(pid); out.push({ parameterId: pid, oid: objectOid(oid) }); } };
  for (const { path, source } of sourcesOf(deviceUi)) for (const i of source.inputs || []) if (i && i.name && i.oid) add(paramId(path, i.name), i.oid);
  (deviceUi && deviceUi.radios || []).forEach((r, i) => { if (r && r.upSource && r.upSource.oid) add(paramId(`radios.${i}.up`, 'status'), r.upSource.oid); });
  return out;
}

const rawOf = (rec) => {
  if (!rec) return null;
  if (rec.value != null && rec.value !== '') return rec.value;
  const i = Array.isArray(rec.instances) ? rec.instances[0] : null;
  return i ? i.value : null;
};

/**
 * Resolve the header for one device.
 * @returns { productName, versionLine, uptime, radios: [{ label, mode, up }] } — a value is null when the device returned
 *          nothing for it (the UI shows "—" / hides the badge); an item with no source falls back to the typed text.
 */
function resolveHeader(deviceUi, values) {
  const ui = deviceUi || {};
  const read = (path, source) => {
    const raw = {};
    for (const i of source.inputs || []) raw[i.name] = rawOf(values[`${HEADER_GROUP}::${paramId(path, i.name)}`]);
    const r = computeSource(source, raw);
    return r.ok ? r.text : null;
  };
  const item = (k) => (ui.sources && ui.sources[k] ? read(k, ui.sources[k]) : (ui[k] ?? null));
  const radios = [];
  (ui.radios || []).forEach((r, i) => {
    const mode = r.modeSource ? read(`radios.${i}.mode`, r.modeSource) : (r.mode ?? null);
    const label = r.labelSource ? read(`radios.${i}.label`, r.labelSource) : (r.label ?? null);
    let up = !!r.up;
    if (r.upSource && r.upSource.oid) {
      const v = rawOf(values[`${HEADER_GROUP}::${paramId(`radios.${i}.up`, 'status')}`]);
      const ok = (r.upSource.upValues || []).map((x) => String(x).trim());
      up = v != null && ok.includes(String(v).trim());
    }
    // a radio the device does not have (its mode source returned nothing) is left out
    if (r.modeSource && mode == null) return;
    radios.push({ label: label ?? '', mode: mode ?? '', up });
  });
  return { productName: item('productName'), versionLine: item('versionLine'), uptime: item('uptime'), radios };
}

module.exports = { HEADER_GROUP, headerInputs, resolveHeader, paramId, objectOid };

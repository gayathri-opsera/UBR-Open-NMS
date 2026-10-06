'use strict';

/**
 * Live device parameters — the bridge between an activated Product Definition and
 * the real device.
 *
 *   Product Definition (uploaded XML/JSON, activated)
 *        │  parameter_registry_entries  (ubrnms_productdef)
 *        ▼
 *   walk the definition's OID subtree on the device (read-only SNMP)
 *        │
 *        ▼
 *   device_parameter_values  (ubrnms)  — latest value(s) per definition parameter
 *        │
 *        ▼
 *   GET /api/framework/v1/devices/:id/parameters/current   (Node View)
 *
 * Only parameters that exist in the activated definition are ever read or exposed.
 * A parameter without an OID in the definition is reported UNMAPPED — nothing is guessed.
 */

const mongoose = require('mongoose');
const { walkSubtree, isUnreachable } = require('./snmpWalk');
const logger = require('../utils/logger');

const POLL_INTERVAL_SECONDS = parseInt(process.env.LIVE_POLL_INTERVAL_SECONDS || '60', 10);
const STALE_AFTER_SECONDS   = POLL_INTERVAL_SECONDS * 2;
/** An on-demand read re-polls the device when the stored values are older than this. */
const ON_DEMAND_MAX_AGE_SECONDS = 15;

const PRODUCTDEF_DB = process.env.PRODUCTDEF_DB_NAME || 'ubrnms_productdef';

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

function normOid(oid) {
  if (!oid) return null;
  const s = String(oid).trim();
  if (!s || s.toLowerCase() === 'none') return null;
  return s.startsWith('.') ? s : `.${s}`;
}

function oidParts(oid) { return oid.split('.').filter(Boolean); }

/**
 * Walk roots for a set of OIDs: OIDs are grouped by enterprise root (first 7 arcs,
 * e.g. 1.3.6.1.4.1.52619) and each group is walked from its longest common prefix,
 * so one walk covers the whole definition instead of one request per parameter.
 */
function walkRoots(oids) {
  const groups = new Map();
  for (const oid of oids) {
    const parts = oidParts(oid);
    const key = parts.slice(0, 7).join('.');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(parts);
  }
  const roots = [];
  for (const list of groups.values()) {
    let prefix = list[0];
    for (const p of list.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
      prefix = prefix.slice(0, i);
    }
    // Every OID identical (a lone leaf): walk its parent so the scalar/row instance is reached.
    if (list.every((p) => p.length === prefix.length)) prefix = prefix.slice(0, -1);
    roots.push(`.${prefix.join('.')}`);
  }
  return roots;
}

/**
 * Assign walked varbinds to definition parameters.
 * A varbind belongs to the parameter whose OID is its longest prefix (exact match or
 * followed by '.'); several parameters may legitimately share one OID.
 *
 * @returns {Map<string, Array<{index:string, raw:string}>>} keyed by `${groupId}::${parameterId}`
 */
function mapVarbinds(entries, varbinds) {
  const byOid = new Map();
  for (const e of entries) {
    const oid = normOid(e.snmpOid);
    if (!oid) continue;
    if (!byOid.has(oid)) byOid.set(oid, []);
    byOid.get(oid).push(e);
  }
  const oidsLongestFirst = Array.from(byOid.keys()).sort((a, b) => b.length - a.length);

  const result = new Map();
  for (const vb of varbinds) {
    const match = oidsLongestFirst.find((o) => vb.oid === o || vb.oid.startsWith(`${o}.`));
    if (!match) continue;
    const rest = vb.oid.slice(match.length).replace(/^\./, '');
    // a trailing ".0" scalar instance carries no row index
    const index = rest === '0' ? '' : rest;
    for (const e of byOid.get(match)) {
      const key = `${e.groupId}::${e.parameterId}`;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push({ index, raw: vb.value });
    }
  }
  return result;
}

/** Resolve an enum label from the raw SNMP value using the definition's "Label(n)" values. */
function resolveDisplay(entry, raw) {
  if (raw == null || raw === '') return raw;
  const values = Array.isArray(entry.enumValues) ? entry.enumValues : [];
  if (!values.length) return raw;
  const wanted = String(raw).trim();
  for (const v of values) {
    const m = /\((-?\d+)\)\s*$/.exec(v);
    if (m && m[1] === wanted) return v;
  }
  const exact = values.find((v) => v === wanted || v.split(':')[0] === wanted);
  return exact || raw;
}

/** Groups in definition order; parameters ordered by displayOrder then document order. */
function groupEntries(entries) {
  const sorted = [...entries].sort((a, b) => String(a._id).localeCompare(String(b._id)));
  const groups = new Map();
  for (const e of sorted) {
    const gid = e.groupId || 'default';
    if (!groups.has(gid)) groups.set(gid, { groupId: gid, params: [] });
    groups.get(gid).params.push(e);
  }
  for (const g of groups.values()) {
    g.params = g.params
      .map((p, i) => ({ p, i }))
      // displayOrder 0/unset keeps document order after any explicitly ordered parameters
      .sort((a, b) => {
        const ka = a.p.displayOrder > 0 ? a.p.displayOrder : Number.MAX_SAFE_INTEGER;
        const kb = b.p.displayOrder > 0 ? b.p.displayOrder : Number.MAX_SAFE_INTEGER;
        return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i;
      })
      .map((x) => x.p);
  }
  return Array.from(groups.values());
}

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Build the parameters/current response from the definition entries and the stored poll.
 */
function buildCurrentResponse({ device, definition, doc, now = new Date() }) {
  const stored = new Map();
  for (const v of (doc && doc.values) || []) stored.set(`${v.groupId}::${v.parameterId}`, v);
  const collectedAt = doc && doc.collectedAt ? new Date(doc.collectedAt) : null;
  const ageSeconds = collectedAt ? (now - collectedAt) / 1000 : Infinity;
  const pollStatus = (doc && doc.pollStatus) || 'NOT_POLLED';

  const groups = groupEntries(definition.entries).map((g) => ({
    groupId: g.groupId,
    label: titleCase(g.groupId),
    parameters: g.params.map((e) => {
      const key = `${e.groupId}::${e.parameterId}`;
      const hasOid = !!normOid(e.snmpOid);
      const sv = stored.get(key);
      const instances = ((sv && sv.instances) || []).map((i) => ({
        index: i.index, value: i.raw, display: resolveDisplay(e, i.raw),
      }));
      instances.sort((a, b) => a.index.localeCompare(b.index, undefined, { numeric: true }));

      let readStatus;
      if (!hasOid) readStatus = 'UNMAPPED';
      else if (instances.length) readStatus = 'SUCCESS';
      else if (collectedAt && pollStatus === 'OK') readStatus = 'NO_SUCH_OBJECT';
      else if (pollStatus === 'UNREACHABLE') readStatus = 'UNREACHABLE';
      else readStatus = 'UNKNOWN';

      let freshnessState;
      if (readStatus === 'UNMAPPED') freshnessState = 'UNMAPPED';
      else if (readStatus === 'SUCCESS') freshnessState = ageSeconds <= STALE_AFTER_SECONDS && pollStatus === 'OK' ? 'FRESH' : 'STALE';
      else freshnessState = 'FAILED';

      return {
        parameterId: e.parameterId,
        label: e.displayName || e.parameterId,
        dataType: (e.dataType || '').toString(),
        unit: e.unit || '',
        value: instances.length ? instances[0].value : null,
        display: instances.length ? instances[0].display : null,
        isTable: instances.length > 1 || (instances.length === 1 && instances[0].index !== ''),
        instances,
        freshnessState,
        readStatus,
        collectedAt: collectedAt ? collectedAt.toISOString() : null,
        lastSuccessAt: instances.length && collectedAt ? collectedAt.toISOString() : null,
        ...(readStatus === 'UNMAPPED' ? { failureReason: 'no OID in product definition' } : {}),
        ...(readStatus === 'UNREACHABLE' && doc && doc.pollError ? { failureReason: doc.pollError } : {}),
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        registryVersion: definition.registryVersion,
        productDefinitionId: definition.productDefinitionId,
        uiVisibleTo: e.uiVisibleTo, // consumed by the route's visibility filter, stripped there
      };
    }),
  }));

  return {
    status: 'ok',
    data: {
      deviceId: String(device._id),
      productDefinitionId: definition.productDefinitionId,
      registryVersion: definition.registryVersion,
      collectedAt: collectedAt ? collectedAt.toISOString() : null,
      pollStatus,
      ...(doc && doc.pollError && pollStatus !== 'OK' ? { pollError: doc.pollError } : {}),
      groups,
    },
  };
}

// ── Mongo access ──────────────────────────────────────────────────────────────

function client() {
  if (mongoose.connection.readyState !== 1) return null;
  return mongoose.connection.client;
}
function productDefDb() { const c = client(); return c ? c.db(PRODUCTDEF_DB) : null; }
function nmsDb() { return mongoose.connection.readyState === 1 ? mongoose.connection.db : null; }
function valuesCol() { const d = nmsDb(); return d ? d.collection('device_parameter_values') : null; }

/**
 * Load the ACTIVE version's parameter registry for a product definition.
 * @returns {Promise<null | { productDefinitionId, versionId, registryVersion, vendor, entries }>}
 */
async function loadDefinition(productDefinitionId) {
  const db = productDefDb();
  if (!db || !productDefinitionId) return null;
  const active = await db.collection('product_definition_active_versions').findOne({ productDefinitionId });
  if (!active) return null;
  const entries = await db.collection('parameter_registry_entries')
    .find({ productDefinitionId, versionId: active.activeVersionId }).toArray();
  if (!entries.length) return null;
  return {
    productDefinitionId,
    versionId: active.activeVersionId,
    registryVersion: String(active.registryVersion ?? ''),
    vendor: active.vendor || null,
    entries,
  };
}

/** The single active definition for a vendor, or null when there is none or it is ambiguous. */
async function findDefinitionIdByVendor(vendor) {
  const db = productDefDb();
  if (!db || !vendor || /^(unknown|not available)$/i.test(vendor)) return null;
  const rows = await db.collection('product_definition_active_versions')
    .find({ vendor: new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).toArray();
  return rows.length === 1 ? rows[0].productDefinitionId : null;
}

/**
 * Pick the product definition to link a device to: the first candidate that has an ACTIVE
 * registry, otherwise the single active definition of the device's vendor.
 * (Candidates can be stale ids — e.g. the gateway's built-in OID map names 'Configurations_GUI'
 * while the activated definition is 'eoc-configurations-gui'.)
 */
async function resolveDefinitionId(candidates, vendor) {
  for (const id of candidates) {
    if (id && await loadDefinition(id).catch(() => null)) return id;
  }
  return findDefinitionIdByVendor(vendor);
}

/**
 * Make sure the device points at an ACTIVE definition. A stale link (the definition was
 * re-created, or provisioning used a built-in id) is re-resolved by vendor and written back.
 * @returns {Promise<string|null>} the definition id, or null when none applies
 */
async function ensureDefinitionLink(device) {
  const id = await resolveDefinitionId([device.productDefinitionId], device.manufacturer || device.vendor);
  if (id && id !== device.productDefinitionId) {
    const c = client();
    if (c) {
      for (const dbName of ['ubrnms_inventory', 'ubrnms']) {
        await c.db(dbName).collection('devices')
          .updateOne({ _id: device._id }, { $set: { productDefinitionId: id, updatedAt: new Date() } }).catch(() => {});
      }
    }
    logger.info({ msg: 'device re-linked to active product definition', deviceId: String(device._id), from: device.productDefinitionId || null, to: id });
    device.productDefinitionId = id;
  }
  return id || null;
}

async function findDevice(deviceId) {
  const c = client();
  if (!c) return null;
  for (const dbName of ['ubrnms_inventory', 'ubrnms']) {
    try {
      const doc = await c.db(dbName).collection('devices').findOne({
        $or: [{ _id: deviceId }, { serialNumber: deviceId }, { deviceId }, { ipAddress: deviceId }],
      });
      if (doc) return doc;
    } catch { /* store missing */ }
  }
  return null;
}

// ── GPS ───────────────────────────────────────────────────────────────────────

const LAT_IDS = new Set(['latitude', 'lat', 'gpslatitude']);
const LNG_IDS = new Set(['longitude', 'lng', 'lon', 'gpslongitude']);

/**
 * If the definition declares latitude/longitude parameters, publish the live values
 * on the device record so the topology map shows the device-reported position.
 * Definitions without such parameters leave coordinates untouched.
 */
async function applyGps(device, definition, mapped) {
  const find = (ids) => definition.entries.find((e) => ids.has(String(e.parameterId).toLowerCase()));
  const latE = find(LAT_IDS);
  const lngE = find(LNG_IDS);
  if (!latE || !lngE) return false;
  const first = (e) => (mapped.get(`${e.groupId}::${e.parameterId}`) || [])[0];
  const lat = parseFloat(first(latE)?.raw);
  const lng = parseFloat(first(lngE)?.raw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return false;
  const c = client();
  if (!c) return false;
  const source = `snmp ${latE.snmpOid},${lngE.snmpOid}`;
  for (const dbName of ['ubrnms_inventory', 'ubrnms']) {
    await c.db(dbName).collection('devices').updateOne(
      { _id: device._id },
      { $set: { latitude: lat, longitude: lng, locationSource: source, updatedAt: new Date() } },
    ).catch(() => {});
  }
  try { require('../routes/topology.stub').bustTopologyCache(); } catch { /* optional */ }
  return true;
}

// ── Polling ───────────────────────────────────────────────────────────────────

function splitHostPort(device) {
  const raw = String(device.ipAddress || device.ip || '');
  const [host, p] = raw.includes(':') ? raw.split(':') : [raw, null];
  const port = parseInt(p, 10) || device.snmpPort || 161;
  return { host, port };
}

const inflight = new Map(); // deviceId → Promise

/**
 * Poll one device now: walk the definition's OID subtree, persist the values.
 * Concurrent calls for the same device share one walk. Never throws.
 */
function refreshDevice(device) {
  const key = String(device._id);
  if (inflight.has(key)) return inflight.get(key);
  const p = doRefresh(device).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doRefresh(device) {
  const col = valuesCol();
  if (!col) return { pollStatus: 'NOT_POLLED', error: 'database not connected' };
  const now = new Date();
  const base = {
    _id: String(device._id),
    deviceId: String(device._id),
    ipAddress: device.ipAddress,
    productDefinitionId: device.productDefinitionId || null,
    lastAttemptAt: now,
  };

  await ensureDefinitionLink(device);
  base.productDefinitionId = device.productDefinitionId || null;
  const definition = await loadDefinition(device.productDefinitionId).catch(() => null);
  if (!definition) {
    await col.updateOne({ _id: base._id }, { $set: { ...base, pollStatus: 'NOT_POLLED', pollError: 'no active product definition' } }, { upsert: true });
    return { pollStatus: 'NOT_POLLED' };
  }
  base.versionId = definition.versionId;
  base.registryVersion = definition.registryVersion;

  if (!device.snmpCommunity) {
    await col.updateOne({ _id: base._id }, { $set: { ...base, pollStatus: 'NO_CREDENTIALS', pollError: 'no SNMP credential stored for this device' } }, { upsert: true });
    return { pollStatus: 'NO_CREDENTIALS' };
  }

  const oids = definition.entries.map((e) => normOid(e.snmpOid)).filter(Boolean);
  const { host, port } = splitHostPort(device);
  try {
    const varbinds = [];
    for (const rootOid of walkRoots(oids)) {
      varbinds.push(...await walkSubtree({ host, port, community: device.snmpCommunity, rootOid }));
    }
    const mapped = mapVarbinds(definition.entries, varbinds);
    const values = Array.from(mapped.entries()).map(([k, instances]) => {
      const [groupId, parameterId] = k.split('::');
      return { groupId, parameterId, instances };
    });
    await col.replaceOne({ _id: base._id }, {
      ...base, pollStatus: 'OK', pollError: null, collectedAt: now, values,
    }, { upsert: true });
    await applyGps(device, definition, mapped).catch((e) => logger.warn({ msg: 'live GPS update failed', err: e.message }));
    logger.info({ msg: 'live parameters refreshed', deviceId: base._id, host, varbinds: varbinds.length, mapped: values.length });
    return { pollStatus: 'OK' };
  } catch (err) {
    const pollStatus = isUnreachable(err) ? 'UNREACHABLE' : 'ERROR';
    // keep the previous values/collectedAt so the UI can show them as stale
    await col.updateOne({ _id: base._id }, { $set: { ...base, pollStatus, pollError: err.message } }, { upsert: true });
    logger.warn({ msg: 'live parameter poll failed', deviceId: base._id, host, port, pollStatus, err: err.message });
    return { pollStatus, error: err.message };
  }
}

/**
 * Returns ONLY cached/stored parameter values — never triggers an SNMP walk.
 * Use this for Node View page loads to keep latency < 100 ms.
 * If no stored data exists yet, returns empty values (first background poll will populate).
 * @returns {Promise<{ http: number, body: object }>}
 */
async function getCachedOnly(device) {
  await ensureDefinitionLink(device);
  const definition = await loadDefinition(device.productDefinitionId).catch(() => null);
  if (!definition) {
    return { http: 200, body: { status: 'NO_ACTIVE_FRAMEWORK', error: {
      code: 'NO_ACTIVE_FRAMEWORK', message: 'This device has no active Product Definition framework association.' } } };
  }
  const col = valuesCol();
  const doc = col ? await col.findOne({ _id: String(device._id) }) : null;
  // Return whatever is cached — no SNMP triggered
  return { http: 200, body: buildCurrentResponse({ device, definition, doc }) };
}

/**
 * Current values for a device (parameters/current). Re-polls when the stored data is
 * older than ON_DEMAND_MAX_AGE_SECONDS or `force` is set.
 * @returns {Promise<{ http: number, body: object }>}
 */
async function getCurrent(device, { force = false } = {}) {
  await ensureDefinitionLink(device);
  const definition = await loadDefinition(device.productDefinitionId).catch(() => null);
  if (!definition) {
    return { http: 200, body: { status: 'NO_ACTIVE_FRAMEWORK', error: {
      code: 'NO_ACTIVE_FRAMEWORK', message: 'This device has no active Product Definition framework association.' } } };
  }
  const col = valuesCol();
  let doc = col ? await col.findOne({ _id: String(device._id) }) : null;
  const age = doc && doc.lastAttemptAt ? (Date.now() - new Date(doc.lastAttemptAt)) / 1000 : Infinity;
  if (force || age > ON_DEMAND_MAX_AGE_SECONDS) {
    await refreshDevice(device);
    doc = col ? await col.findOne({ _id: String(device._id) }) : null;
  }
  return { http: 200, body: buildCurrentResponse({ device, definition, doc }) };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let timer = null;

async function pollAll() {
  const db = nmsDb();
  if (!db) return;
  const devices = await db.collection('devices').find({
    isDeprovisioned: { $ne: true },
    snmpCommunity: { $nin: [null, ''] },
  }).toArray();
  const queue = [...devices];
  const worker = async () => { for (let d = queue.shift(); d; d = queue.shift()) await refreshDevice(d); };
  await Promise.all([worker(), worker(), worker()]);
}

function startScheduler() {
  if (timer || process.env.LIVE_POLL_DISABLED === 'true') return;
  const run = () => pollAll().catch((e) => logger.warn({ msg: 'live poll cycle failed', err: e.message }));
  setTimeout(run, 20_000).unref();
  timer = setInterval(run, POLL_INTERVAL_SECONDS * 1000);
  timer.unref();
  logger.info({ msg: 'live parameter polling scheduled', everySeconds: POLL_INTERVAL_SECONDS });
}

module.exports = {
  // pure
  normOid, walkRoots, mapVarbinds, resolveDisplay, groupEntries, buildCurrentResponse,
  // io
  loadDefinition, findDefinitionIdByVendor, resolveDefinitionId, ensureDefinitionLink, findDevice, refreshDevice, getCurrent, getCachedOnly, startScheduler, pollAll,
  POLL_INTERVAL_SECONDS,
};

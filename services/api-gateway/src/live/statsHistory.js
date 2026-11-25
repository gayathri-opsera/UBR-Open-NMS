'use strict';

/**
 * Statistics history — the numbers behind the Monitor > Graphs tab (up to 6 months).
 *
 * What is collected: a built-in catalog (statistics + link SNR) of every UBR650/655/660, whatever template the device uses; the
 * Graphs charts of a template only choose which of these metrics to draw. Read with SNMP GETs only.
 * Counters are stored as per-second rates. A template's `uiCharts` says which of these metrics a chart draws and which statistics
 * row belongs to its radio. Nothing is written to a device.
 *
 * Storage (MongoDB, db of the NMS):
 *   stats_raw     one document per device + sample, every STATS_HISTORY_INTERVAL_SECONDS (default 5 min), kept 8 days
 *   stats_hourly  one document per device + hour with the sum and count of every metric, kept 200 days (6 months + margin)
 * A query picks the resolution by range: a start within the last 7 days is read from raw samples, older ranges from the hourly
 * averages, and either is averaged into at most MAX_POINTS points. A metric is `param~instance` ('wirelessStatsTxThroughput~2',
 * link rows '2.1' are written '2-1' because a field name cannot contain a dot).
 */

const mongoose = require('mongoose');
const logger = require('../utils/logger');

const RAW_COL = 'stats_raw';
const HOURLY_COL = 'stats_hourly';
const RAW_KEEP_MS = 8 * 86400_000;
const HOURLY_KEEP_MS = 200 * 86400_000;
const RAW_QUERY_MS = 7 * 86400_000;           // a range starting within this window reads raw samples
const MAX_RANGE_MS = 190 * 86400_000;
const MAX_POINTS = 360;
const HOUR_MS = 3600_000;
const RANGES = { '1h': HOUR_MS, '1d': 86400_000, '1w': 7 * 86400_000, '1m': 30 * 86400_000, '3m': 90 * 86400_000, '6m': 183 * 86400_000 };
const BUCKETS_MS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60_000);

// ── pure helpers ──────────────────────────────────────────────────────────────

const encodeKey = (param, instance) => `${param}~${String(instance).replace(/\./g, '-')}`;
function decodeKey(key) {
  const i = key.lastIndexOf('~');
  return { param: key.slice(0, i), instance: key.slice(i + 1).replace(/-/g, '.') };
}

/** Table row `index` belongs to the radio `row`: '2' matches '2' (interface table) and '2.1', '2.2' (link table: radio.link). '' matches everything. */
function instanceMatches(index, row) {
  if (row === '' || row == null) return true;
  const i = String(index);
  return i === String(row) || i.startsWith(`${row}.`);
}

/** A number from a device value, or null for text, '-NA-' and the like. */
function numeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Per-second rate between two counter readings; null when time did not advance or the counter went back (reset / wrap). */
function rateOf(prev, cur, prevMs, curMs) {
  const dt = (curMs - prevMs) / 1000;
  if (!(dt > 0) || cur < prev) return null;
  return (cur - prev) / dt;
}

/** Which parameters a group's charts read: { param → { rate } }. */
function chartedParams(uiCharts) {
  const out = new Map();
  for (const c of (uiCharts && uiCharts.charts) || []) {
    for (const s of c.series || []) {
      const cur = out.get(s.param);
      out.set(s.param, { rate: !!s.rate || (cur ? cur.rate : false) });
    }
  }
  return out;
}

/**
 * The reading of one group → { metrics: { key → value }, counters: { key → raw counter } }.
 * `last` is the previous counters of the same group ({ ms, counters }): a counter becomes a per-second rate against it, and
 * has no point on the first reading.
 */
function extractSample(uiCharts, groupResponse, nowMs, last) {
  const metrics = {};
  const counters = {};
  const wanted = chartedParams(uiCharts);
  for (const p of (groupResponse && groupResponse.parameters) || []) {
    const spec = wanted.get(p.parameterId);
    if (!spec) continue;
    for (const inst of p.instances || []) {
      if (!instanceMatches(inst.index, uiCharts.row)) continue;
      const n = numeric(inst.value);
      if (n === null) continue;
      const key = encodeKey(p.parameterId, inst.index);
      if (spec.rate) {
        counters[key] = n;
        if (last && last.counters && key in last.counters) {
          const r = rateOf(last.counters[key], n, last.ms, nowMs);
          if (r !== null) metrics[key] = r;
        }
      } else {
        metrics[key] = n;
      }
    }
  }
  return { metrics, counters };
}

/** {range:'1h'|…|'custom', from, to} → { from, to } (ms); null when the request is not valid. */
function resolveRange({ range, from, to }, nowMs) {
  if (range && RANGES[range]) return { from: nowMs - RANGES[range], to: nowMs };
  const f = Date.parse(from);
  const t = to ? Date.parse(to) : nowMs;
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return null;
  if (t - f > MAX_RANGE_MS) return { from: t - MAX_RANGE_MS, to: t };
  return { from: f, to: t };
}

/** Bucket width: the smallest "nice" step that keeps the chart at most MAX_POINTS points and is not finer than the source resolution. */
function pickBucket(spanMs, minMs) {
  const want = Math.max(minMs, spanMs / MAX_POINTS);
  return BUCKETS_MS.find((b) => b >= want) || BUCKETS_MS[BUCKETS_MS.length - 1];
}

/** Add (sum, count) of a metric into its bucket. */
function accumulate(acc, key, ms, bucketMs, sum, count) {
  const b = Math.floor(ms / bucketMs) * bucketMs;
  const m = acc.get(key) || new Map();
  const cur = m.get(b) || { sum: 0, n: 0 };
  cur.sum += sum; cur.n += count;
  m.set(b, cur);
  acc.set(key, m);
}
const rawToBuckets = (docs, bucketMs) => {
  const acc = new Map();
  for (const d of docs) for (const [k, v] of Object.entries(d.v || {})) accumulate(acc, k, new Date(d.ts).getTime(), bucketMs, v, 1);
  return acc;
};
const hourlyToBuckets = (docs, bucketMs) => {
  const acc = new Map();
  for (const d of docs) for (const [k, s] of Object.entries(d.sum || {})) accumulate(acc, k, new Date(d.h).getTime(), bucketMs, s, (d.cnt && d.cnt[k]) || 0);
  return acc;
};
/** bucket maps → [{ param, instance, points: [[ms, average]] }] */
function toSeries(acc, params) {
  const out = [];
  for (const [key, m] of acc) {
    const { param, instance } = decodeKey(key);
    if (params && !params.includes(param)) continue;
    const points = [...m.entries()].filter(([, v]) => v.n > 0).sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, v.sum / v.n]);
    if (points.length) out.push({ param, instance, points });
  }
  return out.sort((a, b) => (a.param + a.instance).localeCompare(b.param + b.instance, undefined, { numeric: true }));
}

// ── storage ───────────────────────────────────────────────────────────────────

const db = () => (mongoose.connection.readyState === 1 ? mongoose.connection.db : null);
let indexed = false;
async function ensureIndexes(d) {
  if (indexed) return;
  indexed = true;
  try {
    await d.collection(RAW_COL).createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
    await d.collection(RAW_COL).createIndex({ d: 1, ts: 1 });
    await d.collection(HOURLY_COL).createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
    await d.collection(HOURLY_COL).createIndex({ d: 1, g: 1, h: 1 }, { unique: true });
  } catch (e) { indexed = false; logger.warn({ msg: 'stats history: index creation failed', err: e.message }); }
}

async function store(deviceId, groupId, metrics, ts) {
  const d = db();
  const keys = Object.keys(metrics);
  if (!d || !keys.length) return 0;
  await ensureIndexes(d);
  const ms = ts.getTime();
  await d.collection(RAW_COL).insertOne({ d: deviceId, g: groupId, ts, exp: new Date(ms + RAW_KEEP_MS), v: metrics });
  const inc = { n: 1 };
  for (const k of keys) { inc[`sum.${k}`] = metrics[k]; inc[`cnt.${k}`] = 1; }
  const h = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
  await d.collection(HOURLY_COL).updateOne({ d: deviceId, g: groupId, h }, { $inc: inc, $setOnInsert: { exp: new Date(h.getTime() + HOURLY_KEEP_MS) } }, { upsert: true });
  return keys.length;
}

/**
 * The history of a device. Samples are read by device + metric, not by chart group: a metric is `param~instance`, so the history
 * survives a template change (new group ids) or a re-provision. `groupId` is accepted for compatibility and not used.
 */
async function queryHistory({ deviceId, groupId, range, from, to, params }, nowMs = Date.now()) {
  const r = resolveRange({ range, from, to }, nowMs);
  if (!r) return { error: 'BAD_RANGE' };
  const d = db();
  if (!d) return { error: 'NO_DATABASE' };
  const raw = r.from >= nowMs - RAW_QUERY_MS;
  const bucketMs = pickBucket(r.to - r.from, raw ? 5 * 60_000 : HOUR_MS);
  const docs = raw
    ? await d.collection(RAW_COL).find({ d: deviceId, ts: { $gte: new Date(r.from), $lte: new Date(r.to) } }, { projection: { ts: 1, v: 1 } }).sort({ ts: 1 }).toArray()
    : await d.collection(HOURLY_COL).find({ d: deviceId, h: { $gte: new Date(Math.floor(r.from / HOUR_MS) * HOUR_MS), $lte: new Date(r.to) } }, { projection: { h: 1, sum: 1, cnt: 1 } }).sort({ h: 1 }).toArray();
  const series = toSeries(raw ? rawToBuckets(docs, bucketMs) : hourlyToBuckets(docs, bucketMs), params);
  return { from: r.from, to: r.to, bucketSeconds: bucketMs / 1000, source: raw ? 'raw' : 'hourly', samples: docs.length, series };
}

// ── collector ─────────────────────────────────────────────────────────────────

const lastByGroup = new Map();   // `${deviceId}|${groupId}` → { ms, counters }

const MAX_LINKS_BY_GET = 8;   // links per radio the GET fallback asks for (radio.1 … radio.8)

/**
 * GET-only read of a chart group for agents that cannot be walked (the UBR660 times out on table walks but answers GETs): the
 * radio's own row of each statistics column, and `row.1 … row.8` of the per-link columns. Shaped like a group of the current-values
 * response, or null when the device answered nothing.
 */
async function readByGet(live, device, groupId, uiCharts) {
  const { getOids } = require('./snmpWalk');
  const { rebaseEntries } = require('./oidAliases');
  const definition = await live.loadEffectiveDefinition(device.productDefinitionId);
  if (!definition || !device.snmpCommunity) return null;
  const perLink = new Set();
  for (const c of uiCharts.charts || []) for (const sr of c.series || []) if (sr.perLink) perLink.add(sr.param);
  const wanted = chartedParams(uiCharts);
  const entries = rebaseEntries(definition.entries.filter((e) => e.groupId === groupId && wanted.has(e.parameterId)), device.sysObjectID);
  const norm = (o) => String(o || '').replace(/^\./, '');
  const targets = [];
  for (const e of entries) {
    const base = norm(e.snmpOid);
    if (!base) continue;
    if (perLink.has(e.parameterId)) for (let k = 1; k <= MAX_LINKS_BY_GET; k += 1) targets.push({ e, index: `${uiCharts.row}.${k}`, oid: `${base}.${uiCharts.row}.${k}` });
    else targets.push({ e, index: String(uiCharts.row), oid: `${base}.${uiCharts.row}` });
  }
  if (!targets.length) return null;
  const { host, port } = live.splitHostPort(device);
  const got = await getOids({ host, port, community: device.snmpCommunity, oids: targets.map((t) => t.oid), timeoutMs: 2000, retries: 1 }).catch(() => []);
  const byOid = new Map(got.map((r) => [norm(r.oid), r.value]));
  const params = new Map();
  for (const t of targets) {
    if (!byOid.has(t.oid)) continue;
    const list = params.get(t.e.parameterId) || [];
    list.push({ index: t.index, value: String(byOid.get(t.oid)) });
    params.set(t.e.parameterId, list);
  }
  return params.size ? { groupId, parameters: [...params].map(([parameterId, instances]) => ({ parameterId, instances })) } : null;
}

// ── built-in catalog: collected for every UBR650/655/660 whatever template the device uses ─────────────────────────────

const STATS_ROOT = '.1.3.6.1.4.1.14125.123';
const OLD_ROOT = '.1.3.6.1.4.1.52619';   // older UBR650/655 firmware serves the same tree under this root (see oidAliases.js)
/** Statistics table (one row per radio: 1 = 2.4 GHz, 2 = Radio 1, 3 = Radio 2) and link table columns; `rate` = counter → per-second rate. */
const STATS_COLUMNS = [
  ['wirelessStatsTxThroughput', 30], ['wirelessStatsRxThroughput', 31], ['wirelessStatsRTXPercent', 37],
  ['wirelessStatsDataTxTotalPackets', 4, true], ['wirelessStatsDataRxTotalPackets', 5, true],
  ['wirelessStatsDataTxMulticastPackets', 6, true], ['wirelessStatsDataRxMulticastPackets', 7, true],
  ['wirelessStatsDataTxUnicastPackets', 8, true], ['wirelessStatsDataRxUnicastPackets', 9, true],
  ['wirelessStatsDataTxBroadcastPackets', 32, true], ['wirelessStatsDataRxBroadcastPackets', 33, true],
  ['wirelessStatsCRCErrors', 28, true], ['wirelessStatsFrameErrors', 29, true],
];
const LINK_COLUMNS = [['assocLocalSNRA1', 13], ['assocLocalSNRA2', 14], ['assocRemoteSNRA1', 15], ['assocRemoteSNRA2', 16]];
const STATS_ROWS = [1, 2, 3];
const LINK_RADIOS = [2, 3];
const LINKS_PER_RADIO = MAX_LINKS_BY_GET;

const isUbr = (sysObjectID) => /^\.?1\.3\.6\.1\.4\.1\.(14125\.123|52619)(\.|$)/.test(String(sysObjectID || ''));

/** The catalog's targets for a device: [{ param, index, oid, rate }]. */
function builtinTargets(sysObjectID) {
  const root = /^\.?1\.3\.6\.1\.4\.1\.52619/.test(String(sysObjectID || '')) ? OLD_ROOT : STATS_ROOT;
  const out = [];
  for (const [param, col, rate] of STATS_COLUMNS) for (const r of STATS_ROWS) out.push({ param, index: String(r), oid: `${root}.1.3.1.1.${col}.${r}`.replace(/^\./, ''), rate: !!rate });
  for (const [param, col] of LINK_COLUMNS) for (const r of LINK_RADIOS) for (let k = 1; k <= LINKS_PER_RADIO; k += 1) out.push({ param, index: `${r}.${k}`, oid: `${root}.1.3.3.1.${col}.${r}.${k}`.replace(/^\./, ''), rate: false });
  return out;
}

/** Raw readings [{ oid, value }] of the catalog → { metrics, counters } (counters become per-second rates against `last`). */
function sampleFromCatalog(targets, got, nowMs, last) {
  const byOid = new Map((got || []).map((r) => [String(r.oid || '').replace(/^\./, ''), r.value]));
  const metrics = {};
  const counters = {};
  for (const t of targets) {
    if (!byOid.has(t.oid)) continue;
    const n = numeric(byOid.get(t.oid));
    if (n === null) continue;
    const key = encodeKey(t.param, t.index);
    if (t.rate) {
      counters[key] = n;
      if (last && last.counters && key in last.counters) {
        const r = rateOf(last.counters[key], n, last.ms, nowMs);
        if (r !== null) metrics[key] = r;
      }
    } else metrics[key] = n;
  }
  return { metrics, counters };
}

const lastByDevice = new Map();   // deviceId → { ms, counters }
const HISTORY_KEY = 'device';     // samples are stored per device, not per template group

/** GET-only read of the catalog (never a table walk, so it is safe on agents that struggle with walks, like the UBR660). */
async function collectDevice(live, device) {
  if (!isUbr(device.sysObjectID) || !device.snmpCommunity) return 0;
  const { getOids } = require('./snmpWalk');
  const targets = builtinTargets(device.sysObjectID);
  const { host, port } = live.splitHostPort(device);
  const got = [];
  for (let i = 0; i < targets.length; i += 40) {
    got.push(...(await getOids({ host, port, community: device.snmpCommunity, oids: targets.slice(i, i + 40).map((t) => t.oid), timeoutMs: 2000, retries: 1 }).catch(() => [])));
  }
  const ms = Date.now();
  const sample = sampleFromCatalog(targets, got, ms, lastByDevice.get(String(device._id)));
  if (Object.keys(sample.counters).length) lastByDevice.set(String(device._id), { ms, counters: sample.counters });
  return store(String(device._id), HISTORY_KEY, sample.metrics, new Date(ms));
}

// ── live stream: one fresh GET read of a radio's statistics for the Monitor > Graphs tab (every 5 s while it is open) ─────

const LIVE_CACHE_MS = 3000;       // charts with different frequencies share one device read
const liveCache = new Map();      // `${deviceId}|${row}` → { at, promise }
const liveLast = new Map();       // `${deviceId}|${row}` → { ms, counters } (previous live reading, for per-second rates)

/**
 * The current values of one radio's chart metrics: { ts, values: { 'param~instance': number } }. SNMP GET only (the radio's own
 * statistics row and link rows), never a walk, and never a write. Counters are rates against the previous live reading, so the
 * first reading of a counter has no value. Concurrent callers within LIVE_CACHE_MS get the same reading.
 */
function liveSample(live, device, row) {
  const key = `${device._id}|${row}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_CACHE_MS) return hit.promise;
  const promise = (async () => {
    if (!isUbr(device.sysObjectID) || !device.snmpCommunity) return null;
    const { getOids } = require('./snmpWalk');
    const targets = builtinTargets(device.sysObjectID).filter((t) => instanceMatches(t.index, row));
    const { host, port } = live.splitHostPort(device);
    const got = [];
    for (let i = 0; i < targets.length; i += 40) {
      got.push(...(await getOids({ host, port, community: device.snmpCommunity, oids: targets.slice(i, i + 40).map((t) => t.oid), timeoutMs: 2000, retries: 0 }).catch(() => [])));
    }
    const ms = Date.now();
    const sample = sampleFromCatalog(targets, got, ms, liveLast.get(key));
    if (Object.keys(sample.counters).length) liveLast.set(key, { ms, counters: sample.counters });
    return { ts: ms, values: sample.metrics };
  })();
  liveCache.set(key, { at: Date.now(), promise });
  promise.catch(() => liveCache.delete(key));
  return promise;
}

let running = false;
async function collectAll(live) {
  const d = db();
  if (!d || running) return;
  running = true;
  try {
    const devices = await d.collection('devices').find({ isDeprovisioned: { $ne: true }, snmpCommunity: { $nin: [null, ''] } }).toArray();
    const queue = [...devices];
    let points = 0;
    const worker = async () => {
      for (let dev = queue.shift(); dev; dev = queue.shift()) {
        try { points += await collectDevice(live, dev); } catch (e) { logger.warn({ msg: 'stats history: device failed', deviceId: String(dev._id), err: e.message }); }
      }
    };
    await Promise.all([worker(), worker()]);
    logger.info({ msg: 'stats history collected', devices: devices.length, points });
  } finally { running = false; }
}

let timer = null;
function startCollector(live) {
  if (timer || process.env.STATS_HISTORY_DISABLED === 'true') return;
  const every = Math.max(60, parseInt(process.env.STATS_HISTORY_INTERVAL_SECONDS || '300', 10));
  const run = () => collectAll(live).catch((e) => logger.warn({ msg: 'stats history cycle failed', err: e.message }));
  setTimeout(run, 45_000).unref();
  timer = setInterval(run, every * 1000);
  timer.unref();
  logger.info({ msg: 'stats history collection scheduled', everySeconds: every });
}

module.exports = {
  // pure
  encodeKey, decodeKey, instanceMatches, numeric, rateOf, chartedParams, extractSample, resolveRange, pickBucket, rawToBuckets, hourlyToBuckets, toSeries,
  // io
  store, queryHistory, liveSample, readByGet, builtinTargets, sampleFromCatalog, isUbr, collectDevice, collectAll, startCollector,
  RANGES, MAX_POINTS, RAW_QUERY_MS,
};

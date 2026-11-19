'use strict';

/**
 * Topology fields — which parameters of a product definition feed the Topology map / device panel.
 *
 * Definition-driven: an entry (or Custom UI parameter) can say `topologyField: 'rssi' | 'a1Rssi' | 'a2Rssi' | 'snr' | 'channel'
 * | 'mac' | 'ethernetSpeed' | 'duplex'`. Entries without that attribute are recognised from their parameterId / display name
 * with vendor-neutral rules, so an existing definition works unchanged. A field with no matching parameter stays empty — the
 * map never shows a made-up value.
 */

const FIELDS = ['a1Rssi', 'a2Rssi', 'rssi', 'snr', 'channel', 'mac', 'ethernetSpeed', 'duplex'];

const text = (e) => `${String(e.parameterId || '').replace(/([a-z])([A-Z])/g, '$1 $2')} ${e.displayName || ''}`.toLowerCase().replace(/[_\-.]+/g, ' ');
const NOT = /remote|peer|neighbou?r|noise|util|count|threshold|limit|min|max|avg|tx|rx|rate|power|width|list|scan|table/;

// ordered: the first rule that matches any entry of the definition wins for that field
const RULES = {
  a1Rssi: [(t) => /(signal|rssi)/.test(t) && /\b(a1|chain ?1|ant(enna)? ?1)\b|a1\b/.test(t) && !NOT.test(t.replace(/(tx|rx)/g, ''))],
  a2Rssi: [(t) => /(signal|rssi)/.test(t) && /\b(a2|chain ?2|ant(enna)? ?2)\b|a2\b/.test(t) && !NOT.test(t.replace(/(tx|rx)/g, ''))],
  rssi: [
    (t) => /\brssi\b/.test(t) && !/\b(a1|a2)\b|chain|remote|peer/.test(t),
    (t) => /(signal ?(strength|level)?)$/.test(t.trim()) && !/\b(a1|a2)\b|chain|remote|peer|noise/.test(t),
  ],
  snr: [(t) => /snr|signal ?to ?noise/.test(t) && !/remote|peer/.test(t)],
  channel: [
    (t) => /active ?channel|operating ?channel|current ?channel/.test(t),
    (t) => /\bchannel$/.test(t.trim()) && !NOT.test(t),
  ],
  mac: [
    (t) => /(ethernet|eth|lan|mgmt|management|base|device|system).*mac|mac ?address/.test(t) && !/remote|peer|assoc|ath|wlan|wireless|client|bssid|radio/.test(t),
  ],
  ethernetSpeed: [(t) => /(ethernet|eth|lan|port).*(speed|rate)|link ?speed/.test(t) && !/tx|rx|through|limit/.test(t)],
  duplex: [(t) => /duplex/.test(t)],
};

/** Map<field, entry[]> — the entries that feed each topology field of this definition. */
function resolveTopologyEntries(entries) {
  const out = new Map();
  const list = (entries || []).filter((e) => e && e.parameterId);
  const explicit = list.filter((e) => FIELDS.includes(e.topologyField));
  for (const e of explicit) { if (!out.has(e.topologyField)) out.set(e.topologyField, []); out.get(e.topologyField).push(e); }
  for (const f of FIELDS) {
    if (out.has(f)) continue;                       // an explicit mapping always wins
    const candidates = list.filter((e) => !e.topologyField);
    for (const rule of RULES[f]) {
      const hit = candidates.filter((e) => rule(text(e)));
      if (hit.length) { out.set(f, hit); break; }
    }
  }
  return out;
}

/** Set of `groupId::parameterId` keys the topology reads (so the background poll keeps them fresh). */
function topologyKeys(entries) {
  const keys = new Set();
  for (const list of resolveTopologyEntries(entries).values()) for (const e of list) keys.add(`${e.groupId}::${e.parameterId}`);
  return keys;
}

const numOf = (raw) => { const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(String(raw ?? '')); return m ? Number(m[1]) : null; };
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/**
 * Readings for one device from its stored values.
 * @param {Map<string,object[]>} map   resolveTopologyEntries(definition.entries)
 * @param {Array} values               device_parameter_values.values
 */
function topologyMetrics(map, values) {
  const stored = new Map((values || []).map((v) => [`${v.groupId}::${v.parameterId}`, v.instances || []]));
  const inst = (field) => (map.get(field) || []).flatMap((e) =>
    (stored.get(`${e.groupId}::${e.parameterId}`) || []).filter((i) => i && i.raw != null && i.raw !== '' && !i.placeholder));
  const bestNum = (field) => { const n = inst(field).map((i) => numOf(i.raw)).filter((x) => x != null); return n.length ? Math.max(...n) : null; };
  const a1 = bestNum('a1Rssi');
  const a2 = bestNum('a2Rssi');
  const direct = bestNum('rssi');
  const rssi = direct ?? (a1 != null || a2 != null ? Math.max(...[a1, a2].filter((x) => x != null)) : null);
  // channel of the radio that carries the signal readings (table index "<radio>.<n>" or "<radio>"), else the first valid one
  const sigIdx = [...inst('a1Rssi'), ...inst('a2Rssi'), ...inst('rssi')].map((i) => String(i.index ?? '').split('.')[0]);
  const chans = inst('channel').filter((i) => /^\d+$/.test(String(i.raw).trim()) && Number(i.raw) > 0);
  const ch = chans.find((i) => sigIdx.includes(String(i.index ?? '').split('.')[0]) && sigIdx[0] !== '') || (sigIdx.length ? null : chans[0]) || null;
  const mac = inst('mac').map((i) => String(i.raw).trim()).find((m) => MAC_RE.test(m) && !/^(00[:-]){5}00$/.test(m)) || null;
  const speed = inst('ethernetSpeed').map((i) => numOf(i.raw)).find((n) => n != null && n > 0);
  const duplex = inst('duplex')[0];
  return {
    rssi, a1Rssi: a1, a2Rssi: a2, snr: bestNum('snr'),
    operatingChannel: ch ? String(ch.raw).trim() : null,
    macAddress: mac,
    ethernetSpeed: speed != null ? `${speed} Mbps` : null,
    duplex: duplex ? String(duplex.raw) : null,
  };
}

module.exports = { FIELDS, resolveTopologyEntries, topologyKeys, topologyMetrics };

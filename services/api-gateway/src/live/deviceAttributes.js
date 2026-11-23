'use strict';

/**
 * Device attributes — the role (BTS / CPE / IDU) and GPS position a device reports about itself.
 *
 * JavaScript counterpart of services/discovery-service/internal/scanner/device_attributes.go, so
 * the gateway's own SNMP discovery path (single IPs, host:port, ICMP bypass) classifies a device
 * exactly like the Java/Go discovery service does. Every field is optional: an empty value means
 * the device did not report it — never a guessed default.
 *
 * Read-only: only SNMP GET / GET-NEXT requests are issued.
 */

const { walkSubtree } = require('./snmpWalk');
const { canonicalOid, rebaseOid } = require('./oidAliases');
const { runExclusive } = require('./snmpGate');

/**
 * Vendor-specific OIDs that report role and GPS, matched by the enterprise prefix of sysObjectID
 * (longest prefix wins). Add a vendor here once its MIB is known.
 *
 * EOC Networks / UBR (enterprise 52619, also served as 14125.123 by newer firmware — see
 * oidAliases.js): wirelessRadioMode of the Configurations_GUI definition. The radio table column
 * reports "ap" (access point) or "sta" (station) PER RADIO, so a unit's role is decided from the
 * whole column: a unit with any radio in station mode is a CPE (its backhaul radio is linked to a
 * BTS — the 2.4 GHz management radio of a CPE is still an AP), otherwise it is a BTS. This agrees
 * with the unit's own web UI, which shows mode "sta" / "ap". Integer enums 1 = BTS, 2 = CPE are
 * accepted as well.
 */
const ATTRIBUTE_PROFILES = [
  {
    enterprisePrefix: '.1.3.6.1.4.1.52619',
    roleOID: '.1.3.6.1.4.1.52619.1.1.1.1.1.2',
    roleValues: { 1: 'BTS', 2: 'CPE' },
    // sysInfoGeolat / sysInfoGeolong (SENAO-MIB): decimal degrees as text, e.g. "17.431604 N". A unit without a
    // GPS fix answers the placeholder "-NA-", which parseCoordinate rejects — so "no coordinates", never a guess.
    latitudeOID:  '.1.3.6.1.4.1.52619.1.2.2.5',
    longitudeOID: '.1.3.6.1.4.1.52619.1.2.2.6',
    coordScale: 0,
    // Second place the MIB publishes a position: management.gps gpsLatitude / gpsLongitude ("17.431604 N"), read-write.
    // Tried only when sysInfo has none.
    altCoordinateOIDs: [{ lat: '.1.3.6.1.4.1.52619.1.2.7.4', lng: '.1.3.6.1.4.1.52619.1.2.7.5' }],
    // Used only when the role column answers with a placeholder: the link table never does. wirelessStatsRemotePartners
    // (rows 2, 3 = the two backhaul radios) counts associated stations; assocIP lists the peer addresses.
    topology: {
      partnersOID: '.1.3.6.1.4.1.52619.1.3.1.1.3', partnerRows: [2, 3],
      assocIpOID:  '.1.3.6.1.4.1.52619.1.3.3.1.4',
    },
  },
];

const withDot = (oid) => `.${String(oid || '').replace(/^\./, '')}`;

function matchAttributeProfile(sysObjectID) {
  const oid = withDot(canonicalOid(sysObjectID));
  let best = null;
  for (const p of ATTRIBUTE_PROFILES) {
    if ((oid === p.enterprisePrefix || oid.startsWith(`${p.enterprisePrefix}.`)) &&
        (!best || p.enterprisePrefix.length > best.enterprisePrefix.length)) {
      best = p;
    }
  }
  return best;
}

/**
 * Map a raw role value to BTS / CPE / IDU. Integer enums use the profile map; text such as
 * "ap", "BTS(ap)" or "CPE(sta)" is matched by keyword. Returns '' when unrecognised.
 */
function normaliseRole(raw, enumMap = {}) {
  const key = String(raw == null ? '' : raw).trim();
  if (Object.prototype.hasOwnProperty.call(enumMap, key)) return enumMap[key];
  const v = key.toLowerCase();
  if (v.includes('bts') || v.includes('(ap)') || v === 'ap' || v.includes('access point') || v.includes('master')) return 'BTS';
  if (v.includes('cpe') || v.includes('(sta)') || v === 'sta' || v.includes('station') || v.includes('slave')) return 'CPE';
  if (v.includes('idu')) return 'IDU';
  return '';
}

const NMEA = /^(\d{2,3})(\d{2}\.\d+)\s*([NSEW])$/;

/**
 * Convert a device-reported coordinate to decimal degrees, or null when it is not one.
 * Accepts decimal degrees ("28.6139", "-77.2"), a hemisphere suffix ("28.6139N"), NMEA ddmm.mmmm
 * ("2836.834N") and integers scaled by `scale` when scale > 0.
 */
function parseCoordinate(raw, scale, limit) {
  let s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) return null;
  const nmea = NMEA.exec(s);
  if (nmea) {
    let v = parseFloat(nmea[1]) + parseFloat(nmea[2]) / 60;
    if (nmea[3] === 'S' || nmea[3] === 'W') v = -v;
    return Math.abs(v) <= limit ? v : null;
  }
  let sign = 1;
  if (s.length > 1 && 'NSEW'.includes(s[s.length - 1])) {
    if (s[s.length - 1] === 'S' || s[s.length - 1] === 'W') sign = -1;
    s = s.slice(0, -1).trim();
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  let v = parseFloat(s);
  if (scale > 0) v /= scale;
  v *= sign;
  return Math.abs(v) <= limit ? v : null;
}

const LOCATION_PAIR = /(-?\d{1,3}\.\d+)\s*[NS]?[\s,;/]+(?:[a-zA-Z]+\s*[:=]\s*)?(-?\d{1,3}\.\d+)/;

/**
 * Extract a latitude/longitude pair written into free-text sysLocation ("28.6139,77.2090").
 * Both numbers must have a fractional part so "Floor 2, Room 5" is never taken for coordinates.
 */
function parseLocationCoordinates(sysLocation) {
  const m = LOCATION_PAIR.exec(String(sysLocation || ''));
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

/** SNMP GET of several OIDs → { oid: value } for the ones the device actually has. */
function snmpGetOids({ host, port, community, timeoutMs = 2500 }) {
  const snmp = require('net-snmp'); // lazy: keeps the pure helpers above loadable without the library
  // one request at a time per device (snmpGate.js)
  return (oids) => runExclusive(host, port, () => new Promise((resolve) => {
    // these agents can ignore the first request or two after idling → retry, don't conclude "no role"
    const session = snmp.createSession(host, community, { port, retries: 3, timeout: timeoutMs, version: snmp.Version2c });
    const done = (out) => { try { session.close(); } catch { /* already closed */ } resolve(out); };
    session.on('error', () => done({}));
    session.get(oids.map((o) => o.replace(/^\./, '')), (err, varbinds) => {
      if (err || !varbinds) return done({});
      const out = {};
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue;
        out[withDot(vb.oid)] = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
      }
      return done(out);
    });
  }));
}

/** First non-empty value at `oid`: the bare OID, the scalar (.0), the first row (.1), then a walk. */
async function readFirstInstance({ get, walk }, oid) {
  const base = withDot(oid);
  const candidates = [base, `${base}.0`, `${base}.1`];
  const values = await get(candidates).catch(() => ({}));
  for (const c of candidates) {
    const v = String(values[c] == null ? '' : values[c]).trim();
    if (v) return { oid: c, value: v };
  }
  const entries = await walk(base).catch(() => []);
  for (const e of entries) {
    const v = String(e.value == null ? '' : e.value).trim();
    if (v) return { oid: e.oid, value: v };
  }
  return null;
}

/**
 * Role of a unit from its radio-mode column: CPE when any radio is a station, otherwise the first
 * recognised role. Falls back to the first scalar/row instance when the column cannot be walked.
 * @returns {Promise<{ role: string, source: string } | null>}
 */
async function readRole(reader, roleOid, roleValues) {
  const rows = (await reader.walk(roleOid).catch(() => []))
    .map((e) => ({ oid: e.oid, raw: String(e.value == null ? '' : e.value).trim() }))
    .map((r) => ({ ...r, role: normaliseRole(r.raw, roleValues) }))
    .filter((r) => r.role);
  if (!rows.length) {
    const hit = await readFirstInstance(reader, roleOid).catch(() => null);
    const role = hit && normaliseRole(hit.value, roleValues);
    return role ? { role, source: `snmp ${hit.oid}=${hit.value}`, radioCount: null } : null;
  }
  const decisive = rows.find((r) => r.role === 'CPE') || rows[0];
  const rowIndex = (r) => r.oid.slice(r.oid.lastIndexOf('.') + 1);
  const detail = rows.length > 1 ? ` (radios: ${rows.map((r) => `${rowIndex(r)}=${r.raw}`).join(', ')})` : '';
  return { role: decisive.role, source: `snmp ${decisive.oid}=${decisive.raw}${detail}`, radioCount: countMainRadios(rows.map((r) => rowIndex(r))) };
}

/**
 * Number of main radios from the radio-mode rows that report a real mode. Row 1 of the wireless table is the 2.4 GHz
 * service radio, rows 2+ are Radio 1, Radio 2 … (a radio the unit lacks answers no mode, so it is not in `rows`).
 * Null when no row identifies a main radio (placeholder agents) — the count is then unknown, never guessed.
 */
function countMainRadios(rowIndexes) {
  const n = new Set(rowIndexes.map((i) => parseInt(i, 10)).filter((i) => Number.isFinite(i) && i >= 2)).size;
  return n > 0 ? n : null;
}

/**
 * Read role and GPS position from the device. Best effort: any SNMP failure leaves the matching
 * fields empty. `io` ({ get, walk }) can be injected for tests.
 *
 * @returns {Promise<{ role: string, roleSource: string, latitude: number|null,
 *                     longitude: number|null, locationSource: string }>}
 */
/**
 * Role from the link topology, for agents that hide the radio-mode column. A CPE has exactly one uplink and a BTS
 * serves one or more stations, so:
 *   2+ associated stations                       → BTS
 *   1 station whose peer itself serves 2+        → CPE (linked to that BTS)
 *   anything else (e.g. a lone 1:1 link)         → unknown — never guessed
 * Single small GETs on the unit and on its peer; the result is labelled "inferred" so it is never mistaken for a role
 * the device reported.
 */
async function inferRoleFromLink({ host, port = 161, community, sysObjectID, io }) {
  const profile = matchAttributeProfile(sysObjectID);
  const t = profile && profile.topology;
  if (!t) return null;
  const getFor = (h) => (io && io.getFor ? io.getFor(h) : snmpGetOids({ host: h, port, community }));
  const partnersOf = async (h) => {
    const oids = t.partnerRows.map((r) => rebaseOid(`${t.partnersOID}.${r}`, sysObjectID));
    const got = await getFor(h)(oids);
    const counts = oids.map((o) => parseInt(got[withDot(o)], 10)).filter((n) => Number.isFinite(n) && n >= 0);
    return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
  };
  const mine = await partnersOf(host).catch(() => null);
  if (mine == null) return null;
  if (mine >= 2) return { role: 'BTS', source: `inferred from the link table (${mine} associated stations)` };
  if (mine !== 1) return null;
  // one uplink: ask who it is (a narrow vendor walk, ≤ a few rows) and whether that peer serves several stations
  const reader = io && io.walk ? io.walk : (rootOid) => walkSubtree({ host, port, community, rootOid, timeoutMs: 2500, retries: 2, overallTimeoutMs: 8000 });
  const rows = await reader(rebaseOid(t.assocIpOID, sysObjectID)).catch(() => []);
  const peer = (rows.find((r) => /^\d+\.\d+\.\d+\.\d+$/.test(String(r.value))) || {}).value;
  if (!peer) return null;
  const theirs = await partnersOf(peer).catch(() => null);
  return theirs != null && theirs >= 2
    ? { role: 'CPE', source: `inferred from the link table (single uplink to ${peer}, which serves ${theirs} stations)` } : null;
}

async function fetchDeviceAttributes({ host, port = 161, community, sysObjectID, sysLocation, io, webCredentials }) {
  const attrs = { role: '', roleSource: '', radioCount: null, latitude: null, longitude: null, locationSource: '' };
  const reader = io || {
    get:  snmpGetOids({ host, port, community }),
    walk: (rootOid) => walkSubtree({ host, port, community, rootOid, timeoutMs: 2500, retries: 3, overallTimeoutMs: 18000 }),
  };

  const profile = matchAttributeProfile(sysObjectID);
  if (profile) {
    if (profile.roleOID) {
      // addressed under the device's own enterprise root (see oidAliases.js)
      const found = await readRole(reader, rebaseOid(profile.roleOID, sysObjectID), profile.roleValues).catch(() => null);
      if (found) { attrs.role = found.role; attrs.roleSource = found.source; attrs.radioCount = found.radioCount == null ? null : found.radioCount; }
    }
  }

  // The position the device publishes (GET only — see fetchDeviceGps).
  if (profile) {
    const gps = await fetchDeviceGps({ host, port, community, sysObjectID, sysLocation: '', get: reader.get }).catch(() => null);
    if (gps && gps.locationSource !== 'sysLocation') {
      attrs.latitude = gps.latitude; attrs.longitude = gps.longitude; attrs.locationSource = gps.locationSource;
    }
  }

  // Some firmware answers the role column with placeholders ("-NA-") while the device's own UI states it.
  // With a web login on the credential profile, ask the device the way an operator would.
  if (!attrs.role && webCredentials && webCredentials.user && webCredentials.pass) {
    const role = await require('./webSource').fetchRole(host, webCredentials);
    if (role) { attrs.role = role; attrs.roleSource = 'device web UI'; }
  }

  if (!attrs.role) {
    const inferred = await inferRoleFromLink({ host, port, community, sysObjectID, io }).catch(() => null);
    if (inferred) { attrs.role = inferred.role; attrs.roleSource = inferred.source; }
  }

  if (attrs.latitude == null) {
    const loc = parseLocationCoordinates(sysLocation);
    if (loc) { attrs.latitude = loc.latitude; attrs.longitude = loc.longitude; attrs.locationSource = 'sysLocation'; }
  }
  return attrs;
}

/**
 * The position the device itself publishes — GET only, two scalars (+ sysLocation when the GPS objects are empty).
 * Used by the poller, so it never walks. Returns null when the device reports no usable coordinates.
 * `get` ({ oid → value }) can be injected for tests.
 *
 * @returns {Promise<{ latitude: number, longitude: number, locationSource: string } | null>}
 */
async function fetchDeviceGps({ host, port = 161, community, sysObjectID, sysLocation, get }) {
  const profile = matchAttributeProfile(sysObjectID);
  const read = get || snmpGetOids({ host, port, community });
  if (profile && profile.latitudeOID && profile.longitudeOID) {
    const pairs = [{ lat: profile.latitudeOID, lng: profile.longitudeOID }, ...(profile.altCoordinateOIDs || [])]
      .map((p) => ({ lat: withDot(`${rebaseOid(p.lat, sysObjectID)}.0`), lng: withDot(`${rebaseOid(p.lng, sysObjectID)}.0`) }));
    const got = await read(pairs.flatMap((p) => [p.lat, p.lng])).catch(() => ({}));   // one GET for every candidate
    for (const p of pairs) {
      const lat = parseCoordinate(got[p.lat], profile.coordScale, 90);
      const lng = parseCoordinate(got[p.lng], profile.coordScale, 180);
      if (lat != null && lng != null && !(lat === 0 && lng === 0)) {
        return { latitude: lat, longitude: lng, locationSource: `snmp ${p.lat},${p.lng}` };
      }
    }
  }
  // Some units carry the position as text in sysLocation instead.
  let loc = sysLocation;
  if (loc == null) {
    const SYS_LOCATION = '.1.3.6.1.2.1.1.6.0';
    loc = (await read([SYS_LOCATION]).catch(() => ({})))[SYS_LOCATION];
  }
  const parsed = parseLocationCoordinates(loc);
  return parsed ? { ...parsed, locationSource: 'sysLocation' } : null;
}

module.exports = {
  fetchDeviceGps, fetchDeviceAttributes, inferRoleFromLink, matchAttributeProfile, normaliseRole,
  parseCoordinate, parseLocationCoordinates, readFirstInstance, readRole, ATTRIBUTE_PROFILES,
};

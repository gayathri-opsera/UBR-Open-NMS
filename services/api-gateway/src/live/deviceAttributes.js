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
    return role ? { role, source: `snmp ${hit.oid}=${hit.value}` } : null;
  }
  const decisive = rows.find((r) => r.role === 'CPE') || rows[0];
  const rowIndex = (r) => r.oid.slice(r.oid.lastIndexOf('.') + 1);
  const detail = rows.length > 1 ? ` (radios: ${rows.map((r) => `${rowIndex(r)}=${r.raw}`).join(', ')})` : '';
  return { role: decisive.role, source: `snmp ${decisive.oid}=${decisive.raw}${detail}` };
}

/**
 * Read role and GPS position from the device. Best effort: any SNMP failure leaves the matching
 * fields empty. `io` ({ get, walk }) can be injected for tests.
 *
 * @returns {Promise<{ role: string, roleSource: string, latitude: number|null,
 *                     longitude: number|null, locationSource: string }>}
 */
async function fetchDeviceAttributes({ host, port = 161, community, sysObjectID, sysLocation, io }) {
  const attrs = { role: '', roleSource: '', latitude: null, longitude: null, locationSource: '' };
  const reader = io || {
    get:  snmpGetOids({ host, port, community }),
    walk: (rootOid) => walkSubtree({ host, port, community, rootOid, timeoutMs: 2500, retries: 3, overallTimeoutMs: 18000 }),
  };

  const profile = matchAttributeProfile(sysObjectID);
  if (profile) {
    if (profile.roleOID) {
      // addressed under the device's own enterprise root (see oidAliases.js)
      const found = await readRole(reader, rebaseOid(profile.roleOID, sysObjectID), profile.roleValues).catch(() => null);
      if (found) { attrs.role = found.role; attrs.roleSource = found.source; }
    }
    if (profile.latitudeOID && profile.longitudeOID) {
      const lat = await readFirstInstance(reader, rebaseOid(profile.latitudeOID, sysObjectID)).catch(() => null);
      const lng = await readFirstInstance(reader, rebaseOid(profile.longitudeOID, sysObjectID)).catch(() => null);
      const latV = lat && parseCoordinate(lat.value, profile.coordScale, 90);
      const lngV = lng && parseCoordinate(lng.value, profile.coordScale, 180);
      if (latV != null && lngV != null && !(latV === 0 && lngV === 0)) {
        attrs.latitude = latV;
        attrs.longitude = lngV;
        attrs.locationSource = `snmp ${profile.latitudeOID},${profile.longitudeOID}`;
      }
    }
  }

  if (attrs.latitude == null) {
    const loc = parseLocationCoordinates(sysLocation);
    if (loc) { attrs.latitude = loc.latitude; attrs.longitude = loc.longitude; attrs.locationSource = 'sysLocation'; }
  }
  return attrs;
}

module.exports = {
  fetchDeviceAttributes, matchAttributeProfile, normaliseRole,
  parseCoordinate, parseLocationCoordinates, readFirstInstance, readRole, ATTRIBUTE_PROFILES,
};

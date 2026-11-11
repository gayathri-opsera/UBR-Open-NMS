'use strict';
/**
 * Discovery scope patterns — expands every "wildcard-ish" IPv4 form into concrete host IPs.
 *
 * Supported (per octet, mix freely):
 *   10.0.150.*            any value 0–255 (last-octet "*" skips .0 and .255)
 *   10.0.*.*  /  10.0.*   whole /16 (trailing octets may be omitted when the last given one is "*")
 *   10.0.150.100-120      octet range
 *   10.0.140-150.*        range + wildcard
 *   10.0.150.1-10.0.150.50  full start–end range (inclusive, start <= end)
 * Plain IPs and CIDRs are NOT patterns (isPattern returns false) and keep their normal handling.
 */

const MAX_HOSTS = 65536; // same ceiling as a /16

const OCTET_RE = /^(\*|\d{1,3}|\d{1,3}-\d{1,3})$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function ipToInt(ip) {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
}
function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function isFullRange(v) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return m || null;
}

/** True when v is a wildcard / octet-range / full-range expression (not a plain IP or CIDR). */
function isPattern(value) {
  const v = String(value || '').trim();
  if (!v || v.includes('/') || IPV4_RE.test(v)) return false;
  if (isFullRange(v)) return true;
  const parts = v.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every((p) => OCTET_RE.test(p))) return false;
  return parts.some((p) => p === '*' || p.includes('-'));
}

function octetValues(part, isLast, wasWildcardPad) {
  if (part === '*') {
    const lo = isLast ? 1 : 0;
    const hi = isLast ? 254 : 255;
    return [lo, hi];
  }
  if (part.includes('-')) {
    const [a, b] = part.split('-').map(Number);
    return [a, b];
  }
  const n = Number(part);
  return [n, n];
}

/**
 * Expand a pattern to an array of IPs. Throws Error(message) for invalid or oversized patterns.
 */
function expandPattern(value, { max = MAX_HOSTS } = {}) {
  const v = String(value || '').trim();
  const full = isFullRange(v);
  if (full) {
    const [s, e] = [full[1], full[2]];
    for (const ip of [s, e]) {
      if (ip.split('.').some((o) => Number(o) > 255)) throw new Error(`"${v}" has an octet above 255`);
    }
    const a = ipToInt(s);
    const b = ipToInt(e);
    if (a > b) throw new Error(`"${v}": start IP must be <= end IP`);
    if (b - a + 1 > max) throw new Error(`"${v}" expands to ${b - a + 1} hosts (max ${max})`);
    const out = [];
    for (let n = a; n <= b; n++) out.push(intToIp(n));
    return out;
  }
  if (!isPattern(v)) throw new Error(`"${v}" is not a valid wildcard pattern`);

  const parts = v.split('.');
  if (parts.length < 4) {
    if (parts[parts.length - 1] !== '*') throw new Error(`"${v}" must have 4 octets (or end with *)`);
    while (parts.length < 4) parts.push('*');
  }
  const ranges = parts.map((p, i) => {
    const [lo, hi] = octetValues(p, i === 3);
    if (lo > 255 || hi > 255) throw new Error(`"${v}" has an octet above 255`);
    if (lo > hi) throw new Error(`"${v}": range start must be <= end`);
    return [lo, hi];
  });
  const total = ranges.reduce((t, [lo, hi]) => t * (hi - lo + 1), 1);
  if (total > max) throw new Error(`"${v}" expands to ${total} hosts (max ${max})`);

  const out = [];
  for (let a = ranges[0][0]; a <= ranges[0][1]; a++)
    for (let b = ranges[1][0]; b <= ranges[1][1]; b++)
      for (let c = ranges[2][0]; c <= ranges[2][1]; c++)
        for (let d = ranges[3][0]; d <= ranges[3][1]; d++) out.push(`${a}.${b}.${c}.${d}`);
  return out;
}

module.exports = { isPattern, expandPattern, MAX_HOSTS };

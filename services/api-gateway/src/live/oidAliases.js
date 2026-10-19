'use strict';

/**
 * Enterprise-root aliases.
 *
 * Some devices serve the SAME MIB tree under a different enterprise root depending on firmware.
 * UBR650/655 firmware 1.0.0.149 reports sysObjectID .1.3.6.1.4.1.52619 and serves its objects under
 * .1.3.6.1.4.1.52619.*; firmware 1.0.0.163/.164 reports .1.3.6.1.4.1.14125.123 and serves the identical
 * layout under .1.3.6.1.4.1.14125.123.* (and no longer answers under the old root). Verified on
 * hardware: every column / row lines up one-to-one, only the prefix differs.
 *
 * A product definition declares its OIDs under ONE root (the canonical one). Without this mapping a
 * newer-firmware unit matches no fingerprint (so discovery drops it) and, once provisioned, none of the
 * definition's OIDs exist on it (so the Node View is empty and Apply writes to objects that are not there).
 * The alias lets the definition keep describing the product once:
 *   • discovery / fingerprint matching compare the CANONICAL form of the device's sysObjectID;
 *   • reads, facts, role detection and writes address the device under ITS OWN root.
 *
 * Add a pair here when a vendor re-roots its tree; nothing else needs to change.
 */
const ROOT_ALIASES = [
  { canonical: '.1.3.6.1.4.1.52619', alias: '.1.3.6.1.4.1.14125.123' },
];

const dotted = (oid) => `.${String(oid == null ? '' : oid).trim().replace(/^\./, '')}`;
const isUnder = (oid, root) => oid === root || oid.startsWith(`${root}.`);

/** The alias pair a device's sysObjectID falls under, or null for a device on its canonical root. */
function aliasOfDevice(sysObjectID) {
  if (!sysObjectID) return null;
  const oid = dotted(sysObjectID);
  return ROOT_ALIASES.find((a) => isUnder(oid, a.alias)) || null;
}

/** sysObjectID with an alias root replaced by its canonical root (unchanged when no alias applies). */
function canonicalOid(oid) {
  if (!oid) return oid;
  const d = dotted(oid);
  const a = aliasOfDevice(d);
  return a ? `${a.canonical}${d.slice(a.alias.length)}` : d;
}

/**
 * An OID written under the definition's (canonical) root, addressed on a specific device: when the
 * device lives under an alias root the prefix is swapped, otherwise the OID is returned as is.
 */
function rebaseOid(oid, deviceSysObjectID) {
  if (!oid) return oid;
  const d = dotted(oid);
  const a = aliasOfDevice(deviceSysObjectID);
  if (!a || !isUnder(d, a.canonical)) return d;
  return `${a.alias}${d.slice(a.canonical.length)}`;
}

/** Registry entries with their OIDs addressed on the given device (same array when nothing changes). */
function rebaseEntries(entries, deviceSysObjectID) {
  if (!aliasOfDevice(deviceSysObjectID)) return entries;
  return (entries || []).map((e) => (e && e.snmpOid ? { ...e, snmpOid: rebaseOid(e.snmpOid, deviceSysObjectID) } : e));
}

module.exports = { ROOT_ALIASES, aliasOfDevice, canonicalOid, rebaseOid, rebaseEntries };

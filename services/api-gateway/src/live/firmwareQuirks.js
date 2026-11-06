'use strict';

/**
 * Firmware quirks: values the SNMP agent of a firmware line reports wrongly, corrected from what the
 * device itself shows on its web statistics page.
 *
 * Measured on UBR655 fw 1.0.0.161 (root .1.3.6.1.4.1.14125.123), wirelessStatsTable row = radio
 * (1 = 2.4 GHz, 2 = Radio 1), compared with the device's own `intfstats` page at the same moment:
 *   - total Tx/Rx packets (cols 4/5) are always "0", while the web page's total equals
 *     unicast + multicast + broadcast (cols 8/6/32 and 9/7/33, which are correct);
 *   - Tx/Rx throughput (cols 30/31) are always "0.00", while the web page shows live bits/s. SNMP offers no
 *     byte counters to derive it from, so the value is withheld (the Node View says "not exposed over SNMP")
 *     instead of showing a zero that disagrees with the device.
 *   - the whole configuration and management subtrees (.1.1.*, .1.2.*) are a stub: on all three units checked (10.0.150.107/.108/.112) 268 of
 *     292 values are placeholders ("-1", "-NA-", "0.0.0.0", "NA") while the web UI holds the real configuration
 *     (e.g. SSID "oct21", channel 140, IP 10.0.150.107). Placeholders are withheld so they are never shown as device
 *     data; ethMtu (.1.1.5.6.1.4) reports 0 where the real MTU is 1500, withheld likewise.
 * Applies only to devices on the re-rooted tree (aliasOfDevice), i.e. the firmware measured above.
 */

const { aliasOfDevice, canonicalOid } = require('./oidAliases');
// Instances carrying `placeholder: true` keep their raw answer; liveParameters reports them as readStatus PLACEHOLDER.

const STATS = /^\.1\.3\.6\.1\.4\.1\.52619\.1\.3\.1\.1\.(\d+)\.(\d+)$/;
const TOTALS = { 4: [8, 6, 32], 5: [9, 7, 33] };   // total column → component columns
const THROUGHPUT_COLS = new Set([30, 31]);
const CONFIG_ROOTS = ['.1.3.6.1.4.1.52619.1.1.', '.1.3.6.1.4.1.52619.1.2.'];   // configuration + management trees
const ETH_MTU = /^\.1\.3\.6\.1\.4\.1\.52619\.1\.1\.5\.6\.1\.4\./;
const isPlaceholder = (raw) => /^\s*(-1|-NA-|NA|0\.0\.0\.0)\s*$/.test(String(raw == null ? '' : raw));
const isZero = (raw) => /^\s*0+(\.0+)?\s*$/.test(String(raw == null ? '' : raw));

/**
 * @param {object[]} entries  registry entries as addressed on this device (after rebaseEntries)
 * @param {Map<string, Array<{index:string, raw:string}>>} mapped  result of mapVarbinds — modified in place
 * @param {{ sysObjectID?: string }} device
 * @returns {Map} the same map
 */
function applyFirmwareQuirks(entries, mapped, device) {
  if (!aliasOfDevice(device && device.sysObjectID)) return mapped;
  const keyOf = new Map();                       // 'col.row' → map key
  for (const e of entries) {
    const m = e.snmpOid && STATS.exec(canonicalOid(e.snmpOid));
    if (m) keyOf.set(`${m[1]}.${m[2]}`, `${e.groupId}::${e.parameterId}`);
  }
  const raw = (col, row) => {
    const list = mapped.get(keyOf.get(`${col}.${row}`));
    return list && list.length ? Number(list[0].raw) : null;
  };
  // Configuration subtree: drop placeholder instances (a parameter left with none reads "not exposed").
  for (const e of entries) {
    const oid = e.snmpOid && canonicalOid(e.snmpOid);
    if (!oid || !CONFIG_ROOTS.some((r) => oid.startsWith(r))) continue;
    const key = `${e.groupId}::${e.parameterId}`;
    const list = mapped.get(key);
    if (!list) continue;
    const mtu = ETH_MTU.test(oid);
    // Keep the answer but flag it: the UI then says "the device's agent returned a placeholder", not "no such object".
    mapped.set(key, list.map((i) => (isPlaceholder(i.raw) || (mtu && isZero(i.raw)) ? { ...i, placeholder: true } : i)));
  }
  for (const id of keyOf.keys()) {
    const [col, row] = id.split('.').map(Number);
    const key = keyOf.get(id);
    const list = mapped.get(key);
    if (TOTALS[col] && list && list.length === 1 && isZero(list[0].raw)) {
      const parts = TOTALS[col].map((c) => raw(c, row));
      if (parts.every((p) => p !== null && Number.isFinite(p))) {
        const sum = parts.reduce((a, b) => a + b, 0);
        if (sum > 0) list[0] = { ...list[0], raw: String(sum) };
      }
    } else if (THROUGHPUT_COLS.has(col) && list && list.length === 1 && isZero(list[0].raw)) {
      mapped.set(key, [{ ...list[0], placeholder: true }]);   // constant 0.00 while the device page shows live bits/s
    }
  }
  return mapped;
}

module.exports = { applyFirmwareQuirks };

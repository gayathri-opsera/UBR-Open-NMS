'use strict';

/**
 * Server-side, per-run data that must reach the Provision step but never the browser:
 * the SNMP credential discovery used, the inventory facts it collected, and BTS↔CPE pairing.
 *
 * Discovery no longer writes to the inventory — a device only enters it when an admin
 * provisions it — so this is how the provision handler gets what discovery learned. Held in
 * memory only (like the run results themselves) and pruned by age and count.
 */

const TTL_MS   = 6 * 60 * 60 * 1000;
const MAX_RUNS = 200;

const runs = new Map(); // runId → { at, hosts: Map(ip → data) }

function prune() {
  const now = Date.now();
  for (const [id, r] of runs) if (now - r.at > TTL_MS) runs.delete(id);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
}

/** Merge `data` into what is stored for `ip` in `runId`. */
function put(runId, ip, data) {
  if (!runId || !ip) return;
  prune();
  let r = runs.get(runId);
  if (!r) { r = { at: Date.now(), hosts: new Map() }; runs.set(runId, r); }
  r.hosts.set(ip, { ...(r.hosts.get(ip) || {}), ...data });
}

function get(runId, ip) {
  const r = runs.get(runId);
  return (r && r.hosts.get(ip)) || null;
}

/** [[ip, data], …] for every host of the run. */
function entries(runId) {
  const r = runs.get(runId);
  return r ? [...r.hosts.entries()] : [];
}

function clear() { runs.clear(); }

module.exports = { put, get, entries, clear };

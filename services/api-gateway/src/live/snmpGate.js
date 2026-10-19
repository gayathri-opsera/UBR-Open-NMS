'use strict';

/**
 * One SNMP operation at a time per device.
 *
 * The agents on these radios are small and single-threaded: while one of them answers a walk, a
 * second request is delayed by 0.1–1.2 s and occasionally never answered (measured on hardware: a GET
 * takes ~16 ms on an idle unit, up to 1.2 s — or is lost — during a walk). The gateway reaches the
 * same unit from several places at once — the discovery handshake, the facts and role reads that
 * follow it, the 60 s live poll, and Node View Apply — so they used to trample each other and a
 * reachable device showed up as "SNMP timeout". Everything that talks to a device now takes this
 * gate for the duration of its operation; different devices still run in parallel.
 *
 * FIFO per device. Every operation is bounded by its own timeouts, so the gate always frees up.
 */

const tails = new Map(); // "host:port" → promise of the last queued operation

/**
 * Run `fn` once every earlier operation on the same device has finished.
 * @template T
 * @param {string} host
 * @param {number} port
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runExclusive(host, port, fn) {
  const key = `${host}:${port || 161}`;
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);                 // a failed predecessor never blocks the queue
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });   // no entry left behind when idle
  return run;
}

/** Number of devices with an operation queued or running (diagnostics / tests). */
function activeDevices() { return tails.size; }

module.exports = { runExclusive, activeDevices };

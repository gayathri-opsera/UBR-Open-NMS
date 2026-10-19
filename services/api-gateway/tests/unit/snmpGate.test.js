'use strict';
/**
 * One SNMP operation at a time per device — the radios' agents are single-threaded and drop or delay
 * a request that lands during a walk — while different devices stay parallel.
 */
const { runExclusive, activeDevices } = require('../../src/live/snmpGate');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function tracker() {
  const t = { running: 0, peak: 0, order: [] };
  t.op = (label, ms) => async () => {
    t.running++; t.peak = Math.max(t.peak, t.running); t.order.push(`start:${label}`);
    await tick(ms);
    t.running--; t.order.push(`end:${label}`);
    return label;
  };
  return t;
}

test('operations on the same device never overlap and run in arrival order', async () => {
  const t = tracker();
  const out = await Promise.all([
    runExclusive('10.0.0.1', 161, t.op('walk', 60)),
    runExclusive('10.0.0.1', 161, t.op('get', 10)),
    runExclusive('10.0.0.1', 161, t.op('poll', 20)),
  ]);
  expect(out).toEqual(['walk', 'get', 'poll']);
  expect(t.peak).toBe(1);
  expect(t.order).toEqual(['start:walk', 'end:walk', 'start:get', 'end:get', 'start:poll', 'end:poll']);
});

test('different devices — or different ports on one host — run in parallel', async () => {
  const t = tracker();
  await Promise.all([
    runExclusive('10.0.0.1', 161, t.op('a', 40)),
    runExclusive('10.0.0.2', 161, t.op('b', 40)),
    runExclusive('10.0.0.1', 1161, t.op('c', 40)),
  ]);
  expect(t.peak).toBe(3);
});

test('a failing operation does not block the ones queued behind it, and its error is passed on', async () => {
  const failing = runExclusive('10.0.0.3', 161, async () => { await tick(10); throw new Error('boom'); });
  const next = runExclusive('10.0.0.3', 161, async () => 'still runs');
  await expect(failing).rejects.toThrow('boom');
  await expect(next).resolves.toBe('still runs');
});

test('the default SNMP port is 161', async () => {
  const t = tracker();
  await Promise.all([runExclusive('10.0.0.4', undefined, t.op('x', 30)), runExclusive('10.0.0.4', 161, t.op('y', 5))]);
  expect(t.peak).toBe(1);
});

test('nothing is left behind once the device is idle', async () => {
  await runExclusive('10.0.0.5', 161, async () => 1);
  await tick(5);
  expect(activeDevices()).toBe(0);
});

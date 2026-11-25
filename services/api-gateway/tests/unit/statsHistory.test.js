'use strict';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const h = require('../../src/live/statsHistory');

const CHARTS = { row: '2', charts: [
  { id: 'tp', title: 'Throughput', series: [{ param: 'tx', label: 'Tx' }, { param: 'rx', label: 'Rx' }] },
  { id: 'pk', title: 'Packets', series: [{ param: 'pkts', label: 'Tx', rate: true }] },
  { id: 'snr', title: 'SNR', series: [{ param: 'snr', label: 'SNR', perLink: true }] },
] };
const group = (rows) => ({ groupId: 'g', parameters: Object.entries(rows).map(([parameterId, inst]) => ({ parameterId, instances: Object.entries(inst).map(([index, value]) => ({ index, value })) })) });

describe('keys and rows', () => {
  it('round-trips a metric key (link rows have a dot)', () => {
    expect(h.encodeKey('snr', '2.1')).toBe('snr~2-1');
    expect(h.decodeKey('snr~2-1')).toEqual({ param: 'snr', instance: '2.1' });
    expect(h.decodeKey('wirelessStatsTxThroughput~2')).toEqual({ param: 'wirelessStatsTxThroughput', instance: '2' });
  });
  it('a table row belongs to its radio: 2 and 2.1, not 3 or 22', () => {
    expect(h.instanceMatches('2', '2')).toBe(true);
    expect(h.instanceMatches('2.1', '2')).toBe(true);
    expect(h.instanceMatches('3', '2')).toBe(false);
    expect(h.instanceMatches('22', '2')).toBe(false);
    expect(h.instanceMatches('3.1', '')).toBe(true);
  });
  it('reads numbers and refuses placeholders', () => {
    expect(h.numeric('0.07')).toBe(0.07);
    expect(h.numeric('-NA-')).toBeNull();
    expect(h.numeric('')).toBeNull();
    expect(h.numeric(null)).toBeNull();
  });
});

describe('counters become per-second rates', () => {
  it('rate between two readings; none on a reset or when time stood still', () => {
    expect(h.rateOf(1000, 4000, 0, 300_000)).toBe(10);
    expect(h.rateOf(4000, 100, 0, 300_000)).toBeNull();
    expect(h.rateOf(1, 2, 5, 5)).toBeNull();
  });
  it('only the radio\'s rows, gauges as they are, counters need a previous reading', () => {
    const resp = group({ tx: { 1: '9', 2: '0.07', 3: '5' }, rx: { 2: '0.10' }, pkts: { 2: '1300' }, snr: { '2.1': '63', '3.1': '40' }, other: { 2: '1' } });
    const first = h.extractSample(CHARTS, resp, 600_000, null);
    expect(first.metrics).toEqual({ 'tx~2': 0.07, 'rx~2': 0.10, 'snr~2-1': 63 });   // the counter has no point yet
    expect(first.counters).toEqual({ 'pkts~2': 1300 });
    const second = h.extractSample(CHARTS, group({ pkts: { 2: '1900' } }), 900_000, { ms: 600_000, counters: first.counters });
    expect(second.metrics).toEqual({ 'pkts~2': 2 });   // (1900-1300) / 300 s
  });
});

describe('ranges and resolution', () => {
  const NOW = Date.parse('2026-11-25T12:00:00Z');
  it('knows the ranges up to 6 months and custom dates', () => {
    expect(h.resolveRange({ range: '1h' }, NOW)).toEqual({ from: NOW - 3600_000, to: NOW });
    expect(h.resolveRange({ range: '6m' }, NOW).from).toBe(NOW - 183 * 86400_000);
    expect(h.resolveRange({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }, NOW)).toEqual({ from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-11-02T00:00:00Z') });
    expect(h.resolveRange({ from: 'nonsense' }, NOW)).toBeNull();
    expect(h.resolveRange({ from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z' }, NOW)).toBeNull();
  });
  it('never asks for more than 190 days', () => {
    const r = h.resolveRange({ from: '2025-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }, NOW);
    expect(r.to - r.from).toBe(190 * 86400_000);
  });
  it('keeps every range under the point limit and not finer than the source', () => {
    for (const [name, span] of Object.entries(h.RANGES)) {
      const raw = span <= h.RAW_QUERY_MS;
      const b = h.pickBucket(span, raw ? 300_000 : 3600_000);
      expect(span / b).toBeLessThanOrEqual(h.MAX_POINTS);
      expect(b).toBeGreaterThanOrEqual(raw ? 300_000 : 3600_000);
      expect(name).toBeTruthy();
    }
    expect(h.pickBucket(3600_000, 300_000)).toBe(300_000);          // 1 hour: the 5-minute samples as they are
    expect(h.pickBucket(183 * 86400_000, 3600_000)).toBe(86400_000);   // 6 months: one point per day (12-hour points would be 366, over the limit)
    expect(h.pickBucket(30 * 86400_000, 3600_000)).toBe(2 * 3600_000);   // 1 month: 2-hour points (360)
  });
});

describe('averaging into points', () => {
  it('averages raw samples per bucket and drops other series by params', () => {
    const t0 = Date.parse('2026-11-25T10:00:00Z');
    const docs = [0, 1, 2, 3].map((i) => ({ ts: new Date(t0 + i * 300_000), v: { 'tx~2': i, 'rx~2': 10 } }));
    const series = h.toSeries(h.rawToBuckets(docs, 600_000), ['tx']);
    expect(series).toEqual([{ param: 'tx', instance: '2', points: [[t0, 0.5], [t0 + 600_000, 2.5]] }]);
  });
  it('averages hourly sums by their counts when buckets are wider than an hour', () => {
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    const docs = [
      { h: new Date(t0), sum: { 'tx~2': 30 }, cnt: { 'tx~2': 3 } },            // average 10
      { h: new Date(t0 + 3600_000), sum: { 'tx~2': 10 }, cnt: { 'tx~2': 1 } },  // average 10
      { h: new Date(t0 + 7200_000), sum: { 'tx~2': 40 }, cnt: { 'tx~2': 2 } },  // average 20
    ];
    const s = h.toSeries(h.hourlyToBuckets(docs, 3 * 3600_000), null);
    expect(s[0].points).toEqual([[t0, 80 / 6]]);   // weighted by sample count, not an average of averages
  });
  it('a series without data has no points entry', () => {
    expect(h.toSeries(h.rawToBuckets([], 300_000), null)).toEqual([]);
  });
});

describe('built-in catalog (template independent)', () => {
  const h2 = require('../../src/live/statsHistory');
  test('targets cover the statistics rows and the links of both radios; old firmware root is used for 52619 units', () => {
    const t = h2.builtinTargets('1.3.6.1.4.1.14125.123');
    expect(t.length).toBe(13 * 3 + 4 * 2 * 8);
    expect(t.find((x) => x.param === 'wirelessStatsTxThroughput' && x.index === '2').oid).toBe('1.3.6.1.4.1.14125.123.1.3.1.1.30.2');
    expect(t.find((x) => x.param === 'assocLocalSNRA1' && x.index === '3.1').oid).toBe('1.3.6.1.4.1.14125.123.1.3.3.1.13.3.1');
    expect(h2.builtinTargets('.1.3.6.1.4.1.52619')[0].oid.startsWith('1.3.6.1.4.1.52619.1.3.1.1.')).toBe(true);
  });
  test('only UBR trees are collected', () => {
    expect(h2.isUbr('1.3.6.1.4.1.14125.123')).toBe(true);
    expect(h2.isUbr('.1.3.6.1.4.1.52619')).toBe(true);
    expect(h2.isUbr('1.3.6.1.4.1.9')).toBe(false);
  });
  test('gauges are stored, counters become rates from the second reading', () => {
    const t = h2.builtinTargets('1.3.6.1.4.1.14125.123');
    const read = (v) => [{ oid: '1.3.6.1.4.1.14125.123.1.3.1.1.30.2', value: '9' }, { oid: '1.3.6.1.4.1.14125.123.1.3.1.1.4.2', value: String(v) }];
    const a = h2.sampleFromCatalog(t, read(1000), 0, null);
    expect(a.metrics).toEqual({ 'wirelessStatsTxThroughput~2': 9 });
    const b = h2.sampleFromCatalog(t, read(1600), 300_000, { ms: 0, counters: a.counters });
    expect(b.metrics['wirelessStatsDataTxTotalPackets~2']).toBe(2);
  });
});

describe('liveSample (Monitor > Graphs live stream)', () => {
  const snmp = require('../../src/live/snmpWalk');
  it('reads only the radio row by GET, shares a reading for 3 s and turns counters into rates on the second reading', async () => {
    const spy = jest.spyOn(snmp, 'getOids').mockImplementation(async ({ oids }) => oids.map((o) => ({ oid: o, value: o.includes('.1.3.1.1.30.') ? 7 : o.includes('.1.3.1.1.4.') ? Date.now() % 1000 + 1000 : 1 })));
    const live = { splitHostPort: () => ({ host: '10.0.0.1', port: 161 }) };
    const dev = { _id: 'd-live-1', sysObjectID: '.1.3.6.1.4.1.14125.123', snmpCommunity: 'x' };
    const a = await h.liveSample(live, dev, '2');
    expect(a.values['wirelessStatsTxThroughput~2']).toBe(7);
    expect(Object.keys(a.values).every((k) => /~2(-\d)?$/.test(k))).toBe(true);   // radio 2 only, never rows 1 or 3
    expect(a.values['wirelessStatsDataTxTotalPackets~2']).toBeUndefined();         // counter: no rate on the first reading
    const calls = spy.mock.calls.length;
    expect(await h.liveSample(live, dev, '2')).toBe(a);                            // cached within 3 s
    expect(spy.mock.calls.length).toBe(calls);
    spy.mockRestore();
  });
});

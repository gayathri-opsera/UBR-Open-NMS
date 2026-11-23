import { describe, expect, it } from 'vitest';
import type { UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import { buildDeviceTree, cascadeOptionResets, optionsByList, matrixCell, parseOptionList, rowVisible, sectionHasData, visibleMatrixColumns, visibleSections } from './deviceUiModel';
import type { CellSource } from './deviceUiModel';

const f = (id: string, label = id): UiDescriptorField => ({ fieldId: id, elementType: 'table-block', label, mibObject: id, access: 'read-only', order: 0 });
const sec = (o: Partial<UiDescriptorSection> & { sectionId: string }): UiDescriptorSection =>
  ({ title: o.sectionId, columns: 2, order: 0, fields: [], ...o });

/** a device that returns rows for the given radio indexes only */
const device = (indexes: string[], scalars: Record<string, string> = {}): CellSource => ({
  // only table columns have rows; a scalar field answers through display()
  rows: (_s, fld) => (fld.elementType === 'table-block' ? indexes.map((i) => ({ index: i, text: `${fld.fieldId}@${i}` })) : []),
  display: (_s, fld) => scalars[fld.fieldId] ?? null,
});

const matrix = sec({
  sectionId: 'wl', uiLayout: 'matrix', fields: [f('ssid'), f('chan')],
  uiMatrix: { columns: [{ index: '2', label: 'Radio 1' }, { index: '3', label: 'Radio 2' }, { index: '1', label: '2.4 GHz' }] },
});

describe('radio-column matrix', () => {
  it('shows one column on a one-radio device and two on a two-radio device', () => {
    expect(visibleMatrixColumns(matrix, device(['2'])).map((c) => c.label)).toEqual(['Radio 1']);
    expect(visibleMatrixColumns(matrix, device(['2', '3'])).map((c) => c.label)).toEqual(['Radio 1', 'Radio 2']);
    expect(visibleMatrixColumns(matrix, device(['1', '2', '3'])).map((c) => c.label)).toEqual(['Radio 1', 'Radio 2', '2.4 GHz']);
  });
  it('keeps the configured column order, not the device order', () => {
    expect(visibleMatrixColumns(matrix, device(['1', '2'])).map((c) => c.index)).toEqual(['2', '1']);
  });
  it('shows every column when "hide empty columns" is off, and in the builder (no data source)', () => {
    const all = { ...matrix, uiMatrix: { ...matrix.uiMatrix!, hideEmptyColumns: false } };
    expect(visibleMatrixColumns(all, device(['2']))).toHaveLength(3);
    expect(visibleMatrixColumns(matrix, null)).toHaveLength(3);
  });
  it('a cell is null when that radio returned nothing for the field', () => {
    expect(matrixCell(device(['2']), 'wl', f('ssid'), '3')).toBeNull();
    expect(matrixCell(device(['2']), 'wl', f('ssid'), '2')).toBe('ssid@2');
  });
});

describe('hide when empty', () => {
  const r2 = sec({ sectionId: 'r2', uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'Properties', uiHideWhenEmpty: true, uiLayout: 'matrix',
    fields: [f('ssid')], uiMatrix: { columns: [{ index: '3', label: 'Radio 2' }] } });
  const r1 = sec({ sectionId: 'r1', uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', fields: [f('ssid')] });
  const net = sec({ sectionId: 'net', uiPage: 'Network', uiParent: 'IP', uiTab: 'IP', uiHideWhenEmpty: true,
    fields: [{ ...f('ip'), elementType: 'field-label' }] });

  it('drops a section the device has no data for — and its emptied menu item with it', () => {
    const shown = visibleSections([r1, r2, net], device(['2']), true);
    expect(shown.map((s) => s.sectionId)).toEqual(['r1']);                       // r2 (no row 3) and net (no IP) gone
    const tree = buildDeviceTree('S', shown);
    expect(tree.map((p) => p.name)).toEqual(['Wireless']);
    expect(tree[0].parents.map((p) => p.name)).toEqual(['Radio 1']);              // "Radio 2" menu item vanished
  });
  it('keeps it on a device that does have the data', () => {
    const shown = visibleSections([r1, r2, net], device(['2', '3'], { ip: '192.168.0.1' }), true);
    expect(shown.map((s) => s.sectionId)).toEqual(['r1', 'r2', 'net']);
  });
  it('hides nothing before the first reading is in (no flicker while loading)', () => {
    expect(visibleSections([r1, r2, net], device([]), false)).toHaveLength(3);
  });
  it('a section without the flag is always shown, empty or not', () => {
    expect(visibleSections([r1], device([]), true)).toHaveLength(1);
  });
  it('fixed text counts as data', () => {
    const fixed = sec({ sectionId: 'fx', uiHideWhenEmpty: true, fields: [{ ...f('model'), elementType: 'field-label' }] });
    expect(sectionHasData(fixed, device([], { model: 'UBR660' }))).toBe(true);
    expect(sectionHasData(fixed, device([]))).toBe(false);
  });
});

describe('device-supplied option lists', () => {
  it('channel lists: value is the channel, label carries the frequency', () => {
    expect(parseOptionList('1( 2412 MHz ),77( 6335 MHz )')).toEqual([{ value: '1', label: '1 ( 2412 MHz )' }, { value: '77', label: '77 ( 6335 MHz )' }]);
  });
  it('bandwidth lists: value:label pairs', () => {
    expect(parseOptionList('HT20:20 MHz,HT40+:40 MHz,HT160:160 MHz')).toEqual([{ value: 'HT20', label: '20 MHz' }, { value: 'HT40+', label: '40 MHz' }, { value: 'HT160', label: '160 MHz' }]);
  });
  it('nothing / garbage gives an empty list', () => {
    expect(parseOptionList(null)).toEqual([]);
    expect(parseOptionList('')).toEqual([]);
  });
});

describe('rowVisible', () => {
  const src = (raw: Record<string, string | null>): CellSource => ({ rows: () => [], display: (_s, x) => raw[x.fieldId] ?? null, rawValue: (_s, x) => raw[x.fieldId] ?? null });
  const row = (id: string, extra: Partial<UiDescriptorField> = {}): UiDescriptorField => ({ ...f(id), elementType: 'field-label', ...extra });
  const s = sec({ sectionId: 's', fields: [row('mode'), row('chan', { uiShowWhen: [{ field: 'mode', in: ['ap'] }] }), row('secret', { uiHidden: true })] });
  it('uiHidden rows are never drawn, whatever their value', () => { expect(rowVisible(s, s.fields[2], src({ secret: 'x' }))).toBe(false); });
  it('a rule hides the row only for a known, different sibling value', () => {
    expect(rowVisible(s, s.fields[1], src({ mode: 'ap' }))).toBe(true);
    expect(rowVisible(s, s.fields[1], src({ mode: 'sta' }))).toBe(false);
    expect(rowVisible(s, s.fields[1], src({}))).toBe(true);
  });
  it('a section whose rows are all hidden has no data', () => {
    const only = sec({ sectionId: 'o', fields: [row('mode'), row('chan', { uiShowWhen: [{ field: 'mode', in: ['ap'] }] })] });
    expect(sectionHasData(only, src({ mode: 'sta' }))).toBe(true);   // the mode row itself has a value
    const dcs = sec({ sectionId: 'd', fields: [row('dcs', { uiShowWhen: [{ field: 'mode', in: ['ap'] }] }), row('mode', { uiHidden: true })] });
    expect(sectionHasData(dcs, src({ mode: 'sta', dcs: '1' }))).toBe(false);
    expect(sectionHasData(dcs, src({ mode: 'ap', dcs: '1' }))).toBe(true);
  });
});

describe('hide-when-empty and sections not read yet', () => {
  const row = (id: string): UiDescriptorField => ({ ...f(id), elementType: 'field-label' });
  const r2 = sec({ sectionId: 'r2', uiHideWhenEmpty: true, fields: [row('ssid')] });
  const src = (read: boolean): CellSource => ({ rows: () => [], display: () => null, rawValue: () => null, sectionRead: () => read });
  it('an unread section stays (it cannot be read while hidden)', () => {
    expect(visibleSections([r2], src(false), true).map((s) => s.sectionId)).toEqual(['r2']);
  });
  it('once read and empty it goes', () => {
    expect(visibleSections([r2], src(true), true)).toEqual([]);
  });
  it('without a read tracker the old behaviour holds', () => {
    expect(visibleSections([r2], { rows: () => [], display: () => null }, true)).toEqual([]);
  });
});

describe('fixed text does not count as device data', () => {
  it('a section holding only fixed text and empty device values is empty', () => {
    const fixed: UiDescriptorField = { fieldId: 'k', elementType: 'field-label', label: 'Key', valueSource: 'static', staticValue: '********', access: 'read-only', order: 0 };
    const ssid: UiDescriptorField = { fieldId: 'ssid', elementType: 'field-label', label: 'SSID', mibObject: 'ssid', access: 'read-only', order: 1 };
    const s = sec({ sectionId: 'r2', fields: [ssid, fixed] });
    const src: CellSource = { rows: () => [], display: (_x, x) => (x.fieldId === 'k' ? '********' : null) };
    expect(sectionHasData(s, src)).toBe(false);
  });
});

describe('optionsBy: Country → Bandwidth → Channel', () => {
  const country = f('country');
  const bw: UiDescriptorField = { ...f('bw'), enumMap: {}, optionsBy: { dependsOn: ['country'], table: { '356': 'HT20:20 MHz,HT40+:40 MHz,HT80:80 MHz', '840': 'HT20:20 MHz' } } };
  const ch: UiDescriptorField = { ...f('ch'), enumMap: { auto: 'Auto' }, optionsBy: { dependsOn: ['country', 'bw'], resetOnChange: true, resetTo: 'auto',
    table: { '356|HT20': '32( 5160 MHz ),33( 5165 MHz )', '356|HT80': '38( 5190 MHz )', '840|HT20': '1( 2412 MHz )' } } };
  const s = sec({ sectionId: 'p', fields: [country, bw, ch] });
  const vals = (o: Record<string, string>) => (id: string) => o[id] ?? '';

  it('lists the options for the parents\' current values', () => {
    expect(optionsByList(ch, vals({ country: '356', bw: 'HT80' }))?.map((o) => o.value)).toEqual(['38']);
    expect(optionsByList(ch, vals({ country: '356', bw: 'HT160' }))).toBeNull();
    expect(optionsByList(bw, vals({ country: '840' }))?.map((o) => o.label)).toEqual(['20 MHz']);
  });
  it('changing Bandwidth resets Channel to Auto (the device does the same)', () => {
    expect(cascadeOptionResets(s, 'bw', 'HT80', vals({ country: '356', bw: 'HT20', ch: '33' }))).toEqual([{ fieldId: 'ch', value: 'auto' }]);
  });
  it('changing Country falls back a Bandwidth it does not offer, then resets Channel', () => {
    expect(cascadeOptionResets(s, 'country', '840', vals({ country: '356', bw: 'HT80', ch: '38' }))).toEqual([{ fieldId: 'bw', value: 'HT20' }, { fieldId: 'ch', value: 'auto' }]);
  });
  it('keeps a Bandwidth the new Country still offers', () => {
    const r = cascadeOptionResets(s, 'country', '356', vals({ country: '840', bw: 'HT20', ch: '1' }));
    expect(r.find((x) => x.fieldId === 'bw')).toBeUndefined();
    expect(r).toEqual([{ fieldId: 'ch', value: 'auto' }]);
  });
});

describe('optionsBy defaults', () => {
  const country = f('country');
  const ch: UiDescriptorField = { ...f('ch'), optionsBy: { dependsOn: ['country'], defaults: { country: '356' }, table: { '356': '38( 5190 MHz )', '840': '1( 2412 MHz )' } } };
  it('a parent with no value counts as its default (Country: India)', () => {
    expect(optionsByList(ch, () => '')?.map((o) => o.value)).toEqual(['38']);
    expect(optionsByList(ch, (id) => (id === 'country' ? '840' : ''))?.map((o) => o.value)).toEqual(['1']);
  });
  it('without a default an unanswered parent has no list', () => {
    expect(optionsByList({ ...ch, optionsBy: { ...ch.optionsBy!, defaults: undefined } }, () => '')).toBeNull();
    expect(country.fieldId).toBe('country');
  });
});

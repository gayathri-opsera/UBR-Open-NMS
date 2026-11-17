import { describe, expect, it } from 'vitest';
import type { UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import { buildDeviceTree, matrixCell, sectionHasData, visibleMatrixColumns, visibleSections } from './deviceUiModel';
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

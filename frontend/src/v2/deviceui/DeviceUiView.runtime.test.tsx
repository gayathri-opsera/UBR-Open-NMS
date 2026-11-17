import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { UiDescriptorField, UiDescriptorSection } from '../../api/uiBuilder.api';
import DeviceUiView from './DeviceUiView';
import type { DeviceUiRuntime } from './DeviceUiView';

const col = (id: string, label: string): UiDescriptorField => ({ fieldId: id, elementType: 'table-block', label, mibObject: id, access: 'read-only', order: 0 });

const sections: UiDescriptorSection[] = [
  { sectionId: 'sum', title: 'Wireless', columns: 2, order: 0, uiPage: 'Quick Start', uiParent: 'Quick Start', uiTab: 'Summary', uiTitle: 'Summary', uiLayout: 'matrix',
    fields: [col('ssid', 'SSID'), col('chan', 'Channel')],
    uiMatrix: { columns: [{ index: '2', label: 'Radio 1' }, { index: '3', label: 'Radio 2' }, { index: '1', label: '2.4 GHz' }], hideEmptyColumns: true } },
  { sectionId: 'r1', title: 'Props', columns: 2, order: 1, uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', fields: [col('ssid', 'SSID')] },
  { sectionId: 'r2', title: 'Props', columns: 2, order: 2, uiPage: 'Wireless', uiParent: 'Radio 2', uiTab: 'Properties', uiHideWhenEmpty: true, fields: [col('ssid', 'SSID')],
    uiLayout: 'matrix', uiMatrix: { columns: [{ index: '3', label: 'Radio 2' }] } },
];

const runtimeFor = (radios: string[], ready = true): DeviceUiRuntime => ({
  canEdit: false, applying: false, ready,
  rawValue: () => null,
  display: () => null,
  rows: (_s, f) => radios.map((i) => ({ index: i, text: `${f.fieldId}-${i}` })),
  edited: () => undefined, onEdit: vi.fn(), error: () => undefined, stale: () => false,
  pending: () => 0, onApply: vi.fn(), onRevert: vi.fn(), byField: () => null,
});

const view = (rt?: DeviceUiRuntime, design = false) => render(
  <DeviceUiView screenName="UBR" sections={sections} active={{ page: 'Quick Start', parent: 'Quick Start', tab: 'Summary' }}
    onActiveChange={() => undefined} runtime={rt} design={design} />,
);

describe('Summary radio columns at runtime', () => {
  it('one-radio device: one column, with that radio’s values', () => {
    view(runtimeFor(['2']));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean)).toEqual(['Radio 1']);
    expect(within(table).getByText('ssid-2')).toBeTruthy();
    expect(within(table).queryByText('ssid-3')).toBeNull();
  });
  it('two-radio device: the second radio column appears by itself', () => {
    view(runtimeFor(['2', '3']));
    const heads = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
    expect(heads).toEqual(['Radio 1', 'Radio 2']);
  });
  it('the "Radio 2" menu item exists only when that radio has data', () => {
    const one = view(runtimeFor(['2']));
    expect(menuItems(one.container)).toEqual(['Radio 1']);
    one.unmount();
    const two = view(runtimeFor(['2', '3']));
    expect(menuItems(two.container)).toEqual(['Radio 1', 'Radio 2']);
  });
  it('nothing is hidden before the first reading arrives', () => {
    const r = view(runtimeFor([], false));
    expect(menuItems(r.container)).toEqual(['Radio 1', 'Radio 2']);
  });
  it('in the builder every configured column and the hidden-when-empty badge are visible', () => {
    view(undefined, true);
    const heads = within(screen.getAllByRole('table')[0]).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
    expect(heads.slice(0, 3)).toEqual(['Radio 1', 'Radio 2', '2.4 GHz']);
  });
});

/** open the Wireless menu section and list its sub-menu items */
function menuItems(container: HTMLElement): string[] {
  const top = [...container.querySelectorAll('.dv-top-a')].find((e) => e.textContent?.includes('Wireless')) as HTMLElement | undefined;
  if (!top) return [];
  fireEvent.click(top);
  return [...container.querySelectorAll('.dv-sub li')].map((li) => li.textContent?.trim() ?? '').filter(Boolean);
}

describe('header bar at runtime comes from the device, not from the design sample', () => {
  const ui = { productName: 'SAMPLE', versionLine: 'SAMPLE 2641XCT0026K', uptime: '1d SAMPLE', radios: [{ label: 'Radio 1', mode: 'BTS', up: true }] };
  const renderHeader = (header: Parameters<typeof DeviceUiView>[0]['header']) => render(
    <DeviceUiView screenName="UBR" sections={sections} deviceUi={ui} header={header} active={{ page: 'Quick Start', parent: 'Quick Start', tab: 'Summary' }}
      onActiveChange={() => undefined} runtime={runtimeFor(['2'])} />,
  );
  it("shows this device's own values and badges", () => {
    const { container } = renderHeader({ productName: 'UBR660', versionLine: '183 SNo. 2641XCT000DK', uptime: '2d 3h 4m 5s', radios: [{ label: 'Radio 1', mode: 'CPE', up: true }] });
    const text = container.querySelector('.dv-header')!.textContent!;
    expect(text).toContain('2641XCT000DK');
    expect(text).toContain('2d 3h 4m 5s');
    expect(text).toContain('CPE');
    expect(text).not.toContain('SAMPLE');
    expect(text).not.toContain('2641XCT0026K');
  });
  it('a value the device did not return is “—”, never the sample text', () => {
    const { container } = renderHeader({ productName: null, versionLine: null, uptime: null, radios: [] });
    const text = container.querySelector('.dv-header')!.textContent!;
    expect(text).not.toContain('SAMPLE');
    expect(text).not.toContain('BTS');
    expect((text.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

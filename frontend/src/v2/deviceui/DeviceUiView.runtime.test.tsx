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

describe('rows flagged "hide when empty"', () => {
  const field = (id: string, label: string, hide?: boolean): UiDescriptorField => ({ fieldId: id, elementType: 'field-label', label, mibObject: id, access: 'read-only', order: 0, uiHideWhenEmpty: hide });
  const form: UiDescriptorSection[] = [{
    sectionId: 'p', title: 'Properties', columns: 2, order: 0, uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', uiLayout: 'form',
    fields: [field('ssid', 'SSID'), field('chan', 'Configured Channel', true), field('fbw', 'Force Bandwidth', true)],
  }];
  const rt = (shown: Record<string, string>, ready = true): DeviceUiRuntime => ({
    ...runtimeFor(['2'], ready),
    display: (_s, f) => shown[f.fieldId] ?? null,
    rawValue: (_s, f) => shown[f.fieldId] ?? null,
  });
  const render1 = (r: DeviceUiRuntime, design = false) => render(
    <DeviceUiView screenName="UBR" sections={form} active={{ page: 'Wireless', parent: 'Radio 1', tab: 'Properties' }} onActiveChange={() => undefined} runtime={r} design={design} />,
  );
  const labels = (c: HTMLElement) => [...c.querySelectorAll('.dv-row .dv-label')].map((l) => l.textContent);

  it('a flagged row with no value is left out; one with a value stays', () => {
    const r = render1(rt({ ssid: 'oct21', fbw: 'Auto' }));
    expect(labels(r.container)).toEqual(['SSID', 'Force Bandwidth']);
  });
  it('unflagged rows always stay, flagged rows stay until the first reading arrives, and the designer shows all', () => {
    expect(labels(render1(rt({}, false)).container)).toEqual(['SSID', 'Configured Channel', 'Force Bandwidth']);
    expect(labels(render1(rt({}), true).container)).toEqual(['SSID', 'Configured Channel', 'Force Bandwidth']);
  });
});

describe('rows with "show when" rules', () => {
  const f = (id: string, label: string, extra: Partial<UiDescriptorField> = {}): UiDescriptorField => ({ fieldId: id, elementType: 'field-label', label, mibObject: id, access: 'read-only', order: 0, ...extra });
  const secs: UiDescriptorSection[] = [{
    sectionId: 'p', title: 'Properties', columns: 2, order: 0, uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', uiLayout: 'form',
    fields: [f('mode', 'Radio Mode'), f('chan', 'Configured Channel', { uiShowWhen: [{ field: 'mode', in: ['ap'] }] }),
      f('ddrs', 'DDRS Status'), f('mod', 'Modulation Index', { uiShowWhen: [{ field: 'ddrs', notIn: ['1'] }, { field: 'mode', in: ['ap', 'sta'] }] })],
  }];
  const run = (vals: Record<string, string>): DeviceUiRuntime => ({
    ...runtimeFor(['2']), display: (_s, x) => vals[x.fieldId] ?? null, rawValue: (_s, x) => vals[x.fieldId] ?? null,
  });
  const labels = (c: HTMLElement) => [...c.querySelectorAll('.dv-row .dv-label')].map((l) => l.textContent);
  const draw = (r: DeviceUiRuntime) => render(
    <DeviceUiView screenName="UBR" sections={secs} active={{ page: 'Wireless', parent: 'Radio 1', tab: 'Properties' }} onActiveChange={() => undefined} runtime={r} />,
  );
  it('a BTS radio shows its BTS-only rows, a CPE radio does not', () => {
    expect(labels(draw(run({ mode: 'ap', ddrs: '0', chan: '36', mod: 'MCS3' })).container)).toEqual(['Radio Mode', 'Configured Channel', 'DDRS Status', 'Modulation Index']);
    expect(labels(draw(run({ mode: 'sta', ddrs: '1', chan: 'auto', mod: 'MCS3' })).container)).toEqual(['Radio Mode', 'DDRS Status']);
  });
  it('a sibling with no value hides nothing', () => {
    expect(labels(draw(run({})).container)).toEqual(['Radio Mode', 'Configured Channel', 'DDRS Status', 'Modulation Index']);
  });
});

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

describe('dependent dropdowns: Country → Bandwidth → Channel', () => {
  const f = (id: string, label: string, extra: Partial<UiDescriptorField> = {}): UiDescriptorField => ({ fieldId: id, elementType: 'field-label', label, mibObject: id, access: 'read-write', order: 0, widget: 'select', ...extra });
  const secs: UiDescriptorSection[] = [{
    sectionId: 'p', title: 'Properties', columns: 2, order: 0, uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', uiLayout: 'form',
    fields: [
      f('country', 'Country', { uiHidden: true }),
      f('bw', 'Bandwidth', { enumMap: {}, optionsBy: { dependsOn: ['country'], table: { '356': 'HT20:20 MHz,HT40+:40 MHz,HT80:80 MHz', '840': 'HT20:20 MHz' } } }),
      f('ch', 'Configured Channel', { enumMap: { auto: 'Auto' }, optionsBy: { dependsOn: ['country', 'bw'], resetOnChange: true, resetTo: 'auto',
        table: { '356|HT20': '32( 5160 MHz ),33( 5165 MHz )', '356|HT80': '38( 5190 MHz ),42( 5210 MHz )', '840|HT20': '1( 2412 MHz )' } } }),
    ],
  }];
  const raw: Record<string, string> = { country: '356', bw: 'HT20', ch: '33' };
  const make = (edits: Record<string, string> = {}) => {
    const onEdit = vi.fn();
    const rt: DeviceUiRuntime = { ...runtimeFor(['2']), canEdit: true, onEdit,
      rawValue: (_s, x) => raw[x.fieldId] ?? null, display: (_s, x) => raw[x.fieldId] ?? null, edited: (_s, x) => edits[x.fieldId] };
    const r = render(<DeviceUiView screenName="UBR" sections={secs} active={{ page: 'Wireless', parent: 'Radio 1', tab: 'Properties' }} onActiveChange={() => undefined} runtime={rt} />);
    const sel = (label: string) => [...r.container.querySelectorAll('.dv-row')].find((row) => row.querySelector('.dv-label')?.textContent === label)?.querySelector('select') as HTMLSelectElement;
    return { onEdit, sel, opts: (label: string) => [...sel(label).options].map((o) => o.value) };
  };
  it('Channel lists the channels of the device’s current Country + Bandwidth', () => {
    const v = make();
    expect(v.opts('Bandwidth')).toEqual(['HT20', 'HT40+', 'HT80']);
    expect(v.opts('Configured Channel')).toEqual(['auto', '32', '33']);
  });
  it('an unsaved Bandwidth choice already changes the Channel list', () => {
    expect(make({ bw: 'HT80', ch: 'auto' }).opts('Configured Channel')).toEqual(['auto', '38', '42']);
  });
  it('picking a Bandwidth also resets the Channel to Auto, like the device', () => {
    const v = make();
    fireEvent.change(v.sel('Bandwidth'), { target: { value: 'HT80' } });
    expect(v.onEdit.mock.calls.map((c) => [c[1].fieldId, c[2]])).toEqual([['bw', 'HT80'], ['ch', 'auto']]);
  });
});

describe('VLAN Mode follows the Radio Mode (another section, like the device)', () => {
  const f = (id: string, label: string, extra: Partial<UiDescriptorField> = {}): UiDescriptorField => ({ fieldId: id, elementType: 'field-label', label, mibObject: id, access: 'read-write', order: 0, widget: 'select', ...extra });
  const secs: UiDescriptorSection[] = [
    { sectionId: 'w', title: 'Properties', columns: 2, order: 0, uiPage: 'Wireless', uiParent: 'Radio 1', uiTab: 'Properties', uiLayout: 'form', fields: [f('rm', 'Radio Mode', { enumMap: { ap: 'BTS', sta: 'CPE' } })] },
    { sectionId: 'v', title: 'VLAN', columns: 2, order: 1, uiPage: 'Network', uiParent: 'VLAN', uiTab: 'VLAN', uiLayout: 'form',
      fields: [f('vm', 'Mode', { enumMap: { '0': 'Transparent' }, optionsBy: { dependsOn: ['rm'], table: { ap: '0(Transparent)', sta: '0(Transparent),1(Access),2(Trunk),3(Q-in-Q)' } } })] },
  ];
  const make = (raw: Record<string, string>, edits: Record<string, string> = {}) => {
    const rt: DeviceUiRuntime = { ...runtimeFor(['2']), canEdit: true, rawValue: (_s, x) => raw[x.fieldId] ?? null, display: (_s, x) => raw[x.fieldId] ?? null, edited: (_s, x) => edits[x.fieldId] };
    const r = render(<DeviceUiView screenName="UBR" sections={secs} active={{ page: 'Network', parent: 'VLAN', tab: 'VLAN' }} onActiveChange={() => undefined} runtime={rt} />);
    return [...(r.container.querySelector('select') as HTMLSelectElement).options].map((o) => o.value);
  };
  it('a BTS offers Transparent only', () => { expect(make({ rm: 'ap', vm: '0' })).toEqual(['0']); });
  it('a CPE offers Transparent, Access, Trunk and Q-in-Q', () => { expect(make({ rm: 'sta', vm: '1' })).toEqual(['0', '1', '2', '3']); });
  it('rows that depend on the Mode follow an unsaved Mode pick', () => {
    const sec2: UiDescriptorSection = { ...secs[1], fields: [...secs[1].fields, f('acc', 'Access VLAN ID', { widget: 'Text input', uiShowWhen: [{ field: 'vm', in: ['1'] }] })] };
    const run = (edits: Record<string, string>) => {
      const rt: DeviceUiRuntime = { ...runtimeFor(['2']), canEdit: true, rawValue: (_s, x) => ({ rm: 'sta', vm: '0' } as Record<string, string>)[x.fieldId] ?? null, display: () => null, edited: (_s, x) => edits[x.fieldId] };
      const r = render(<DeviceUiView screenName="UBR" sections={[secs[0], sec2]} active={{ page: 'Network', parent: 'VLAN', tab: 'VLAN' }} onActiveChange={() => undefined} runtime={rt} />);
      return [...r.container.querySelectorAll('.dv-label')].map((l) => l.textContent);
    };
    expect(run({})).toEqual(['Mode']);
    expect(run({ vm: '1' })).toEqual(['Mode', 'Access VLAN ID']);
  });
  it('an unsaved Radio Mode change already changes the VLAN modes', () => { expect(make({ rm: 'ap', vm: '0' }, { rm: 'sta' })).toEqual(['0', '1', '2', '3']); });
});

describe('VLAN trunk list editor', () => {
  const f = (id: string, label: string, extra: Partial<UiDescriptorField> = {}): UiDescriptorField => ({ fieldId: id, elementType: 'field-label', label, mibObject: id, access: 'read-write', order: 0, widget: 'Text input', ...extra });
  const secs: UiDescriptorSection[] = [{
    sectionId: 'v', title: 'VLAN', columns: 2, order: 0, uiPage: 'Network', uiParent: 'VLAN', uiTab: 'VLAN', uiLayout: 'form',
    fields: [
      f('mode', 'Mode', { widget: 'Dropdown', enumMap: { '0': 'Transparent', '2': 'Trunk' } }),
      f('opt', 'Trunk Option', { widget: 'Dropdown', enumMap: { '1': 'List', '2': 'All' }, uiShowWhen: [{ field: 'mode', in: ['2'] }] }),
      f('ids', 'Trunk VLAN IDs', { idList: { deleteParam: 'del', max: 3, minId: 1, maxId: 4094 }, uiShowWhen: [{ field: 'mode', in: ['2'] }, { field: 'opt', in: ['1'] }] }),
      f('del', 'Trunk ID Delete', { uiHidden: true }),
    ],
  }];
  const make = (raw: Record<string, string>, edits: Record<string, string> = {}) => {
    const onEdit = vi.fn();
    const rt: DeviceUiRuntime = { ...runtimeFor(['2']), canEdit: true, onEdit, rawValue: (_s, x) => raw[x.fieldId] ?? null, display: (_s, x) => raw[x.fieldId] ?? null, edited: (_s, x) => edits[x.fieldId] };
    const r = render(<DeviceUiView screenName="UBR" sections={secs} active={{ page: 'Network', parent: 'VLAN', tab: 'VLAN' }} onActiveChange={() => undefined} runtime={rt} />);
    const chips = () => [...r.container.querySelectorAll('.dv-chip')].map((c) => c.textContent?.replace('✕', ''));
    return { r, onEdit, chips };
  };
  it('shows the device list as entries, only in Trunk mode with the List option', () => {
    expect(make({ mode: '2', opt: '1', ids: '10 20' }).chips()).toEqual(['10', '20']);
    expect(make({ mode: '2', opt: '2', ids: '10 20' }).chips()).toEqual([]);
    expect(make({ mode: '0', opt: '1', ids: '10 20' }).chips()).toEqual([]);
  });
  it('adding an id is a pending edit of the whole list; entries are counted', () => {
    const v = make({ mode: '2', opt: '1', ids: '10 20' });
    fireEvent.change(v.r.getByLabelText('Add VLAN ID'), { target: { value: '30' } });
    fireEvent.click(v.r.getByText('Add'));
    expect(v.onEdit).toHaveBeenCalledWith('v', expect.objectContaining({ fieldId: 'ids' }), '10 20 30');
    expect(v.r.getByText('2 / 3 entries')).toBeTruthy();
  });
  it('refuses a duplicate, an out-of-range id and a list over the limit', () => {
    const v = make({ mode: '2', opt: '1', ids: '10 20 30' });
    fireEvent.change(v.r.getByLabelText('Add VLAN ID'), { target: { value: '40' } });
    expect((v.r.getByLabelText('Add VLAN ID') as HTMLInputElement).disabled).toBe(true);   // full: 3 / 3
    const w = make({ mode: '2', opt: '1', ids: '10' });
    const input = w.r.getAllByLabelText('Add VLAN ID').pop() as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } }); fireEvent.click(w.r.getAllByText('Add').pop() as HTMLElement);
    expect(w.r.getByText(/already in the list/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '4095' } }); fireEvent.click(w.r.getAllByText('Add').pop() as HTMLElement);
    expect(w.r.getByText(/1 to 4094/)).toBeTruthy();
    expect(w.onEdit).not.toHaveBeenCalled();
  });
  it('removing an id edits the list; going back to the device list clears the edit', () => {
    const v = make({ mode: '2', opt: '1', ids: '10 20' });
    fireEvent.click(v.r.getByLabelText('Remove 10'));
    expect(v.onEdit).toHaveBeenCalledWith('v', expect.objectContaining({ fieldId: 'ids' }), '20');
    const u = make({ mode: '2', opt: '1', ids: '10 20' }, { ids: '10 20 30' });
    fireEvent.click(u.r.getAllByLabelText('Remove 30').pop() as HTMLElement);
    expect(u.onEdit).toHaveBeenCalledWith('v', expect.objectContaining({ fieldId: 'ids' }), '10 20');
  });
});

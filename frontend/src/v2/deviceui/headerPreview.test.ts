import { describe, expect, it } from 'vitest';
import type { DeviceUiConfig } from '../../api/uiBuilder.api';
import { computeSource } from './calcExpr';
import { hasSource, previewHeader } from './headerPreview';

const ui: DeviceUiConfig = {
  productName: 'typed', versionLine: 'typed 2641XCT0026K', uptime: '1d typed',
  sources: {
    versionLine: { kind: 'template', template: '{fw} SNo. {sn}', inputs: [{ name: 'fw', oid: '.7', sample: '1.0.0-183' }, { name: 'sn', oid: '.1', sample: '2641XCT000DK' }] },
    uptime: { kind: 'calc', expr: '{t}/100', format: 'duration', inputs: [{ name: 't', oid: '.3', sample: '12695600' }] },
  },
  radios: [{ label: 'Radio 1', mode: 'x', up: false, modeSource: { kind: 'template', template: '{m}', inputs: [{ name: 'm', oid: '.2', sample: 'sta', map: { ap: 'BTS', sta: 'CPE' } }] }, upSource: { oid: '.33', upValues: ['0'], sample: '0' } }],
};

describe('builder header preview', () => {
  it('shows the data-source results, not the typed sample, for sourced items', () => {
    const h = previewHeader(ui);
    expect(h.versionLine).toBe('1.0.0-183 SNo. 2641XCT000DK');
    expect(h.uptime).toBe('1d 11h 15m 56s');
    expect(h.radios).toEqual([{ label: 'Radio 1', mode: 'CPE', up: true }]);
  });
  it('an item without a source keeps its typed text', () => { expect(previewHeader(ui).productName).toBe('typed'); });
  it('knows which items come from the device', () => {
    expect(hasSource(ui, 'versionLine')).toBe(true);
    expect(hasSource(ui, 'productName')).toBe(false);
  });
  it('an empty sample is shown as a problem, not as an empty header', () => {
    const bad = previewHeader({ sources: { uptime: { kind: 'calc', expr: '{t}', inputs: [{ name: 't', oid: '.3', sample: '' }] } } });
    expect(bad.uptime).toMatch(/^⚠/);
  });
  it('computeSource: a value map leaves unknown codes alone', () => {
    const s = { kind: 'template' as const, template: '{m}', inputs: [{ name: 'm', map: { ap: 'BTS' } }] };
    expect(computeSource(s, { m: 'mesh' })).toEqual({ ok: true, text: 'mesh' });
  });
});

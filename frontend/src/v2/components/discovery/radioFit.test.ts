import { describe, it, expect } from 'vitest';
import { assessRadioFit, type TemplateRadios } from './radioFit';

const T = (id: string, min: number, max: number, vendor = 'Senao', mib = 'M'): TemplateRadios =>
  ({ descriptorId: id, screenName: id, vendor, mibModule: mib, radios: { min, max } });

describe('assessRadioFit', () => {
  const all = [T('two', 2, 2), T('one', 1, 1), T('adaptive', 1, 2), T('otherVendor', 1, 1, 'X', 'Y'), { descriptorId: 'plain', screenName: 'plain' } as TemplateRadios];
  it('unknown when the device count is not known', () => expect(assessRadioFit(null, 'two', all).status).toBe('unknown'));
  it('unknown when the template has no radio menu', () => expect(assessRadioFit(1, 'plain', all).status).toBe('unknown'));
  it('ok for an adaptive 1..2 template on either unit', () => {
    expect(assessRadioFit(1, 'adaptive', all).status).toBe('ok');
    expect(assessRadioFit(2, 'adaptive', all).status).toBe('ok');
  });
  it('two-radio template on a one-radio unit suggests fitting templates, same vendor first', () => {
    const r = assessRadioFit(1, 'two', all);
    expect(r.status).toBe('mismatch');
    expect(r.suggestions.map((s) => s.descriptorId)).toEqual(['adaptive', 'one', 'otherVendor']);
  });
  it('one-radio template on a two-radio unit suggests the two-radio ones', () => {
    expect(assessRadioFit(2, 'one', all).suggestions.map((s) => s.descriptorId)).toEqual(['adaptive', 'two']);
  });
});

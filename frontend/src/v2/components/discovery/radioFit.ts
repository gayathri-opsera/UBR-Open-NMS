/**
 * Does the template chosen for a discovered device fit the number of radios the device reports?
 * A template that lists "Radio 1, Radio 2" shows an empty or invented second radio on a one-radio unit, and a
 * one-radio template hides the second radio of a two-radio unit. The admin is warned and offered the templates that fit.
 */
export interface RadioRange { min: number; max: number }
export interface TemplateRadios {
  descriptorId: string;
  screenName: string;
  vendor?: string;
  mibModule?: string;
  deviceProfile?: string;
  radios?: RadioRange | null;
}
export interface RadioFit {
  /** 'ok' fits · 'mismatch' wrong radio count · 'unknown' device count or template radios not known (never warn) */
  status: 'ok' | 'mismatch' | 'unknown';
  deviceRadios?: number;
  templateRadios?: RadioRange;
  /** other published templates that fit, same vendor / MIB first */
  suggestions: TemplateRadios[];
}

export const fits = (r: RadioRange, n: number): boolean => n >= r.min && n <= r.max;
export const describeRadios = (r: RadioRange): string =>
  r.min === r.max ? `${r.max} radio${r.max === 1 ? '' : 's'}` : `${r.min}–${r.max} radios`;

export function assessRadioFit(
  deviceRadios: number | null | undefined,
  selectedId: string | null | undefined,
  templates: TemplateRadios[],
): RadioFit {
  const sel = templates.find((t) => t.descriptorId === selectedId);
  if (!deviceRadios || !sel || !sel.radios) return { status: 'unknown', suggestions: [] };
  if (fits(sel.radios, deviceRadios)) return { status: 'ok', deviceRadios, templateRadios: sel.radios, suggestions: [] };
  const same = (t: TemplateRadios) => (sel.vendor && t.vendor === sel.vendor ? 2 : 0) + (sel.mibModule && t.mibModule === sel.mibModule ? 1 : 0);
  const suggestions = templates
    .filter((t) => t.descriptorId !== sel.descriptorId && t.radios && fits(t.radios, deviceRadios))
    .sort((a, b) => same(b) - same(a) || a.screenName.localeCompare(b.screenName));
  return { status: 'mismatch', deviceRadios, templateRadios: sel.radios, suggestions };
}

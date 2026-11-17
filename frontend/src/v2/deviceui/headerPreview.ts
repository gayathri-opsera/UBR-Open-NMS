/**
 * The header as the builder previews it: every data source evaluated with its SAMPLE input values. Items with no source
 * keep their typed text. (At runtime the gateway resolves the same sources from the real device — headerSources.js.)
 */
import type { DataSource, DeviceUiConfig, ResolvedHeader } from '../../api/uiBuilder.api';
import { computeSource } from './calcExpr';

function sample(src: DataSource | undefined): string | null {
  if (!src) return null;
  const raw: Record<string, string> = {};
  for (const i of src.inputs ?? []) raw[i.name] = i.sample ?? '';
  const r = computeSource(src, raw);
  return r.ok ? r.text : `⚠ ${r.error}`;
}

export function previewHeader(ui: DeviceUiConfig | null | undefined): ResolvedHeader {
  const u = ui ?? {};
  const item = (k: 'productName' | 'versionLine' | 'uptime') => (u.sources?.[k] ? sample(u.sources[k]) : (u[k] ?? null));
  return {
    productName: item('productName'), versionLine: item('versionLine'), uptime: item('uptime'),
    radios: (u.radios ?? []).map((r) => ({
      label: (r.labelSource ? sample(r.labelSource) : r.label) ?? '',
      mode: (r.modeSource ? sample(r.modeSource) : r.mode) ?? '',
      up: r.upSource ? (r.upSource.upValues ?? []).map((x) => String(x).trim()).includes(String(r.upSource.sample ?? '').trim()) : !!r.up,
    })),
  };
}

/** does this header item take its value from the device (so typing over it in the preview would be misleading)? */
export const hasSource = (ui: DeviceUiConfig | null | undefined, k: 'productName' | 'versionLine' | 'uptime') => !!ui?.sources?.[k];

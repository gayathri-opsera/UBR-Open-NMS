/** Live-refresh rules shared with the classic Custom UI Builder (same intervals, same read-only rule, same suggestion). */
import type { UiDescriptorSection } from '../../api/uiBuilder.api';

export const LIVE_OPTIONS = [0, 2, 5, 10, 30] as const;
const LIVE_NAME = /(Packets|Bytes|Errors|Dropped|Drop|Throughput|Tput|PPS|RSSI|SNR|Signal|Noise|Utility|Interference|Rate$|Latency|Usage|Util|OBSS|Capacity|IncomingB|KPI|Uptime|Temperature|TimeLeft|Retries|RTX|Sinr|Timeout|Overflow|Beacons|Counter)/i;

/** A section can be live only if every bound field is read-only. */
export function sectionCanBeLive(sec: UiDescriptorSection): boolean {
  const bound = sec.fields.filter((f) => f.elementType === 'field-label' || f.elementType === 'table-block');
  return bound.length > 0 && bound.every((f) => f.access !== 'read-write');
}

/** 2 s for per-link stats, 5 s for other counters, 0 when nothing in the section changes. */
export function suggestLiveRefresh(sec: UiDescriptorSection): number {
  if (!sectionCanBeLive(sec)) return 0;
  const names = sec.fields.map((f) => f.mibObject ?? '').filter(Boolean);
  if (!names.some((n) => LIVE_NAME.test(n))) return 0;
  return names.some((n) => /^assoc/i.test(n)) ? 2 : 5;
}

/** Every widget the builders can bind (classic list + the ones MIB suggestions produce). */
export const ALL_WIDGETS = [
  'Text input', 'Text value', 'Slider+number', 'Toggle switch', 'Dropdown', 'Status badge', 'Gauge', 'Data table',
  'IP input (validated)', 'IP text', 'Value + units', 'On/Off badge', 'Rate chart (Δ/s)', 'Duration (d h m)',
];

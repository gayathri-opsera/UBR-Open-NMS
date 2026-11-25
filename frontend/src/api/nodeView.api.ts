/**
 * Node View API client
 *
 * Talks to the new persisted-wireframe endpoints:
 *   GET /api/node-view/:deviceId            → wireframe + values (combined)
 *   GET /api/node-view/wireframe/:defId     → wireframe only (static, cached)
 *   POST /api/node-view/wireframes/migrate  → admin migration
 *
 * Uses apiClient (Axios with Bearer token interceptor) instead of raw fetch()
 * so the gateway authenticate middleware receives the auth header.
 */

import { apiClient } from './client';
import type {
  NodeViewApplyResponse, NodeViewChange, NodeViewResponse, NodeViewValues, WireframeOnlyResponse,
} from './nodeView.types';

const BASE = '/node-view';

// ── fetchNodeView ─────────────────────────────────────────────────────────────
/**
 * Load the complete Node View for a device: persisted wireframe + latest values.
 * Pass `refresh=true` to force a live SNMP re-poll instead of using the cache.
 */
export async function fetchNodeView(
  deviceId: string,
  { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<NodeViewResponse> {
  const url = `${BASE}/${encodeURIComponent(deviceId)}${refresh ? '?refresh=1' : ''}`;
  const res = await apiClient.get<NodeViewResponse>(url, { signal });
  return res.data;
}

// ── fetchLiveStatus ───────────────────────────────────────────────────────────
export interface LiveStatus { state: 'ONLINE' | 'OFFLINE'; rttMs: number | null; uptime: string | null; checkedAt: string;
  /** Stored poll outcome / time, so the page can tell when the Node View data has changed. */
  pollStatus?: string | null; collectedAt?: string | null }

/** One real-time SNMP probe of the device (never cached). */
export async function fetchLiveStatus(deviceId: string, signal?: AbortSignal): Promise<LiveStatus | null> {
  const res = await apiClient.get<{ status: string; data?: LiveStatus }>(
    `${BASE}/${encodeURIComponent(deviceId)}/live-status`, { signal });
  return res.data.status === 'ok' && res.data.data ? res.data.data : null;
}

// ── fetchMonitorLive ──────────────────────────────────────────────────────────
export interface MonitorLive { pollStatus: string; collectedAt: string; values: NodeViewValues; error?: string }

/** Fresh SNMP read of the given Monitor groups only (real-time statistics). */
export async function fetchMonitorLive(deviceId: string, groupIds: string[], signal?: AbortSignal): Promise<MonitorLive | null> {
  const res = await apiClient.get<{ status: string; data?: MonitorLive }>(
    `${BASE}/${encodeURIComponent(deviceId)}/monitor-live?groups=${encodeURIComponent(groupIds.join(','))}`, { signal });
  return res.data.status === 'ok' && res.data.data ? res.data.data : null;
}

// ── fetchTabLive ──────────────────────────────────────────────────────────────
/**
 * Read one page/tab of a device-look screen: the gateway walks just those groups' OIDs and merges them into the stored
 * values. Called when a tab is opened (if its values are old) and by that tab's Refresh button.
 */
export async function fetchTabLive(deviceId: string, groupIds: string[], signal?: AbortSignal): Promise<MonitorLive | null> {
  const res = await apiClient.get<{ status: string; data?: MonitorLive }>(
    `${BASE}/${encodeURIComponent(deviceId)}/tab-live?groups=${encodeURIComponent(groupIds.join(','))}`, { signal });
  return res.data.status === 'ok' && res.data.data ? res.data.data : null;
}

// ── fetchWireframe ────────────────────────────────────────────────────────────
/**
 * Load just the static wireframe for a product definition.
 * Useful when you want to pre-render the skeleton before values load.
 */
export async function fetchWireframe(
  productDefinitionId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<WireframeOnlyResponse> {
  const url = `${BASE}/wireframe/${encodeURIComponent(productDefinitionId)}`;
  const res = await apiClient.get<WireframeOnlyResponse>(url, { signal });
  return res.data;
}

// ── triggerMigration ──────────────────────────────────────────────────────────
/**
 * Admin: trigger the one-time migration that builds wireframes for all
 * existing active product definitions that don't have one yet.
 */
export async function triggerMigration(): Promise<{ status: string; results: unknown }> {
  const res = await apiClient.post<{ status: string; results: unknown }>(
    `${BASE}/wireframes/migrate`,
  );
  return res.data;
}

// ── applyNodeViewChanges ──────────────────────────────────────────────────────
/**
 * Write edited parameter values to the device. Resolves with the per-parameter results
 * (the gateway answers 422 when nothing was applied — that is returned, not thrown).
 */
export async function applyNodeViewChanges(
  deviceId: string,
  changes: NodeViewChange[],
): Promise<NodeViewApplyResponse> {
  const res = await apiClient.put<NodeViewApplyResponse>(
    `${BASE}/${encodeURIComponent(deviceId)}/parameters`,
    { changes },
    { validateStatus: (s) => s === 200 || s === 409 || s === 422 || s === 400 },
  );
  return res.data;
}

// ── fetchNodeViewHistory ──────────────────────────────────────────────────────
/** One charted metric: `param` (field name) at table row `instance` ('2' = Radio 1, '2.1' = its first link), averaged points [ms, value]. */
export interface HistorySeries { param: string; instance: string; points: [number, number][] }
export interface HistoryData {
  from: number; to: number;
  /** width of one point */
  bucketSeconds: number;
  /** 'raw' = the 5-minute samples, 'hourly' = hourly averages (ranges older than a week) */
  source: 'raw' | 'hourly' | 'live';
  samples: number;
  series: HistorySeries[];
}
export interface HistoryQuery { group: string; range?: string; from?: string; to?: string; params?: string[] }

/** History of a chart group (Monitor > Graphs), up to 6 months — read from the NMS's stored samples, not from the device. */
export async function fetchNodeViewHistory(deviceId: string, q: HistoryQuery, signal?: AbortSignal): Promise<HistoryData | null> {
  const qs = new URLSearchParams({ group: q.group });
  if (q.range) qs.set('range', q.range);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  if (q.params?.length) qs.set('params', q.params.join(','));
  const res = await apiClient.get<{ status: string; data?: HistoryData }>(`${BASE}/${encodeURIComponent(deviceId)}/history?${qs.toString()}`, { signal, validateStatus: (s) => s === 200 || s === 400 });
  return res.data.status === 'ok' && res.data.data ? res.data.data : null;
}

/** One live reading of a radio's chart metrics: `values` is keyed `param~instance` ('wirelessStatsTxThroughput~2', link rows '…~2-1'). */
export interface LiveStatsSample { ts: number; values: Record<string, number> }

/** Fresh statistics of one radio row (1 = 2.4 GHz, 2 = Radio 1, 3 = Radio 2) — an SNMP GET by the gateway, shared for 3 s. */
export async function fetchLiveStats(deviceId: string, row: string, signal?: AbortSignal): Promise<LiveStatsSample | null> {
  const res = await apiClient.get<{ status: string; data?: LiveStatsSample }>(`${BASE}/${encodeURIComponent(deviceId)}/live-stats?row=${encodeURIComponent(row)}`, { signal, validateStatus: (s) => s === 200 || s === 422 });
  return res.data.status === 'ok' && res.data.data ? res.data.data : null;
}

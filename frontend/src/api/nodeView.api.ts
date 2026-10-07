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
  NodeViewApplyResponse, NodeViewChange, NodeViewResponse, WireframeOnlyResponse,
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

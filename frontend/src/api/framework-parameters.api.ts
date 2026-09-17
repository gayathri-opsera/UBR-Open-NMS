/**
 * WO-012: API client for the framework parameter current-value endpoint.
 *
 * Wraps GET /api/framework/v1/devices/{deviceId}/parameters/current and
 * provides normalised error handling and typed responses consistent with
 * the existing framework.client.ts patterns.
 *
 * Credential secrets are never included in request or response payloads.
 * Authorization is carried by the bearer token attached globally by the
 * axios instance supplied to each function.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  ParameterCurrentValueResponse,
  ParameterCurrentValueError,
  ParameterCurrentValue,
  ParameterCurrentValueGroup,
  FreshnessState,
} from './framework-parameters.types';

// Re-export types so consumers only need this module.
export type {
  ParameterCurrentValueResponse,
  ParameterCurrentValueError,
  ParameterCurrentValue,
  ParameterCurrentValueGroup,
  FreshnessState,
};
export type { ParameterReadStatus, PollFailureCategory } from './framework-parameters.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = '/api/framework/v1';

// ── Error normalisation ───────────────────────────────────────────────────────

/**
 * Converts an Axios error into a ParameterCurrentValueError.
 * Surfaces the structured error envelope from the downstream response
 * when available, otherwise builds a synthetic error.
 */
function normaliseError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ error?: ParameterCurrentValueError }>;
    const embedded = axiosErr.response?.data?.error;
    if (embedded) throw embedded;

    const synthetic: ParameterCurrentValueError = {
      code:          axiosErr.code === 'ECONNABORTED' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message:       axiosErr.message,
      details:       { status: axiosErr.response?.status },
      correlationId: '',
    };
    throw synthetic;
  }
  throw err;
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

/**
 * Normalise a raw API parameter value record.
 *
 * Preserves all fields and adds computed helpers:
 * - isFresh: true when freshnessState === 'FRESH'
 * - hasFailed: true when readStatus is a failure variant
 */
export function normaliseParameterValue(raw: ParameterCurrentValue): ParameterCurrentValue & {
  isFresh: boolean;
  hasFailed: boolean;
} {
  return {
    ...raw,
    // Preserve legacy records that may arrive without freshnessState.
    freshnessState: raw.freshnessState ?? 'UNKNOWN_DEVICE',
    readStatus:     raw.readStatus ?? 'UNKNOWN',
    isFresh:        raw.freshnessState === 'FRESH',
    hasFailed:      raw.readStatus !== 'SUCCESS' && raw.readStatus !== 'UNMAPPED',
  };
}

/**
 * Normalise an API response, coercing all parameter values.
 * Safe to call on both success and error responses.
 */
export function normaliseCurrentValueResponse(
  raw: ParameterCurrentValueResponse,
): ParameterCurrentValueResponse {
  if (!raw.data) return raw;

  const groups: ParameterCurrentValueGroup[] = (raw.data.groups ?? []).map((g) => ({
    ...g,
    parameters: (g.parameters ?? []).map(normaliseParameterValue),
  }));

  return {
    ...raw,
    data: { ...raw.data, groups },
  };
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch current polled parameter values for a device.
 *
 * GET /api/framework/v1/devices/{deviceId}/parameters/current
 *
 * @param deviceId     - Inventory device identifier.
 * @param correlationId - Optional correlation ID to pass in the request header.
 * @param instance     - Axios instance to use (defaults to global axios).
 *
 * @throws {ParameterCurrentValueError} on HTTP error or network failure.
 */
export async function getDeviceCurrentParameterValues(
  deviceId: string,
  correlationId?: string,
  instance: AxiosInstance = axios as unknown as AxiosInstance,
): Promise<ParameterCurrentValueResponse> {
  try {
    const headers: Record<string, string> = {};
    if (correlationId) {
      headers['X-Correlation-Id'] = correlationId;
    }

    const response = await instance.get<ParameterCurrentValueResponse>(
      `${BASE}/devices/${encodeURIComponent(deviceId)}/parameters/current`,
      { headers },
    );

    return normaliseCurrentValueResponse(response.data);
  } catch (err) {
    normaliseError(err);
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/**
 * Return the count of parameters in a given freshness state across all groups.
 */
export function countByFreshnessState(
  groups: ParameterCurrentValueGroup[],
  state: FreshnessState,
): number {
  return groups.reduce(
    (total, g) => total + g.parameters.filter((p) => p.freshnessState === state).length,
    0,
  );
}

/**
 * Flatten all parameter values from all groups into a single array.
 * Useful for table rendering or export.
 */
export function flattenParameterValues(groups: ParameterCurrentValueGroup[]): ParameterCurrentValue[] {
  return groups.flatMap((g) => g.parameters);
}

/**
 * Determine the overall device health badge based on freshness state counts.
 *
 * Returns:
 *   'healthy'  — all parameters are FRESH
 *   'degraded' — some parameters are STALE or FAILED
 *   'failed'   — all parameters are FAILED or UNMAPPED
 *   'unknown'  — no parameters present
 */
export function computeDeviceHealthBadge(
  groups: ParameterCurrentValueGroup[],
): 'healthy' | 'degraded' | 'failed' | 'unknown' {
  const all = flattenParameterValues(groups);
  if (all.length === 0) return 'unknown';

  const freshCount  = all.filter((p) => p.freshnessState === 'FRESH').length;
  const failedCount = all.filter((p) => p.freshnessState === 'FAILED').length;

  if (freshCount === all.length) return 'healthy';
  if (failedCount === all.length) return 'failed';
  return 'degraded';
}

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

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { getAccessToken } from '../auth/tokens';
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
export type { ParameterInstance, DevicePollStatus } from './framework-parameters.types';
export type { ParameterReadStatus, PollFailureCategory } from './framework-parameters.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = '/api/framework/v1';

/**
 * Shared framework axios instance — same origin as the page so Vite proxies it,
 * but with the Bearer token injected per request (cannot use apiClient because
 * its baseURL prefix would corrupt the /api/framework/v1 path).
 */
const frameworkAxios: AxiosInstance = axios.create();
frameworkAxios.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

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
  // Default to the framework-specific axios instance that injects Bearer tokens.
  // Tests can inject a mock instance via the third parameter.
  instance: AxiosInstance = frameworkAxios,
  options?: { refresh?: boolean },
): Promise<ParameterCurrentValueResponse> {
  try {
    const headers: Record<string, string> = {};
    if (correlationId) {
      headers['X-Correlation-Id'] = correlationId;
    }

    const response = await instance.get<ParameterCurrentValueResponse>(
      `${BASE}/devices/${encodeURIComponent(deviceId)}/parameters/current`,
      { headers, params: options?.refresh ? { refresh: 1 } : undefined },
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

// ── Parameter write ───────────────────────────────────────────────────────────

export interface ParameterWriteResult {
  parameterId: string;
  accepted: boolean;
  message?: string;
}

/**
 * Write a new value to a writable parameter on a device.
 *
 * The gateway proxies this to the parameter-poller service which validates
 * the value against the registry schema (dataType, minValue, maxValue,
 * enumValues) before applying the change.
 *
 * Only parameters with {@code readOnly = false} in the active product
 * definition registry may be written. The server enforces this regardless
 * of the client-side check.
 *
 * @param deviceId   - Device serial number or inventory ID.
 * @param parameterId - Stable parameter ID from the registry.
 * @param value      - New value as a string (number, enum label, or boolean string).
 * @param instance   - Optional axios instance override (useful in tests).
 */
export async function updateDeviceParameter(
  deviceId: string,
  parameterId: string,
  value: string,
  instance: AxiosInstance = frameworkAxios,
): Promise<ParameterWriteResult> {
  const res = await instance.put<ParameterWriteResult>(
    `/api/framework/v1/devices/${deviceId}/parameters/${parameterId}`,
    { value },
  );
  return res.data;
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

/**
 * WO-007: API client for the read-only /api/framework/v1 northbound APIs.
 *
 * All methods return typed results and normalise HTTP error responses into a
 * consistent FrameworkApiError shape so callers can rely on a single error type.
 *
 * Authorization is carried by the bearer token in the Authorization header,
 * which is attached globally by the axios instance passed in (or the default
 * axiosInstance from this module).
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  FrameworkApiError,
  DeviceFrameworkIdentity,
  DiscoveryRunResultsResponse,
  GuidedFailuresResponse,
  GuidedFailure,
  FailureCategory,
  FrameworkSecurityStatus,
} from './framework.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = '/api/framework/v1';

// ── Error normalisation ───────────────────────────────────────────────────────

/**
 * Convert an Axios error into a consistent FrameworkApiError.
 * If the downstream response already contains the structured envelope, its error
 * field is surfaced directly; otherwise, a synthetic error object is built.
 */
function normaliseError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ error?: FrameworkApiError }>;
    const embedded = axiosErr.response?.data?.error;
    if (embedded) throw embedded;

    const synthetic: FrameworkApiError = {
      code:          axiosErr.code === 'ECONNABORTED' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message:       axiosErr.message,
      details:       { status: axiosErr.response?.status },
      correlationId: '',
    };
    throw synthetic;
  }
  // Re-throw non-axios errors unchanged
  throw err;
}

// ── Default axios instance ────────────────────────────────────────────────────

/** Create the default instance; callers may pass their own to share interceptors. */
export const axiosInstance: AxiosInstance = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

// ── Device Framework Identity ─────────────────────────────────────────────────

/**
 * Fetch the framework classification (fingerprint match) for a single device.
 *
 * @param deviceId   - Platform device identifier
 * @param http       - Optional axios instance (defaults to module-level instance)
 */
export async function getDeviceFrameworkIdentity(
  deviceId: string,
  http: AxiosInstance = axiosInstance,
): Promise<DeviceFrameworkIdentity> {
  try {
    const res = await http.get<DeviceFrameworkIdentity>(
      `${BASE}/devices/${encodeURIComponent(deviceId)}/framework-identity`,
    );
    return res.data;
  } catch (err) {
    return normaliseError(err);
  }
}

// ── Discovery Run Results ─────────────────────────────────────────────────────

export interface DiscoveryRunResultsParams {
  /** Page size — clamped to [1, 100] by the gateway. Default 20. */
  limit?:  number;
  /** Opaque cursor from a previous response. Absent for the first page. */
  cursor?: string;
  /** Sort field and direction. Default 'createdAt_desc'. */
  sort?:   string;
}

/**
 * Fetch paginated results for a specific discovery run.
 *
 * @param runId   - Discovery run identifier
 * @param params  - Optional pagination parameters
 * @param http    - Optional axios instance
 */
export async function getDiscoveryRunResults(
  runId: string,
  params: DiscoveryRunResultsParams = {},
  http: AxiosInstance = axiosInstance,
): Promise<DiscoveryRunResultsResponse> {
  try {
    const res = await http.get<DiscoveryRunResultsResponse>(
      `${BASE}/discovery/runs/${encodeURIComponent(runId)}/results`,
      { params },
    );
    return res.data;
  } catch (err) {
    return normaliseError(err);
  }
}

// ── Guided Failures ───────────────────────────────────────────────────────────

export interface GuidedFailuresParams {
  /** Page size — clamped to [1, 100] by the gateway. Default 20. */
  limit?:   number;
  /** Opaque cursor from a previous response. */
  cursor?:  string;
  /** Filter by failure category. */
  status?:  FailureCategory;
  /** Sort field and direction. Default 'lastFailedAt_desc'. */
  sort?:    string;
}

/**
 * Fetch paginated guided framework failures (unreachable / unknown / adapter_failed / stale devices).
 *
 * @param params  - Optional filter / pagination parameters
 * @param http    - Optional axios instance
 */
export async function getGuidedFailures(
  params: GuidedFailuresParams = {},
  http: AxiosInstance = axiosInstance,
): Promise<GuidedFailuresResponse> {
  try {
    const res = await http.get<GuidedFailuresResponse>(`${BASE}/failures`, { params });
    return res.data;
  } catch (err) {
    return normaliseError(err);
  }
}

// ── Framework Security Status ─────────────────────────────────────────────────

/**
 * Fetch the current framework security readiness status.
 *
 * REQUIRES SuperAdmin framework capability — callers with lesser roles will
 * receive a 403 from the gateway.
 *
 * @param http  - Optional axios instance
 */
export async function getFrameworkSecurityStatus(
  http: AxiosInstance = axiosInstance,
): Promise<FrameworkSecurityStatus> {
  try {
    const res = await http.get<FrameworkSecurityStatus>(`${BASE}/security/status`);
    return res.data;
  } catch (err) {
    return normaliseError(err);
  }
}

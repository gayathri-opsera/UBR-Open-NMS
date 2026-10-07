/**
 * WO-014: API client for the framework adaptive UI template endpoint.
 *
 * Wraps GET /api/framework/v1/devices/{deviceId}/ui-template and provides
 * normalised error handling, typed responses, and widget auto-selection logic.
 *
 * Widget selection rules (applied server-side but validated client-side):
 *   1. Explicit uiWidget from metadata overrides auto-selection.
 *   2. dataType "boolean"               → toggle
 *   3. dataType matches enumValues list → dropdown
 *   4. dataType "counter" or "gauge"    → counter / gauge
 *   5. numeric + minValue + maxValue    → slider
 *   6. Everything else                  → textfield (safe fallback)
 *
 * All widgets are rendered read-only or disabled in P0. Controls that imply
 * writability (submit buttons, editable inputs) must not be enabled.
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { getAccessToken } from '../auth/tokens';
import { ensureFreshAccessToken } from './client';
import type {
  AdaptiveUiTemplateResponse,
  AdaptivePanelError,
  AdaptiveParameter,
  UiWidget,
} from './framework-panels.types';

// Re-export types for consumers that only import this module.
export type {
  AdaptiveUiTemplateResponse,
  AdaptivePanelError,
  AdaptiveParameter,
  AdaptiveParameterGroup,
  AdaptiveUiTemplateData,
  AdapterContext,
  ParameterThresholds,
  UiWidget,
  AdaptivePanelErrorCode,
} from './framework-panels.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = '/api/framework/v1';

/**
 * Shared framework axios instance — same origin as the page so Vite proxies it,
 * but with the Bearer token injected per request (cannot use apiClient because
 * its baseURL prefix would corrupt the /api/framework/v1 path).
 */
const frameworkAxios: AxiosInstance = axios.create();
frameworkAxios.interceptors.request.use(async (config) => {
  await ensureFreshAccessToken(); // keeps long-open pages (auto-refreshing Node View) logged in
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Error normalisation ───────────────────────────────────────────────────────

function normaliseError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ error?: AdaptivePanelError }>;
    const embedded = axiosErr.response?.data?.error;
    if (embedded) throw embedded;

    const synthetic: AdaptivePanelError = {
      code:          axiosErr.code === 'ECONNABORTED' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message:       axiosErr.message,
      details:       { status: axiosErr.response?.status },
      correlationId: '',
    };
    throw synthetic;
  }
  throw err;
}

// ── Widget selection ──────────────────────────────────────────────────────────

/**
 * Select the effective widget for a parameter given its metadata.
 *
 * Priority:
 *  1. Explicit valid uiWidget from metadata.
 *  2. 'toggle'    — dataType is 'boolean'
 *  3. 'dropdown'  — dataType is 'enum' or non-empty enumValues present
 *  4. 'gauge'     — dataType is 'gauge'
 *  5. 'counter'   — dataType is 'counter'
 *  6. 'slider'    — numeric type with both minValue and maxValue defined
 *  7. 'textfield' — fallback for all remaining cases
 *
 * Unknown or invalid uiWidget values from metadata fall through to auto-selection
 * rather than crashing the page.
 */
export function selectWidget(param: Omit<AdaptiveParameter, 'effectiveWidget'>): UiWidget {
  const validWidgets: UiWidget[] = [
    'textfield', 'slider', 'dropdown', 'toggle', 'gauge', 'counter', 'readonly',
  ];

  // Step 1: Explicit metadata override when the widget name is known.
  if (param.uiWidget && validWidgets.includes(param.uiWidget)) {
    return param.uiWidget;
  }

  const dt = (param.dataType ?? '').toLowerCase();

  // Step 2: Boolean → toggle
  if (dt === 'boolean') return 'toggle';

  // Step 3: Enum or non-empty enumValues → dropdown
  if (dt === 'enum' || (param.enumValues && param.enumValues.length > 0)) return 'dropdown';

  // Step 4/5: Named metric types
  if (dt === 'gauge')   return 'gauge';
  if (dt === 'counter') return 'counter';

  // Step 6: Numeric with range → slider
  const isNumeric = ['number', 'integer', 'float', 'double'].includes(dt) ||
                    dt === '' || dt === 'gauge' || dt === 'counter';
  if (isNumeric && param.minValue !== undefined && param.maxValue !== undefined) return 'slider';

  // Step 7: Safe fallback
  return 'textfield';
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch the adaptive UI template for a device.
 *
 * GET /api/framework/v1/devices/{deviceId}/ui-template
 *
 * The template response has server-side role filtering already applied.
 * The client must not attempt to derive role information from presence
 * or absence of parameters.
 *
 * @throws {AdaptivePanelError} on HTTP or network failure.
 */
export async function getDeviceUiTemplate(
  deviceId: string,
  correlationId?: string,
  // Default to the framework-specific axios instance that injects Bearer tokens.
  // Tests can inject a mock instance via the third parameter.
  instance: AxiosInstance = frameworkAxios,
): Promise<AdaptiveUiTemplateResponse> {
  try {
    const headers: Record<string, string> = {};
    if (correlationId) headers['X-Correlation-Id'] = correlationId;

    const response = await instance.get<AdaptiveUiTemplateResponse>(
      `${BASE}/devices/${encodeURIComponent(deviceId)}/ui-template`,
      { headers },
    );

    return normaliseTemplateResponse(response.data);
  } catch (err) {
    normaliseError(err);
  }
}

/**
 * Normalise a raw template response.
 * Computes effectiveWidget for every parameter so the page never
 * has to call selectWidget at render time.
 */
export function normaliseTemplateResponse(raw: AdaptiveUiTemplateResponse): AdaptiveUiTemplateResponse {
  if (!raw.data) return raw;

  const groups = (raw.data.groups ?? []).map((g) => ({
    ...g,
    parameters: (g.parameters ?? []).map((p) => ({
      ...p,
      effectiveWidget: selectWidget(p),
    })),
  }));

  return { ...raw, data: { ...raw.data, groups } };
}

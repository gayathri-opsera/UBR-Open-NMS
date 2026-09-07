/**
 * Dedicated typed client for the unified onboarding-status API (WO-038 / WO-044).
 * Re-exports typed functions and adds convenience wrappers consumed by the
 * V2UnifiedOnboardingPage. Sensitive fields (certs, HMAC, nonces) are never
 * present in the API response — enforced server-side.
 */
import { apiClient } from './client';
import type {
  OnboardingStatusItem,
  OnboardingStatusResponse,
  OnboardingStatusFilter,
  OnboardingStateValue,
} from './devices.types';

export type {
  OnboardingStatusItem,
  OnboardingStatusResponse,
  OnboardingStatusFilter,
  OnboardingStateValue,
};

export type DiscoveryParadigm = 'UBR' | 'GENERIC' | string;

/**
 * Fetch the paginated onboarding-status list from the inventory service.
 * Passes only defined filter fields to avoid backend validation errors.
 */
export async function fetchOnboardingStatus(
  filter: OnboardingStatusFilter = {},
): Promise<OnboardingStatusResponse> {
  const params: Record<string, string | number> = {};
  if (filter.page !== undefined)   params.page = filter.page;
  if (filter.limit !== undefined)  params.limit = filter.limit;
  if (filter.state)                params.state = filter.state;
  if (filter.paradigm)             params.paradigm = filter.paradigm;
  if (filter.deviceType)           params.deviceType = filter.deviceType;
  if (filter.reasonCategory)       params.reasonCategory = filter.reasonCategory;
  if (filter.serialNumber)         params.serialNumber = filter.serialNumber;
  if (filter.macAddress)           params.macAddress = filter.macAddress;
  if (filter.sysObjectID)          params.sysObjectID = filter.sysObjectID;
  if (filter.from)                 params.from = filter.from;
  if (filter.to)                   params.to = filter.to;

  const res = await apiClient.get<OnboardingStatusResponse>(
    '/inventory/onboarding-status',
    { params },
  );
  return res.data;
}

/**
 * Fetch the onboarding status for a single device by its inventory ID.
 */
export async function fetchOnboardingStatusById(
  deviceId: string,
): Promise<OnboardingStatusItem> {
  const res = await apiClient.get<OnboardingStatusItem>(
    `/inventory/onboarding-status/${deviceId}`,
  );
  return res.data;
}

/**
 * Map an onboarding state value to a UI-friendly variant for badge/indicator rendering.
 * Returns one of: success | warning | danger | info | default
 */
export function onboardingStateVariant(
  state: OnboardingStateValue,
): 'success' | 'warning' | 'danger' | 'default' {
  switch (state) {
    case 'MANAGED':              return 'success';
    case 'AUTHENTICATED':
    case 'CHECK_IN_RECEIVED':    return 'default';
    case 'PENDING':
    case 'PENDING_ASSIGNMENT':
    case 'CONFIG_WITHHELD':
    case 'RETRYING':             return 'warning';
    case 'FAILED':
    case 'REDIRECTED':           return 'danger';
    default:                     return 'default';
  }
}

/**
 * Returns a human-readable label for each onboarding state.
 */
export function onboardingStateLabel(state: OnboardingStateValue): string {
  const labels: Record<string, string> = {
    MANAGED:            'Managed',
    PENDING:            'Pending',
    AUTHENTICATED:      'Authenticated',
    CHECK_IN_RECEIVED:  'Checked In',
    PENDING_ASSIGNMENT: 'Pending Assignment',
    CONFIG_WITHHELD:    'Config Withheld',
    FAILED:             'Failed',
    RETRYING:           'Retrying',
    REDIRECTED:         'Redirected',
    UNKNOWN:            'Unknown',
  };
  return labels[state] ?? String(state);
}

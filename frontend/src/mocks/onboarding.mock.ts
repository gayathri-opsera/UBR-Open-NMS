import type { OnboardingStatusItem, OnboardingStatusResponse } from '../api/devices.types';

// Fixtures covering every visible onboarding state for testing.
// Sensitive fields (HMAC, nonces, certs, credential refs) intentionally omitted —
// if they appear accidentally in test payloads they must be redacted by the UI.
export const MOCK_ONBOARDING_ITEMS: OnboardingStatusItem[] = [
  {
    deviceId: 'dev-ubr-001',
    serialNumber: 'UBR-SN-001',
    macAddress: '00:1A:2B:3C:4D:01',
    deviceType: 'CPE',
    discoveryParadigm: 'UBR',
    bootstrapState: 'REALTIME_ESTABLISHED',
    onboardingState: 'MANAGED',
    lastSuccessfulState: 'MANAGED',
    lastCheckInAt: new Date(Date.now() - 60_000).toISOString(),
    lastRealtimeAt: new Date(Date.now() - 30_000).toISOString(),
    assignmentState: 'ASSIGNED',
    configurationDeliveryState: 'ELIGIBLE',
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-002',
    serialNumber: 'UBR-SN-002',
    macAddress: '00:1A:2B:3C:4D:02',
    deviceType: 'CPE',
    discoveryParadigm: 'UBR',
    bootstrapState: 'AUTHENTICATED',
    onboardingState: 'AUTHENTICATED',
    lastCheckInAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-003',
    serialNumber: 'UBR-SN-003',
    macAddress: '00:1A:2B:3C:4D:03',
    deviceType: 'BTS',
    discoveryParadigm: 'UBR',
    bootstrapState: 'CHECK_IN_RECEIVED',
    onboardingState: 'PENDING_ASSIGNMENT',
    lastCheckInAt: new Date(Date.now() - 300_000).toISOString(),
    assignmentState: 'UNASSIGNED',
    configurationDeliveryState: 'WITHHELD',
    retryAfterSeconds: 0,
    updatedAt: new Date(Date.now() - 300_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-004',
    serialNumber: 'UBR-SN-004',
    macAddress: '00:1A:2B:3C:4D:04',
    deviceType: 'CPE',
    discoveryParadigm: 'UBR',
    bootstrapState: 'AUTHENTICATED',
    onboardingState: 'CONFIG_WITHHELD',
    lastCheckInAt: new Date(Date.now() - 600_000).toISOString(),
    assignmentState: 'ASSIGNED',
    configurationDeliveryState: 'WITHHELD',
    reasonCategory: 'POLICY_HOLD',
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-005',
    serialNumber: 'UBR-SN-005',
    macAddress: '00:1A:2B:3C:4D:05',
    deviceType: 'CPE',
    discoveryParadigm: 'UBR',
    bootstrapState: 'FAILED',
    onboardingState: 'FAILED',
    lastSuccessfulState: 'AUTHENTICATED',
    reasonCategory: 'HMAC_VALIDATION_FAILED',
    retryAfterSeconds: 300,
    retryJitterMaxSeconds: 60,
    updatedAt: new Date(Date.now() - 900_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-006',
    serialNumber: 'UBR-SN-006',
    macAddress: '00:1A:2B:3C:4D:06',
    deviceType: 'CPE',
    discoveryParadigm: 'UBR',
    bootstrapState: 'FAILED',
    onboardingState: 'RETRYING',
    lastSuccessfulState: 'CHECK_IN_RECEIVED',
    reasonCategory: 'TIMEOUT',
    retryAfterSeconds: 120,
    updatedAt: new Date(Date.now() - 200_000).toISOString(),
  },
  {
    deviceId: 'dev-ubr-007',
    serialNumber: 'UBR-SN-007',
    macAddress: '00:1A:2B:3C:4D:07',
    deviceType: 'IDU',
    discoveryParadigm: 'UBR',
    bootstrapState: 'FAILED',
    onboardingState: 'REDIRECTED',
    reasonCategory: 'REDIRECT_RESPONSE',
    updatedAt: new Date(Date.now() - 1_800_000).toISOString(),
  },
  {
    deviceId: 'dev-generic-001',
    serialNumber: '',
    macAddress: undefined,
    deviceType: 'GENERIC',
    discoveryParadigm: 'GENERIC',
    sysObjectID: '1.3.6.1.4.1.9.1.1208',
    onboardingState: 'MANAGED',
    lastSuccessfulState: 'MANAGED',
    updatedAt: new Date(Date.now() - 45_000).toISOString(),
  },
  {
    deviceId: 'dev-generic-002',
    serialNumber: '',
    macAddress: undefined,
    deviceType: 'GENERIC',
    discoveryParadigm: 'GENERIC',
    sysObjectID: '1.3.6.1.4.1.2636.1.1.1.2.11',
    onboardingState: 'PENDING',
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
];

export const MOCK_ONBOARDING_RESPONSE: OnboardingStatusResponse = {
  items: MOCK_ONBOARDING_ITEMS,
  page: 0,
  limit: 50,
  total: MOCK_ONBOARDING_ITEMS.length,
  capabilityStatus: 'enabled',
};

export const MOCK_ONBOARDING_RESPONSE_DISABLED: OnboardingStatusResponse = {
  items: [],
  page: 0,
  limit: 50,
  total: 0,
  capabilityStatus: 'disabled',
};

export const MOCK_ONBOARDING_RESPONSE_EMPTY: OnboardingStatusResponse = {
  items: [],
  page: 0,
  limit: 50,
  total: 0,
  capabilityStatus: 'enabled',
};

// Payload with accidental sensitive field for redaction tests.
// The UI must never render hmacSecret, nonce, certificate, or credentialRef.
export const MOCK_ONBOARDING_ITEM_WITH_SENSITIVE: OnboardingStatusItem & Record<string, unknown> = {
  ...(MOCK_ONBOARDING_ITEMS[0] as OnboardingStatusItem),
  hmacSecret: 'secret-should-never-render',
  nonce: 'nonce-value-redacted',
  certificate: '-----BEGIN CERTIFICATE-----',
  credentialRef: 'cred-vault-path',
};

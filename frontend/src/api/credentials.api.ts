/**
 * Credentials API — CRUD wrapper around the discovery-service credential endpoints.
 *
 * Backend: POST|GET|PUT|DELETE /api/v1/discovery/credentials
 * Security: sensitive fields (community strings, auth/priv keys) are never returned
 * by the API — the backend always returns SNMPCredentialSummary (redacted form).
 * Admin role is required for Create, Update, and Delete operations.
 */
import { apiClient } from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SNMPVersion = 'V1' | 'V2C' | 'V3';

export type SNMPv3SecurityLevel = 'NO_AUTH_NO_PRIV' | 'AUTH_NO_PRIV' | 'AUTH_PRIV';

export type SNMPv3AuthProtocol = 'MD5' | 'SHA' | 'SHA256';

export type SNMPv3PrivacyProtocol = 'DES' | 'AES';

/**
 * Redacted credential summary returned by all GET/POST/PUT endpoints.
 * Sensitive fields (community, authKey, privKey) are never returned.
 */
export interface CredentialSummary {
  id: string;
  name: string;
  description?: string;
  version: SNMPVersion;
  /** Masked indication only — the actual community is never returned. */
  communityMasked?: string;
  securityLevel?: SNMPv3SecurityLevel;
  authProtocol?: SNMPv3AuthProtocol;
  privProtocol?: SNMPv3PrivacyProtocol;
  securityName?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/**
 * Payload for creating a new SNMP credential.
 * For SNMPv1/v2c: supply `community`.
 * For SNMPv3: supply `securityName`, `securityLevel`, `authProtocol`,
 *             `authKey`, `privProtocol`, `privKey`.
 */
export interface CreateCredentialRequest {
  name: string;
  description?: string;
  version: SNMPVersion;
  /** SNMPv1/v2c community string. Required for V1 and V2C. */
  community?: string;
  securityName?: string;
  securityLevel?: SNMPv3SecurityLevel;
  authProtocol?: SNMPv3AuthProtocol;
  /** SNMPv3 authentication key. Required when securityLevel is AUTH_NO_PRIV or AUTH_PRIV. */
  authKey?: string;
  privProtocol?: SNMPv3PrivacyProtocol;
  /** SNMPv3 privacy key. Required when securityLevel is AUTH_PRIV. */
  privKey?: string;
}

/**
 * Payload for updating an existing SNMP credential.
 * All fields are optional — only supplied fields are changed.
 * To rotate a community string or key, include the new value.
 */
export type UpdateCredentialRequest = Partial<CreateCredentialRequest>;

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Create a new SNMP credential. Admin role required.
 *
 * @throws Error on 400 (validation), 403 (not admin), 409 (duplicate name), 500
 */
export async function createCredential(
  req: CreateCredentialRequest,
): Promise<CredentialSummary> {
  const res = await apiClient.post<CredentialSummary>('/discovery/credentials', req);
  return res.data;
}

/**
 * List all active SNMP credentials (redacted).
 * No role restriction — Network Operators can read the list to pick a credential.
 */
export async function listCredentials(): Promise<CredentialSummary[]> {
  const res = await apiClient.get<CredentialSummary[] | { credentials: CredentialSummary[] }>(
    '/discovery/credentials',
  );
  const data = res.data;
  if (Array.isArray(data)) return data;
  if (data && 'credentials' in data && Array.isArray(data.credentials)) return data.credentials;
  return [];
}

/**
 * Fetch a single credential summary by ID.
 *
 * @throws Error on 404 (not found) or 500
 */
export async function getCredential(credentialId: string): Promise<CredentialSummary> {
  const res = await apiClient.get<CredentialSummary>(
    `/discovery/credentials/${credentialId}`,
  );
  return res.data;
}

/**
 * Update an existing credential. Admin role required.
 *
 * @throws Error on 400 (validation), 403 (not admin), 404 (not found), 500
 */
export async function updateCredential(
  credentialId: string,
  req: UpdateCredentialRequest,
): Promise<CredentialSummary> {
  const res = await apiClient.put<CredentialSummary>(
    `/discovery/credentials/${credentialId}`,
    req,
  );
  return res.data;
}

/**
 * Soft-delete a credential by ID. Admin role required.
 *
 * @throws Error on 403 (not admin), 404 (not found), 500
 */
export async function deleteCredential(credentialId: string): Promise<void> {
  await apiClient.delete(`/discovery/credentials/${credentialId}`);
}

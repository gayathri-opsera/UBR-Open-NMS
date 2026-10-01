/**
 * DiscoveryTriggerForm — initiates an SNMP discovery scan.
 *
 * Renders scope input, SNMP protocol selector, credential selector (WO-027),
 * timeout, and retries fields. Validates client-side before calling the API.
 * Notifies parent via `onRunCreated` callback on success.
 *
 * WO-027: Community string input is replaced by a credential dropdown backed
 * by the /api/v1/discovery/credentials endpoint.  If no credentials exist yet,
 * a fallback community-string input is shown so operators are never blocked.
 *
 * Security: community strings are NEVER logged or stored beyond the form state.
 * They are sent over HTTPS in the request body and are masked in the UI.
 */
import { useState, useCallback, useEffect } from 'react';

import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { ScopeInput } from './ScopeInput';
import { createDiscoveryRun, parseScopeInput } from '../../../api/discovery.api';
import type { SnmpProtocol, DiscoveryRunResponse } from '../../../api/discovery.api';
import { listCredentials } from '../../../api/credentials.api';
import type { CredentialSummary } from '../../../api/credentials.api';
import { logger } from '../../utils/logger';
import {
  listAllUploadHistory,
  getVersionSchema,
} from '../../../api/productDefinitions.api';
import type {
  ProductDefinitionSchema,
} from '../../../api/productDefinitions.api';
import type { ProductDefinitionVersion } from '../../../api/productDefinitions.types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryTriggerFormProps {
  /**
   * Called when a discovery run is successfully created.
   * @param run The full response object from the discovery-service.
   */
  onRunCreated: (run: DiscoveryRunResponse) => void;
  /**
   * Optional pre-populated scope value (e.g. from a "Re-run" action in the
   * history view).
   */
  initialScope?: string;
}

interface FormState {
  scope: string;
  scopeValid: boolean;
  protocol: SnmpProtocol;
  /** ID of a stored credential to use; empty string means "use fallback community". */
  credentialId: string;
  /**
   * Fallback community string used only when no credentials are configured
   * or the operator explicitly chooses "Use direct community string".
   * SECURITY: never logged; sent HTTPS-only.
   */
  community: string;
  timeoutSeconds: string;
  retries: string;
  /**
   * Skip ICMP ping sweep — go directly to SNMP GET on every target.
   * Needed for Docker / simulator targets where ICMP is blocked.
   * Gateway intercepts these runs and uses SNMP-only discovery.
   */
  icmpBypass: boolean;
}

interface FormErrors {
  community?: string;
  timeoutSeconds?: string;
  retries?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROTOCOL_OPTIONS = [
  { value: 'SNMP_V2C', label: 'SNMPv2c (recommended)' },
  { value: 'SNMP_V1',  label: 'SNMPv1' },
];

/** Sentinel option value that means "enter community string manually". */
const FALLBACK_OPTION = '__fallback__';

// ── Group icon map for fingerprint panel ──────────────────────────────────────
const GROUP_ICONS: Record<string, string> = {
  cpu: '⚙️', memory: '💾', interface: '🔌', environment: '🌡️',
  bgp: '🔗', spanning_tree: '🌳', wireless: '📶', radio: '📡',
  network: '🌐', vlan: '🔀', qos: '⚡', management: '🛠',
};

function groupIcon(name: string): string {
  return GROUP_ICONS[name.toLowerCase()] ?? '📋';
}

// ── Product-definition fingerprint context panel ───────────────────────────────
/**
 * Displays the SNMP fingerprints and protocols from a selected product
 * definition version so operators know which device types will be
 * classified during this discovery run.
 */
function ProductDefinitionContextPanel({ schema }: { schema: ProductDefinitionSchema }) {
  return (
    <div style={{
      background: 'rgba(96,165,250,0.06)',
      border: '1px solid rgba(96,165,250,0.2)',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 18 }}>🔍</span>
        <div>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--vf-text-primary)' }}>
            {schema.vendor} {schema.model}
          </span>
          {schema.productFamily && (
            <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginLeft: 8 }}>
              ({schema.productFamily})
            </span>
          )}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {schema.protocols.map((p) => (
            <span key={p} style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', padding: '2px 6px', borderRadius: 4,
              background: 'rgba(96,165,250,0.15)', color: '#60a5fa',
            }}>{p}</span>
          ))}
        </div>
      </div>

      {/* Fingerprints */}
      {schema.fingerprints.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'var(--vf-text-muted)', marginBottom: 6 }}>
            SNMP Fingerprints — used to classify discovered devices
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {schema.fingerprints.map((fp, i) => (
              <div key={i} style={{
                background: 'var(--vf-surface)', borderRadius: 6,
                padding: '6px 10px', fontSize: 11,
                display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
              }}>
                <span style={{ color: 'var(--vf-text-muted)' }}>OID:</span>
                <code style={{ color: '#60a5fa', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                  {fp.sysObjectId}
                </code>
                {fp.sysDescrPattern && (
                  <>
                    <span style={{ color: 'var(--vf-text-muted)' }}>Pattern:</span>
                    <code style={{ color: 'var(--vf-text-secondary)', fontFamily: 'var(--vf-font-mono)', fontSize: 11 }}>
                      {fp.sysDescrPattern}
                    </code>
                  </>
                )}
                {(fp.firmwareFrom || fp.firmwareTo) && (
                  <span style={{ color: 'var(--vf-text-muted)', fontSize: 10 }}>
                    FW: {fp.firmwareFrom ?? '*'}–{fp.firmwareTo ?? '*'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Parameter groups summary */}
      {schema.groups.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {schema.groups.map((g) => (
            <span key={g.groupName} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
              color: 'var(--vf-text-secondary)',
            }}>
              {groupIcon(g.groupName)} {g.groupName} ({g.parameters.length})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function buildInitialState(initialScope?: string): FormState {
  return {
    scope:          initialScope ?? '',
    scopeValid:     !!initialScope,
    protocol:       'SNMP_V2C',
    credentialId:   '',
    community:      'public',
    timeoutSeconds: '5',
    retries:        '2',
    icmpBypass:     false,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateForm(state: FormState, requireCommunity: boolean): FormErrors {
  const errors: FormErrors = {};

  if (requireCommunity && !state.community.trim()) {
    errors.community = 'Community string is required';
  }

  const timeout = parseInt(state.timeoutSeconds, 10);
  if (isNaN(timeout) || timeout < 1 || timeout > 60) {
    errors.timeoutSeconds = 'Timeout must be between 1 and 60 seconds';
  }

  const retries = parseInt(state.retries, 10);
  if (isNaN(retries) || retries < 0 || retries > 5) {
    errors.retries = 'Retries must be between 0 and 5';
  }

  return errors;
}

function isFormValid(state: FormState, errors: FormErrors, usingFallback: boolean): boolean {
  if (!state.scopeValid) return false;
  if (usingFallback && !state.community.trim()) return false;
  return Object.keys(errors).length === 0;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * DiscoveryTriggerForm allows a Network Operator to configure and submit
 * an SNMP discovery scan. The form is the entry point for the SNMP Discovery
 * tab workflow: Form → Status → Results.
 */
export function DiscoveryTriggerForm({ onRunCreated, initialScope }: DiscoveryTriggerFormProps) {
  const { addToast } = useToast();
  const [form, setForm] = useState<FormState>(buildInitialState(initialScope));
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);

  // Credential list state — loaded on mount.
  const [credentials, setCredentials]         = useState<CredentialSummary[]>([]);
  const [credentialsLoading, setCredLoading]  = useState(true);

  // ── Product definition context ────────────────────────────────────────────
  // Allows operators to select an uploaded product definition so its SNMP
  // fingerprints are shown as discovery context — the discovery service uses
  // these OIDs to classify discovered devices against the chosen definition.
  const [uploadedVersions, setUploadedVersions] = useState<ProductDefinitionVersion[]>([]);
  const [selectedVersionKey, setSelectedVersionKey] = useState<string>('');
  const [pdSchema, setPdSchema]   = useState<ProductDefinitionSchema | null>(null);
  const [pdLoading, setPdLoading] = useState(false);

  useEffect(() => {
    listAllUploadHistory()
      .then(setUploadedVersions)
      .catch(() => {/* non-fatal */});
  }, []);

  useEffect(() => {
    if (!selectedVersionKey) { setPdSchema(null); return; }
    const [definitionId, versionId] = selectedVersionKey.split('::');
    if (!definitionId || !versionId) { setPdSchema(null); return; }
    setPdLoading(true);
    getVersionSchema(definitionId, versionId)
      .then((schema) => {
        setPdSchema(schema);
        if (!schema) return;
        // Auto-configure SNMP protocol from the definition's protocols list
        // (vendor-independent: works for any uploaded definition)
        if (schema.protocols.some((p) => /SNMP_V1/i.test(p)) && !schema.protocols.some((p) => /SNMP_V2C?/i.test(p))) {
          setForm((prev) => ({ ...prev, protocol: 'SNMP_V1' }));
        } else if (schema.protocols.some((p) => /SNMP/i.test(p))) {
          setForm((prev) => ({ ...prev, protocol: 'SNMP_V2C' }));
        }
      })
      .catch(() => setPdSchema(null))
      .finally(() => setPdLoading(false));
  }, [selectedVersionKey]);

  // Build dropdown options for the product definition selector.
  const pdOptions = [
    { value: '', label: '— None (generic discovery) —' },
    ...uploadedVersions.map((v) => ({
      // Use versionId (UUID) not id (MongoDB ObjectId) — the API route expects the UUID
      value: `${v.definitionId}::${v.versionId}`,
      label: `${v.vendor ?? ''} ${v.model ?? v.name ?? ''} · v${v.registryVersion ?? v.versionId?.slice(-6)} [${v.lifecycleStatus}]`,
    })),
  ];

  useEffect(() => {
    listCredentials()
      .then((data) => {
        setCredentials(data);
        // Auto-select the first credential if any exist.
        if (data.length > 0) {
          setForm((prev) => ({ ...prev, credentialId: data[0].id }));
        }
      })
      .catch((err) => {
        // Non-fatal — fall back to community string input.
        logger.warn('DiscoveryTriggerForm: failed to load credentials', err);
      })
      .finally(() => setCredLoading(false));
  }, []);

  // Whether the user is using the fallback community string.
  const usingFallback =
    credentials.length === 0 || form.credentialId === FALLBACK_OPTION;

  const errors = validateForm(form, usingFallback);
  const formValid = isFormValid(form, errors, usingFallback);

  // ── Field handlers ──────────────────────────────────────────────────────────

  const handleScopeChange = useCallback((value: string, isValid: boolean) => {
    setForm((prev) => ({ ...prev, scope: value, scopeValid: isValid }));
  }, []);

  const handleField = useCallback(
    (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setTouched((prev) => ({ ...prev, [field]: true }));
    },
    [],
  );

  // ── Submission ──────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Mark all fields as touched to reveal any hidden validation errors.
      setTouched({ community: true, timeoutSeconds: true, retries: true });

      const currentErrors = validateForm(form, usingFallback);
      if (!isFormValid(form, currentErrors, usingFallback)) return;

      setSubmitting(true);
      // Extract productDefinitionId from the selected version key (definitionId::versionId)
      const selectedDefinitionId = selectedVersionKey
        ? selectedVersionKey.split('::')[0] || undefined
        : undefined;

      try {
        const response = await createDiscoveryRun({
          scope:          parseScopeInput(form.scope),
          protocol:       form.protocol,
          timeoutSeconds: parseInt(form.timeoutSeconds, 10),
          retries:        parseInt(form.retries, 10),
          // Prefer stored credential; fall back to direct community string.
          ...(usingFallback
            ? { community: form.community.trim() }
            : { credentialId: form.credentialId }),
          // Vendor-independent: tag all discovered devices with the selected definition
          ...(selectedDefinitionId ? { productDefinitionId: selectedDefinitionId } : {}),
          // ICMP bypass: skip ping, go straight to SNMP (for Docker/simulator targets)
          ...(form.icmpBypass ? { icmpBypass: true } : {}),
        });
        addToast(`Discovery run ${response.runId} created`, 'success');
        onRunCreated(response);
      } catch (err: unknown) {
        logger.error('DiscoveryTriggerForm: createDiscoveryRun failed', err);

        // Distinguish user-facing error messages by HTTP status.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 400) {
          addToast('Scope validation failed — check your IP ranges and try again.', 'error');
        } else if (status === 403) {
          addToast('You do not have permission to trigger discovery. Operator role required.', 'error');
        } else {
          addToast('Failed to start discovery run. Please try again.', 'error');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [form, usingFallback, credentials.length, onRunCreated, addToast],
  );

  // ── Build credential select options ─────────────────────────────────────────

  const credentialOptions = [
    ...credentials.map((c) => ({
      value: c.id,
      label: `${c.name} (SNMP${c.version})`,
    })),
    { value: FALLBACK_OPTION, label: '— Enter community string directly —' },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="SNMP Discovery configuration"
      noValidate
      style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}
    >
      {/* ── Product Definition Selector ──────────────────────────────────────
          Selecting a definition pre-loads its SNMP fingerprints so the
          discovery engine knows which OIDs identify this device model.
          This is optional — leaving it blank runs a generic discovery.   */}
      {uploadedVersions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <span style={{ fontSize: 18 }}>📂</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Product Definition Context
            </span>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em', display: 'block', marginBottom: 4 }}>
              Device Template
            </label>
            <select
              value={selectedVersionKey}
              onChange={(e) => setSelectedVersionKey(e.target.value)}
              style={{
                width: '100%', appearance: 'none',
                background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
                borderRadius: 'var(--vf-radius-md)', color: 'var(--vf-text-primary)',
                fontSize: 'var(--vf-type-body-size)', padding: '7px 10px',
                fontFamily: 'var(--vf-font-sans)', cursor: 'pointer', outline: 'none',
              }}
            >
              {pdOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 3, display: 'block' }}>
              Fingerprints from this definition will classify discovered devices
            </span>
          </div>
          {pdLoading && (
            <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading definition schema…</div>
          )}
          {pdSchema && !pdLoading && (
            <ProductDefinitionContextPanel schema={pdSchema} />
          )}
        </div>
      )}

      {/* Scope ─────────────────────────────────────────────────────────────── */}
      <ScopeInput
        value={form.scope}
        onChange={handleScopeChange}
        disabled={submitting}
      />

      {/* Protocol ──────────────────────────────────────────────────────────── */}
      <Select
        label="SNMP Protocol"
        options={PROTOCOL_OPTIONS}
        value={form.protocol}
        onChange={handleField('protocol')}
        disabled={submitting}
        fullWidth
      />

      {/* Credential selector (WO-027) ───────────────────────────────────────── */}
      {credentialsLoading ? (
        <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>
          Loading credentials…
        </div>
      ) : credentials.length > 0 ? (
        <Select
          label="SNMP Credential"
          options={credentialOptions}
          value={form.credentialId || FALLBACK_OPTION}
          onChange={handleField('credentialId')}
          disabled={submitting}
          fullWidth
        />
      ) : null}

      {/* Fallback community string — shown when no credentials or user chose direct entry */}
      {!credentialsLoading && usingFallback && (
        <Input
          label={
            credentials.length === 0
              ? 'Community String'
              : 'Community String (direct entry)'
          }
          type="password"
          autoComplete="off"
          placeholder="e.g. public"
          value={form.community}
          onChange={handleField('community')}
          onBlur={() => setTouched((prev) => ({ ...prev, community: true }))}
          error={touched.community ? errors.community : undefined}
          hint={
            credentials.length === 0
              ? 'No stored credentials found. Add credentials in the SNMP Credentials tab.'
              : 'Security: community is sent HTTPS-only and is never logged.'
          }
          disabled={submitting}
          fullWidth
        />
      )}

      {/* Timeout and retries ────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Input
          label="Timeout (seconds)"
          type="number"
          min={1}
          max={60}
          value={form.timeoutSeconds}
          onChange={handleField('timeoutSeconds')}
          onBlur={() => setTouched((prev) => ({ ...prev, timeoutSeconds: true }))}
          error={touched.timeoutSeconds ? errors.timeoutSeconds : undefined}
          disabled={submitting}
          fullWidth
        />
        <Input
          label="Retries"
          type="number"
          min={0}
          max={5}
          value={form.retries}
          onChange={handleField('retries')}
          onBlur={() => setTouched((prev) => ({ ...prev, retries: true }))}
          error={touched.retries ? errors.retries : undefined}
          hint="Auth failures are never retried"
          disabled={submitting}
          fullWidth
        />
      </div>

      {/* ICMP Bypass ───────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 14px', borderRadius: 8,
        background: form.icmpBypass ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${form.icmpBypass ? 'rgba(245,158,11,0.35)' : 'var(--vf-border-subtle)'}`,
        cursor: 'pointer',
      }} onClick={() => setForm((prev) => ({ ...prev, icmpBypass: !prev.icmpBypass }))}>
        <input
          type="checkbox"
          id="icmpBypass"
          checked={form.icmpBypass}
          onChange={(e) => setForm((prev) => ({ ...prev, icmpBypass: e.target.checked }))}
          onClick={(e) => e.stopPropagation()}
          style={{ marginTop: 2, cursor: 'pointer', accentColor: '#f59e0b' }}
        />
        <div>
          <label htmlFor="icmpBypass" style={{ fontSize: 13, fontWeight: 600, color: form.icmpBypass ? '#f59e0b' : 'var(--vf-text-primary)', cursor: 'pointer' }}>
            ⚡ Skip ICMP Ping (ICMP Bypass)
          </label>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--vf-text-muted)', lineHeight: 1.4 }}>
            {form.icmpBypass
              ? '✅ Enabled — gateway will probe SNMP directly without pinging. Required for Docker containers, simulators, and hosts that block ICMP.'
              : 'Enable when targeting Docker containers or simulators (host.docker.internal, explicit host:port) where ICMP ping is blocked.'}
          </p>
        </div>
      </div>

      {/* Submit ─────────────────────────────────────────────────────────────── */}
      <div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          disabled={!formValid || submitting}
        >
          {submitting ? 'Starting…' : form.icmpBypass ? '⚡ Start Discovery (ICMP Bypass)' : 'Start Discovery'}
        </Button>
      </div>
    </form>
  );
}

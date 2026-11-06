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
import { listDescriptors } from '../../../api/uiBuilder.api';
import type { UiDescriptorSummary } from '../../../api/uiBuilder.api';

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
  /** Optional one-off device web login (not stored) — lets discovery read the role from firmware whose SNMP agent hides it. */
  webUsername: string;
  webPassword: string;
  timeoutSeconds: string;
  retries: string;
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

// ── MIB Screen Builder preview panel ─────────────────────────────────────────
/**
 * Shows key metadata about a selected published MIB Builder screen so the
 * operator knows what Node View layout discovered devices will get.
 */
function MibScreenPreviewPanel({ descriptor }: { descriptor: UiDescriptorSummary }) {
  return (
    <div style={{
      background: 'rgba(34,197,94,0.06)',
      border: '1px solid rgba(34,197,94,0.2)',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>🖥️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--vf-text-primary)' }}>
            {descriptor.screenName}
          </div>
          {descriptor.deviceProfile && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
              {descriptor.deviceProfile}
            </div>
          )}
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: 'rgba(22,163,74,0.15)', color: '#16a34a',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>✓ Published</span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {descriptor.mibModule && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MIB Module</span>
            <code style={{ fontSize: 11, color: '#60a5fa', fontFamily: 'var(--vf-font-mono)' }}>{descriptor.mibModule}</code>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sections</span>
          <span style={{ fontSize: 12, color: 'var(--vf-text-primary)', fontWeight: 600 }}>{descriptor.sectionCount}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--vf-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MIB Objects</span>
          <span style={{ fontSize: 12, color: 'var(--vf-text-primary)', fontWeight: 600 }}>{descriptor.objectCount}</span>
        </div>
      </div>

      {/* Info callout */}
      <div style={{
        fontSize: 11, color: 'var(--vf-text-secondary)',
        background: 'rgba(255,255,255,0.03)', borderRadius: 6,
        padding: '6px 10px', borderLeft: '3px solid rgba(34,197,94,0.4)',
      }}>
        Discovered devices will use this Screen Builder layout as their Node View.
        All {descriptor.objectCount} MIB objects from this screen will be polled via SNMP.
      </div>
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
    webUsername:    '',
    webPassword:    '',
    timeoutSeconds: '5',
    retries:        '2',
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
  /** Toggle for the community string visibility — lets operators verify what they typed. */
  const [showCommunity, setShowCommunity] = useState(false);

  // Credential list state — loaded on mount.
  const [credentials, setCredentials]         = useState<CredentialSummary[]>([]);
  const [credentialsLoading, setCredLoading]  = useState(true);

  // ── Published MIB Screen Builder layouts ─────────────────────────────────
  // Loaded on mount so the operator can pick which MIB screen to associate
  // with devices discovered in this run. Devices are provisioned with
  // productDefinitionId = descriptorId so their Node View shows the custom
  // Screen Builder layout instead of a generic parameter panel.
  const [publishedScreens, setPublishedScreens] = useState<UiDescriptorSummary[]>([]);
  const [selectedDescriptorId, setSelectedDescriptorId] = useState<string>('');
  const [screensLoading, setScreensLoading] = useState(true);

  useEffect(() => {
    listDescriptors()
      .then((all) => setPublishedScreens(all.filter((d) => d.status === 'published')))
      .catch(() => {/* non-fatal */})
      .finally(() => setScreensLoading(false));
  }, []);

  const selectedScreen = publishedScreens.find((s) => s.descriptorId === selectedDescriptorId) ?? null;

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

      try {
        const response = await createDiscoveryRun({
          scope:          parseScopeInput(form.scope),
          protocol:       form.protocol,
          timeoutSeconds: parseInt(form.timeoutSeconds, 10),
          retries:        parseInt(form.retries, 10),
          // Prefer stored credential; fall back to direct community string.
          ...(usingFallback
            ? {
                community: form.community.trim(),
                ...(form.webUsername.trim() && form.webPassword
                  ? { webUsername: form.webUsername.trim(), webPassword: form.webPassword } : {}),
              }
            : { credentialId: form.credentialId }),
          // Tag all discovered devices with the selected MIB screen's descriptorId.
          // The gateway provisions devices with this as productDefinitionId so their
          // Node View renders the published Screen Builder layout.
          ...(selectedDescriptorId ? { productDefinitionId: selectedDescriptorId } : {}),
          // ICMP bypass is auto-detected by the gateway based on scope type:
          // hostname/host:port targets → SNMP-only (ICMP auto-bypassed)
          // IP/CIDR targets → full ICMP sweep + SNMP fingerprint (ICMP mandatory)
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
    [form, usingFallback, credentials.length, onRunCreated, addToast, selectedDescriptorId],
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
      {/* ── MIB Screen Builder Layout ─────────────────────────────────────────
          Selecting a published MIB screen ties all discovered + provisioned
          devices to that screen's Node View layout and SNMP OID poll list.
          This replaces the old "Product Definition XML" selector.          */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <span style={{ fontSize: 18 }}>🖥️</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--vf-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            MIB Screen Builder Layout
          </span>
        </div>
        {screensLoading ? (
          <div style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading published screens…</div>
        ) : (
          <>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--vf-text-secondary)', letterSpacing: '0.03em', display: 'block', marginBottom: 4 }}>
                MIB Parser / Screen
              </label>
              <select
                value={selectedDescriptorId}
                onChange={(e) => setSelectedDescriptorId(e.target.value)}
                style={{
                  width: '100%', appearance: 'none',
                  background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
                  borderRadius: 'var(--vf-radius-md)', color: 'var(--vf-text-primary)',
                  fontSize: 'var(--vf-type-body-size)', padding: '7px 10px',
                  fontFamily: 'var(--vf-font-sans)', cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="">— None (generic discovery) —</option>
                {publishedScreens.map((s) => (
                  <option key={s.descriptorId} value={s.descriptorId}>
                    {s.screenName}
                    {s.mibModule ? ` · ${s.mibModule}` : ''}
                    {s.deviceProfile ? ` · ${s.deviceProfile}` : ''}
                    {` (${s.sectionCount ?? 0} sections · ${s.objectCount ?? 0} objects)`}
                  </option>
                ))}
              </select>
              {publishedScreens.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 4, display: 'block' }}>
                  No published MIB screens yet — go to <strong>MIB Builder</strong> to create and publish one.
                </span>
              )}
              {!selectedDescriptorId && publishedScreens.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 3, display: 'block' }}>
                  Provisioned devices will use the selected screen for their Node View layout
                </span>
              )}
            </div>
            {selectedScreen && <MibScreenPreviewPanel descriptor={selectedScreen} />}
          </>
        )}
      </div>

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

      {/* Optional device web login for a direct community run (stored credentials carry their own) */}
      {!credentialsLoading && usingFallback && (
        <div style={{ display: 'flex', gap: 12, width: '100%' }}>
          <input
            aria-label="Device web username (optional)"
            placeholder="Device web username (optional)"
            autoComplete="off"
            value={form.webUsername}
            onChange={handleField('webUsername')}
            disabled={submitting}
            style={{ flex: 1, background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)', borderRadius: 'var(--vf-radius-md)', color: 'var(--vf-text-primary)', padding: '7px 10px' }}
          />
          <input
            aria-label="Device web password (optional)"
            placeholder="Device web password (optional)"
            type="password"
            autoComplete="new-password"
            value={form.webPassword}
            onChange={handleField('webPassword')}
            disabled={submitting}
            style={{ flex: 1, background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)', borderRadius: 'var(--vf-radius-md)', color: 'var(--vf-text-primary)', padding: '7px 10px' }}
          />
        </div>
      )}

      {/* Fallback community string — shown when no credentials or user chose direct entry */}
      {!credentialsLoading && usingFallback && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
          <label
            htmlFor="vf-input-community-string"
            style={{
              fontSize: 'var(--vf-type-caption-size)',
              fontWeight: 600,
              color: 'var(--vf-text-secondary)',
              letterSpacing: '0.03em',
            }}
          >
            {credentials.length === 0 ? 'Community String' : 'Community String (direct entry)'}
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="vf-input-community-string"
              type={showCommunity ? 'text' : 'password'}
              autoComplete="off"
              placeholder="e.g. public"
              value={form.community}
              onChange={handleField('community')}
              onBlur={() => setTouched((prev) => ({ ...prev, community: true }))}
              disabled={submitting}
              aria-invalid={!!(touched.community && errors.community)}
              style={{
                width: '100%',
                background: 'var(--vf-input-bg)',
                border: `1px solid ${touched.community && errors.community ? 'var(--vf-danger)' : 'var(--vf-border-default)'}`,
                borderRadius: 'var(--vf-radius-md)',
                color: 'var(--vf-text-primary)',
                fontSize: 'var(--vf-type-body-size)',
                lineHeight: 'var(--vf-type-body-line)',
                padding: '7px 38px 7px 10px',
                fontFamily: 'var(--vf-font-sans)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {/* Eye toggle — lets operators verify the value they typed */}
            <button
              type="button"
              onClick={() => setShowCommunity((v) => !v)}
              disabled={submitting}
              aria-label={showCommunity ? 'Hide community string' : 'Show community string'}
              title={showCommunity ? 'Hide' : 'Show'}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: submitting ? 'not-allowed' : 'pointer',
                color: showCommunity ? 'var(--vf-primary)' : 'var(--vf-text-muted)',
                padding: '2px 4px',
                display: 'flex',
                alignItems: 'center',
                lineHeight: 1,
                fontSize: 16,
                opacity: submitting ? 0.5 : 1,
                transition: 'color 0.15s',
              }}
            >
              {showCommunity ? (
                /* Eye-off SVG */
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                /* Eye SVG */
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          </div>
          {touched.community && errors.community && (
            <span role="alert" style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-danger)' }}>
              {errors.community}
            </span>
          )}
          {!(touched.community && errors.community) && (
            <span style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)' }}>
              {credentials.length === 0
                ? 'No stored credentials found. Add credentials in the SNMP Credentials tab.'
                : 'Security: community is sent HTTPS-only and is never logged.'}
            </span>
          )}
        </div>
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

      {/* Submit ─────────────────────────────────────────────────────────────── */}
      <div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          disabled={!formValid || submitting}
        >
          {submitting ? 'Starting…' : 'Start Discovery'}
        </Button>
      </div>
    </form>
  );
}

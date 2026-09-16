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

function buildInitialState(initialScope?: string): FormState {
  return {
    scope:          initialScope ?? '',
    scopeValid:     !!initialScope,
    protocol:       'SNMP_V2C',
    credentialId:   '',
    community:      'public',
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

  // Credential list state — loaded on mount.
  const [credentials, setCredentials]         = useState<CredentialSummary[]>([]);
  const [credentialsLoading, setCredLoading]  = useState(true);

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
            ? { community: form.community.trim() }
            : { credentialId: form.credentialId }),
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

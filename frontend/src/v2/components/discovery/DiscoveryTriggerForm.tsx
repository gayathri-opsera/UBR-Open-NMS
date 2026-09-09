/**
 * DiscoveryTriggerForm — initiates an SNMP discovery scan.
 *
 * Renders scope input, SNMP protocol selector, community string (masked),
 * timeout, and retries fields. Validates client-side before calling the API.
 * Notifies parent via `onRunCreated` callback on success.
 *
 * Security: community strings are NEVER logged or stored beyond the form state.
 * They are sent over HTTPS in the request body and are masked in the UI.
 */
import { useState, useCallback } from 'react';

import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { ScopeInput } from './ScopeInput';
import { createDiscoveryRun, parseScopeInput } from '../../../api/discovery.api';
import type { SnmpProtocol } from '../../../api/discovery.api';
import { logger } from '../../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryTriggerFormProps {
  /**
   * Called when a discovery run is successfully created.
   * @param runId The UUID of the new discovery run.
   */
  onRunCreated: (runId: string) => void;
}

interface FormState {
  scope: string;
  scopeValid: boolean;
  protocol: SnmpProtocol;
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

const INITIAL_STATE: FormState = {
  scope:          '',
  scopeValid:     false,
  protocol:       'SNMP_V2C',
  community:      'public',
  timeoutSeconds: '5',
  retries:        '2',
};

// ── Validation ────────────────────────────────────────────────────────────────

function validateForm(state: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!state.community.trim()) {
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

function isFormValid(state: FormState, errors: FormErrors): boolean {
  return (
    state.scopeValid &&
    Object.keys(errors).length === 0
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * DiscoveryTriggerForm allows a Network Operator to configure and submit
 * an SNMP discovery scan. The form is the entry point for the SNMP Discovery
 * tab workflow: Form → Status → Results.
 */
export function DiscoveryTriggerForm({ onRunCreated }: DiscoveryTriggerFormProps) {
  const { addToast } = useToast();
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);

  const errors = validateForm(form);
  const formValid = isFormValid(form, errors);

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

      const currentErrors = validateForm(form);
      if (!isFormValid(form, currentErrors)) return;

      setSubmitting(true);
      try {
        const response = await createDiscoveryRun({
          scope:          parseScopeInput(form.scope),
          protocol:       form.protocol,
          // Security: community is not logged; it is sent HTTPS-only.
          community:      form.community.trim(),
          timeoutSeconds: parseInt(form.timeoutSeconds, 10),
          retries:        parseInt(form.retries, 10),
        });
        addToast(`Discovery run ${response.runId} created`, 'success');
        onRunCreated(response.runId);
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
    [form, onRunCreated, addToast],
  );

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

      {/* Community string ───────────────────────────────────────────────────── */}
      <Input
        label="Community String"
        type="password"
        autoComplete="off"
        placeholder="e.g. public"
        value={form.community}
        onChange={handleField('community')}
        onBlur={() => setTouched((prev) => ({ ...prev, community: true }))}
        error={touched.community ? errors.community : undefined}
        hint="SNMPv2c read-only community string. Will be replaced by credential selection in a future release."
        disabled={submitting}
        fullWidth
      />

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

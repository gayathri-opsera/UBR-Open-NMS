/**
 * CredentialManager — full CRUD UI for SNMP credentials.
 *
 * Renders a table of existing credentials (redacted) with Add, Edit, Delete
 * actions. Create and Edit operations use a modal form. Delete uses an inline
 * confirmation pattern to avoid accidental data loss.
 *
 * Security notes:
 * - Sensitive fields (community, authKey, privKey) are input-only (type="password").
 * - The API never returns plaintext sensitive fields; the table shows only metadata.
 * - Admin role is required for Create, Update, Delete (enforced server-side);
 *   the UI hints at this restriction but does not gate rendering.
 */
import { useEffect, useState, useCallback } from 'react';

import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { EmptyState, LoadingState } from '../common/States';
import { useToast } from '../common/Toast';
import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
} from '../../../api/credentials.api';
import type {
  CredentialSummary,
  CreateCredentialRequest,
  SNMPVersion,
  SNMPv3SecurityLevel,
  SNMPv3AuthProtocol,
  SNMPv3PrivacyProtocol,
} from '../../../api/credentials.api';
import { logger } from '../../utils/logger';

// ── Form state ────────────────────────────────────────────────────────────────

interface CredentialFormState {
  name: string;
  description: string;
  version: SNMPVersion;
  // v1 / v2c fields
  community: string;
  // v3 fields
  securityName: string;
  securityLevel: SNMPv3SecurityLevel;
  authProtocol: SNMPv3AuthProtocol;
  authKey: string;
  privProtocol: SNMPv3PrivacyProtocol;
  privKey: string;
}

const INITIAL_FORM: CredentialFormState = {
  name:          '',
  description:   '',
  version:       'V2C',
  community:     '',
  securityName:  '',
  securityLevel: 'NO_AUTH_NO_PRIV',
  authProtocol:  'SHA',
  authKey:       '',
  privProtocol:  'AES',
  privKey:       '',
};

// ── Options ───────────────────────────────────────────────────────────────────

const VERSION_OPTIONS = [
  { value: 'V2C', label: 'SNMPv2c (recommended)' },
  { value: 'V1',  label: 'SNMPv1' },
  { value: 'V3',  label: 'SNMPv3' },
];

const SECURITY_LEVEL_OPTIONS = [
  { value: 'NO_AUTH_NO_PRIV', label: 'No Auth / No Privacy' },
  { value: 'AUTH_NO_PRIV',    label: 'Auth only (no Privacy)' },
  { value: 'AUTH_PRIV',       label: 'Auth + Privacy' },
];

const AUTH_PROTOCOL_OPTIONS = [
  { value: 'SHA',    label: 'SHA (recommended)' },
  { value: 'SHA256', label: 'SHA-256' },
  { value: 'MD5',    label: 'MD5 (legacy)' },
];

const PRIV_PROTOCOL_OPTIONS = [
  { value: 'AES', label: 'AES (recommended)' },
  { value: 'DES', label: 'DES (legacy)' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map SNMP version to a display badge style. */
function versionVariant(v: SNMPVersion): 'default' | 'warning' | 'success' {
  if (v === 'V3') return 'success';
  if (v === 'V1') return 'warning';
  return 'default';
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Build a CreateCredentialRequest from form state. */
function buildRequest(form: CredentialFormState): CreateCredentialRequest {
  const base = {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    version: form.version,
  };

  if (form.version === 'V3') {
    return {
      ...base,
      securityName:  form.securityName.trim(),
      securityLevel: form.securityLevel,
      ...(form.securityLevel !== 'NO_AUTH_NO_PRIV' && {
        authProtocol: form.authProtocol,
        authKey:      form.authKey,
      }),
      ...(form.securityLevel === 'AUTH_PRIV' && {
        privProtocol: form.privProtocol,
        privKey:      form.privKey,
      }),
    };
  }

  return { ...base, community: form.community };
}

/** Validate the form and return error messages (empty = valid). */
function validateForm(form: CredentialFormState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!form.name.trim()) {
    errors.name = 'Name is required';
  }

  if (form.version !== 'V3' && !form.community.trim()) {
    errors.community = 'Community string is required for SNMPv1/v2c';
  }

  if (form.version === 'V3') {
    if (!form.securityName.trim()) {
      errors.securityName = 'Security name is required for SNMPv3';
    }
    if (form.securityLevel !== 'NO_AUTH_NO_PRIV' && !form.authKey.trim()) {
      errors.authKey = 'Auth key is required for the selected security level';
    }
    if (form.securityLevel === 'AUTH_PRIV' && !form.privKey.trim()) {
      errors.privKey = 'Privacy key is required for AUTH_PRIV security level';
    }
  }

  return errors;
}

// ── Credential form modal ─────────────────────────────────────────────────────

interface CredentialFormModalProps {
  title: string;
  initial: CredentialFormState;
  submitting: boolean;
  onSubmit: (form: CredentialFormState) => void;
  onClose: () => void;
}

function CredentialFormModal({
  title,
  initial,
  submitting,
  onSubmit,
  onClose,
}: CredentialFormModalProps) {
  const [form, setForm]     = useState<CredentialFormState>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof CredentialFormState, boolean>>>({});

  const errors      = validateForm(form);
  const hasErrors   = Object.keys(errors).length > 0;

  function field(key: keyof CredentialFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      setTouched((prev) => ({ ...prev, [key]: true }));
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Mark all fields touched to reveal errors.
    const all: Partial<Record<keyof CredentialFormState, boolean>> = {};
    (Object.keys(form) as (keyof CredentialFormState)[]).forEach((k) => { all[k] = true; });
    setTouched(all);
    if (hasErrors) return;
    onSubmit(form);
  }

  const showAuthFields = form.version === 'V3' && form.securityLevel !== 'NO_AUTH_NO_PRIV';
  const showPrivFields = form.version === 'V3' && form.securityLevel === 'AUTH_PRIV';

  return (
    <Modal open title={title} onClose={onClose} size="md">
      <form
        onSubmit={handleSubmit}
        aria-label={title}
        noValidate
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {/* Name */}
        <Input
          label="Credential name *"
          value={form.name}
          onChange={field('name')}
          onBlur={() => setTouched((p) => ({ ...p, name: true }))}
          error={touched.name ? errors.name : undefined}
          placeholder="e.g. Prod-v2c-Default"
          disabled={submitting}
        />

        {/* Description */}
        <Input
          label="Description"
          value={form.description}
          onChange={field('description')}
          placeholder="Optional — free-text notes"
          disabled={submitting}
        />

        {/* SNMP version */}
        <Select
          label="SNMP version *"
          options={VERSION_OPTIONS}
          value={form.version}
          onChange={field('version')}
          disabled={submitting}
          fullWidth
        />

        {/* v1 / v2c: community */}
        {form.version !== 'V3' && (
          <Input
            label="Community string *"
            type="password"
            autoComplete="new-password"
            value={form.community}
            onChange={field('community')}
            onBlur={() => setTouched((p) => ({ ...p, community: true }))}
            error={touched.community ? errors.community : undefined}
            placeholder="e.g. public"
            disabled={submitting}
          />
        )}

        {/* v3: security name */}
        {form.version === 'V3' && (
          <Input
            label="Security name *"
            value={form.securityName}
            onChange={field('securityName')}
            onBlur={() => setTouched((p) => ({ ...p, securityName: true }))}
            error={touched.securityName ? errors.securityName : undefined}
            placeholder="e.g. snmp-admin"
            disabled={submitting}
          />
        )}

        {/* v3: security level */}
        {form.version === 'V3' && (
          <Select
            label="Security level *"
            options={SECURITY_LEVEL_OPTIONS}
            value={form.securityLevel}
            onChange={field('securityLevel')}
            disabled={submitting}
            fullWidth
          />
        )}

        {/* v3 auth fields */}
        {showAuthFields && (
          <>
            <Select
              label="Auth protocol *"
              options={AUTH_PROTOCOL_OPTIONS}
              value={form.authProtocol}
              onChange={field('authProtocol')}
              disabled={submitting}
              fullWidth
            />
            <Input
              label="Auth key *"
              type="password"
              autoComplete="new-password"
              value={form.authKey}
              onChange={field('authKey')}
              onBlur={() => setTouched((p) => ({ ...p, authKey: true }))}
              error={touched.authKey ? errors.authKey : undefined}
              placeholder="Min 8 characters"
              disabled={submitting}
            />
          </>
        )}

        {/* v3 privacy fields */}
        {showPrivFields && (
          <>
            <Select
              label="Privacy protocol *"
              options={PRIV_PROTOCOL_OPTIONS}
              value={form.privProtocol}
              onChange={field('privProtocol')}
              disabled={submitting}
              fullWidth
            />
            <Input
              label="Privacy key *"
              type="password"
              autoComplete="new-password"
              value={form.privKey}
              onChange={field('privKey')}
              onBlur={() => setTouched((p) => ({ ...p, privKey: true }))}
              error={touched.privKey ? errors.privKey : undefined}
              placeholder="Min 8 characters"
              disabled={submitting}
            />
          </>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * CredentialManager renders the full lifecycle for SNMP credential records:
 * list → create → edit → delete. Requires Admin role for mutations.
 */
export function CredentialManager() {
  const { addToast } = useToast();

  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  // Modal state
  const [modalMode, setModalMode]   = useState<'create' | 'edit' | null>(null);
  const [editTarget, setEditTarget] = useState<CredentialSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Inline delete confirmation
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // credential ID

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadCredentials = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCredentials();
      setCredentials(data ?? []);
    } catch (err: unknown) {
      logger.error('CredentialManager: listCredentials failed', err);
      setError('Failed to load credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCredentials(); }, [loadCredentials]);

  // ── Create ──────────────────────────────────────────────────────────────────

  async function handleCreate(form: CredentialFormState) {
    setSubmitting(true);
    try {
      await createCredential(buildRequest(form));
      addToast(`Credential "${form.name}" created`, 'success');
      setModalMode(null);
      await loadCredentials();
    } catch (err: unknown) {
      logger.error('CredentialManager: createCredential failed', err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        addToast(`A credential named "${form.name}" already exists.`, 'error');
      } else if (status === 403) {
        addToast('Admin role required to create credentials.', 'error');
      } else {
        addToast('Failed to create credential. Please try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  async function handleUpdate(form: CredentialFormState) {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      await updateCredential(editTarget.id, buildRequest(form));
      addToast(`Credential "${form.name}" updated`, 'success');
      setModalMode(null);
      setEditTarget(null);
      await loadCredentials();
    } catch (err: unknown) {
      logger.error('CredentialManager: updateCredential failed', err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        addToast('Admin role required to update credentials.', 'error');
      } else if (status === 404) {
        addToast('Credential not found. It may have been deleted.', 'error');
      } else {
        addToast('Failed to update credential. Please try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(credentialId: string) {
    setConfirmDelete(null);
    try {
      await deleteCredential(credentialId);
      addToast('Credential deleted', 'success');
      await loadCredentials();
    } catch (err: unknown) {
      logger.error('CredentialManager: deleteCredential failed', err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        addToast('Admin role required to delete credentials.', 'error');
      } else {
        addToast('Failed to delete credential. Please try again.', 'error');
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>SNMP Credentials</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--vf-text-muted)' }}>
            Securely store SNMP community strings and v3 credentials. Sensitive fields are
            encrypted at rest (AES-256-GCM). Admin role required for mutations.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { setEditTarget(null); setModalMode('create'); }}
          style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
        >
          + Add Credential
        </Button>
      </div>

      {/* Error banner */}
      {error && !loading && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            fontSize: 13, color: '#f87171',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span>⚠️</span>
          <span style={{ flex: 1 }}>{error}</span>
          <Button variant="ghost" size="sm" onClick={loadCredentials}>Retry</Button>
        </div>
      )}

      {/* Loading */}
      {loading && <LoadingState label="Loading credentials…" />}

      {/* Empty */}
      {!loading && !error && credentials.length === 0 && (
        <EmptyState
          icon="🔑"
          title="No credentials configured"
          description="Add SNMP community strings or v3 credentials to use in discovery runs."
        />
      )}

      {/* Credentials table */}
      {!loading && credentials.length > 0 && (
        <div role="table" aria-label="SNMP credentials" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Name', 'Version', 'Security Level', 'Created', 'Updated', 'Actions'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      padding: '8px 12px',
                      textAlign: 'left',
                      fontWeight: 600,
                      fontSize: 11,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'var(--vf-text-muted)',
                      borderBottom: '1px solid var(--vf-border-subtle)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {credentials.map((cred, idx) => (
                <tr
                  key={cred.id}
                  style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}
                >
                  {/* Name + description */}
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600 }}>{cred.name}</div>
                    {cred.description && (
                      <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>
                        {cred.description}
                      </div>
                    )}
                  </td>

                  {/* Version */}
                  <td style={{ padding: '10px 12px' }}>
                    <Badge variant={versionVariant(cred.version)}>
                      SNMP{cred.version}
                    </Badge>
                  </td>

                  {/* Security level (v3 only) */}
                  <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--vf-text-muted)' }}>
                    {cred.securityLevel ?? '—'}
                  </td>

                  {/* Created */}
                  <td style={{ padding: '10px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {formatDate(cred.createdAt)}
                  </td>

                  {/* Updated */}
                  <td style={{ padding: '10px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {formatDate(cred.updatedAt)}
                  </td>

                  {/* Actions */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    {confirmDelete === cred.id ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                        <span style={{ color: '#f87171' }}>Delete?</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(cred.id)}
                          aria-label={`Confirm delete ${cred.name}`}
                        >
                          Yes
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(null)}
                          aria-label="Cancel delete"
                        >
                          No
                        </Button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditTarget(cred);
                            setModalMode('edit');
                          }}
                          aria-label={`Edit ${cred.name}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(cred.id)}
                          aria-label={`Delete ${cred.name}`}
                          style={{ color: '#f87171' }}
                        >
                          Delete
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {modalMode === 'create' && (
        <CredentialFormModal
          title="Add SNMP Credential"
          initial={INITIAL_FORM}
          submitting={submitting}
          onSubmit={handleCreate}
          onClose={() => setModalMode(null)}
        />
      )}

      {/* Edit modal */}
      {modalMode === 'edit' && editTarget && (
        <CredentialFormModal
          title={`Edit: ${editTarget.name}`}
          initial={{
            ...INITIAL_FORM,
            name:          editTarget.name,
            description:   editTarget.description ?? '',
            version:       editTarget.version,
            securityLevel: editTarget.securityLevel ?? 'NO_AUTH_NO_PRIV',
            authProtocol:  editTarget.authProtocol  ?? 'SHA',
            privProtocol:  editTarget.privProtocol  ?? 'AES',
            securityName:  editTarget.securityName  ?? '',
            // Sensitive fields are empty — user must re-enter to rotate.
            community:     '',
            authKey:       '',
            privKey:       '',
          }}
          submitting={submitting}
          onSubmit={handleUpdate}
          onClose={() => { setModalMode(null); setEditTarget(null); }}
        />
      )}
    </div>
  );
}

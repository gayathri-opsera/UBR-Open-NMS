/**
 * V2SecurityAuditPage — Security, API, and Audit Settings
 *
 * Displays zero-trust controls, northbound API contracts, RBAC role mappings,
 * credential vault status, and immutable audit evidence for the framework release.
 *
 * All controls reflect framework policy — write operations require Admin role.
 * Credential material is never rendered in any state per the framework spec.
 *
 * Design: two-column card grid with stat-style displays and a full-width
 * audit evidence section at the bottom.
 */
import React, { useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RbacRow {
  frameworkRole: string;
  existingRole: string;
  keyPermissions: string;
}

// ── Static data (reflects the NMS framework RBAC spec) ────────────────────────

const RBAC_ROWS: RbacRow[] = [
  { frameworkRole: 'ReadOnly',   existingRole: 'viewer',   keyPermissions: 'parameter.read' },
  { frameworkRole: 'Operator',   existingRole: 'operator', keyPermissions: 'discovery.run, alarm.ack' },
  { frameworkRole: 'Admin',      existingRole: 'admin',    keyPermissions: 'productdef.stage, vault.reference' },
  { frameworkRole: 'SuperAdmin', existingRole: 'ADMIN',    keyPermissions: 'productdef.activate, rollback' },
];

const API_CONTRACTS = [
  '/api/framework/v1',
  '/api/framework/v2-beta',
];

// ── Toggle control ────────────────────────────────────────────────────────────

function PolicyToggle({
  label,
  enabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 0', borderBottom: '1px solid var(--vf-border-subtle)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--vf-text-primary)' }}>{label}</span>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => onChange?.(!enabled)}
        style={{
          width: 44, height: 24, borderRadius: 12,
          background: enabled ? 'var(--vf-success)' : 'var(--vf-elevated)',
          border: '1px solid',
          borderColor: enabled ? 'var(--vf-success)' : 'var(--vf-border-subtle)',
          cursor: onChange ? 'pointer' : 'default',
          position: 'relative',
          transition: 'background 0.2s, border-color 0.2s',
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 2,
            left: enabled ? 22 : 2,
            width: 18, height: 18,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.2s',
          }}
        />
      </button>
    </div>
  );
}

// ── Token pill ────────────────────────────────────────────────────────────────

function TokenPill({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600,
      padding: '3px 10px', borderRadius: 'var(--vf-radius-full)',
      background: 'var(--vf-accent-subtle)', color: 'var(--vf-accent)',
      border: '1px solid var(--vf-accent)',
    }}>
      {children}
    </span>
  );
}

// ── Vault pill ────────────────────────────────────────────────────────────────

function VaultPill({ children, variant }: { children: React.ReactNode; variant: 'success' | 'info' | 'neutral' }) {
  const c = {
    success: { bg: 'var(--vf-success-subtle)', text: 'var(--vf-success)', border: 'var(--vf-success)' },
    info:    { bg: 'var(--vf-accent-subtle)',   text: 'var(--vf-accent)',  border: 'var(--vf-accent)' },
    neutral: { bg: 'var(--vf-elevated)',         text: 'var(--vf-text-secondary)', border: 'var(--vf-border-subtle)' },
  }[variant];

  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600,
      padding: '3px 10px', borderRadius: 'var(--vf-radius-full)',
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {children}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function V2SecurityAuditPage() {
  const [activeContract, setActiveContract] = useState(API_CONTRACTS[0]);
  const [contractOpen, setContractOpen]     = useState(false);

  // Zero-trust controls — reflected read-only for P0 (Admin can toggle in a future release).
  const [controls] = useState({
    eastWestMtls:              true,
    serviceIdentityAuthz:      true,
    uploadMalwareScan:         true,
    legacyWriteWorkflows:      true,
  });

  return (
    <div
      role="main"
      aria-label="Security, API, and Audit Settings"
      style={{ padding: '32px 28px 40px' }}
    >
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)', margin: 0 }}>
          Security, API, and Audit Settings
        </h1>
        <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: '6px 0 0' }}>
          Zero-trust controls, northbound contracts, RBAC mapping, and immutable evidence for the framework release.
        </p>
      </div>

      {/* ── Two-column card grid ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 20, marginBottom: 20 }}>

        {/* Framework API contracts */}
        <section aria-labelledby="api-contracts-title" style={CARD_STYLE}>
          <h2 id="api-contracts-title" style={CARD_TITLE}>Framework API contracts</h2>

          <label
            htmlFor="api-contract-select"
            style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)', marginBottom: 6 }}
          >
            Active contract
          </label>

          {/* Contract select */}
          <div style={{ position: 'relative', marginBottom: 14 }}>
            <button
              id="api-contract-select"
              aria-haspopup="listbox"
              aria-expanded={contractOpen}
              onClick={() => setContractOpen((o) => !o)}
              style={{
                width: '100%', padding: '8px 12px', textAlign: 'left',
                borderRadius: 'var(--vf-radius-md)', border: '1px solid var(--vf-border-subtle)',
                background: 'var(--vf-elevated)', color: 'var(--vf-text-primary)',
                cursor: 'pointer', fontSize: 13, fontFamily: 'var(--vf-font-mono)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              {activeContract}
              <span aria-hidden style={{ color: 'var(--vf-text-muted)' }}>▾</span>
            </button>
            {contractOpen && (
              <div role="listbox" style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, marginTop: 4,
                background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
                borderRadius: 'var(--vf-radius-md)', boxShadow: 'var(--vf-shadow-popover)',
                overflow: 'hidden',
              }}>
                {API_CONTRACTS.map((c) => (
                  <button
                    key={c}
                    role="option"
                    aria-selected={c === activeContract}
                    onClick={() => { setActiveContract(c); setContractOpen(false); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 14px', background: c === activeContract ? 'var(--vf-accent-subtle)' : 'transparent',
                      border: 'none', cursor: 'pointer', fontSize: 13,
                      color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)',
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Token pills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <TokenPill>JWT RS256</TokenPill>
            <TokenPill>15 min access token</TokenPill>
            <TokenPill>8 hour refresh token</TokenPill>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={BTN_PRIMARY}>Open OpenAPI preview</button>
            <button style={BTN_SECONDARY}>Send test request</button>
          </div>
        </section>

        {/* Zero-trust controls */}
        <section aria-labelledby="zero-trust-title" style={CARD_STYLE}>
          <h2 id="zero-trust-title" style={CARD_TITLE}>Zero-trust controls</h2>
          <div>
            <PolicyToggle label="East-west mTLS required"         enabled={controls.eastWestMtls} />
            <PolicyToggle label="Service identity authorization"   enabled={controls.serviceIdentityAuthz} />
            <PolicyToggle label="Upload malware scan"             enabled={controls.uploadMalwareScan} />
            <PolicyToggle label="Legacy write workflows disabled"  enabled={controls.legacyWriteWorkflows} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--vf-text-muted)', margin: '12px 0 0' }}>
            Control changes require SuperAdmin role. All changes are written to the immutable audit log.
          </p>
        </section>

        {/* RBAC role mapping */}
        <section aria-labelledby="rbac-title" style={CARD_STYLE}>
          <h2 id="rbac-title" style={CARD_TITLE}>RBAC role mapping</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {(['Framework role', 'Existing role', 'Key permissions'] as const).map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{
                      padding: '8px 12px', textAlign: 'left',
                      fontSize: 11, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.06em',
                      color: 'var(--vf-text-muted)',
                      borderBottom: '2px solid var(--vf-border-subtle)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RBAC_ROWS.map((row) => (
                <tr
                  key={row.frameworkRole}
                  style={{ borderBottom: '1px solid var(--vf-border-subtle)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vf-elevated)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                >
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{row.frameworkRole}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12 }}>{row.existingRole}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--vf-font-mono)', fontSize: 12, color: 'var(--vf-text-secondary)' }}>{row.keyPermissions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Credential vault */}
        <section aria-labelledby="vault-title" style={CARD_STYLE}>
          <h2 id="vault-title" style={CARD_TITLE}>Credential vault</h2>
          <p style={{ fontSize: 13, color: 'var(--vf-text-primary)', margin: '0 0 16px', lineHeight: 1.5 }}>
            No Product Definition file, API response, audit payload, log, or UI state may expose credential material.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <VaultPill variant="info">AES-256-GCM</VaultPill>
            <VaultPill variant="success">rotation policy ready</VaultPill>
            <VaultPill variant="neutral">SNMPv2c isolated L2</VaultPill>
          </div>
          <button style={BTN_SECONDARY}>Verify vault references</button>
        </section>
      </div>

      {/* ── Immutable audit evidence ───────────────────────────────────────── */}
      <section aria-labelledby="audit-title" style={{ ...CARD_STYLE, marginTop: 4 }}>
        <h2 id="audit-title" style={CARD_TITLE}>Immutable audit evidence</h2>
        <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '0 0 16px' }}>
          All Product Definition lifecycle events, RBAC changes, and vault reference updates are written to an append-only audit log. Records cannot be deleted or modified.
        </p>
        <div
          role="log"
          aria-label="Audit evidence log"
          style={{
            background: 'var(--vf-elevated)', borderRadius: 'var(--vf-radius-md)',
            border: '1px solid var(--vf-border-subtle)',
            padding: '12px 16px', fontSize: 12, fontFamily: 'var(--vf-font-mono)',
            color: 'var(--vf-text-secondary)', minHeight: 80,
          }}
        >
          <div style={{ color: 'var(--vf-text-muted)', fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Yesterday</div>
          <div style={{ borderBottom: '1px solid var(--vf-border-subtle)', paddingBottom: 6, marginBottom: 6 }}>
            <span style={{ color: 'var(--vf-text-muted)' }}>2026-09-16 14:23:01 UTC</span>
            {'  '}
            <span style={{ color: 'var(--vf-success)' }}>ACTIVATED</span>
            {'  '}VendorA-BTS-X200:1.0.4 by admin@ubrnms — idempotency: act-001
          </div>
          <div style={{ borderBottom: '1px solid var(--vf-border-subtle)', paddingBottom: 6, marginBottom: 6 }}>
            <span style={{ color: 'var(--vf-text-muted)' }}>2026-09-16 11:05:44 UTC</span>
            {'  '}
            <span style={{ color: 'var(--vf-warning)' }}>STAGED</span>
            {'    '}VendorB-CPE-G100:1.0.0 by operator@ubrnms
          </div>
          <div>
            <span style={{ color: 'var(--vf-text-muted)' }}>2026-09-16 09:14:22 UTC</span>
            {'  '}
            <span style={{ color: 'var(--vf-accent)' }}>VALIDATED</span>
            {'  '}VendorC-Switch-S500:0.9.8 — 3 warnings (stale threshold omitted)
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Style constants ───────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border-subtle)',
  borderRadius: 'var(--vf-radius-lg)',
  padding: '24px',
  boxShadow: 'var(--vf-shadow-card)',
};

const CARD_TITLE: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--vf-text-primary)',
  margin: '0 0 16px',
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 'var(--vf-radius-md)',
  border: 'none',
  background: 'var(--vf-accent)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const BTN_SECONDARY: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 'var(--vf-radius-md)',
  border: '1px solid var(--vf-border-subtle)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text-primary)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

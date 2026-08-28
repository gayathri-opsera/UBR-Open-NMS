import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getMfaStatus,
  setupMfa,
  verifyMfaSetup,
  disableMfa,
  type MfaStatus,
  type MfaSetupResult,
} from '../../api/auth.api';

// ── Tiny OTP digit input ──────────────────────────────────────────────────────
function OtpInput({
  value, onChange, label,
}: { value: string; onChange: (v: string) => void; label: string }) {
  const refs = Array.from({ length: 6 }, () => useRef<HTMLInputElement>(null));
  const digits = (value + '      ').split('').slice(0, 6);

  const handleKey = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      onChange((value.slice(0, idx) + value.slice(idx + 1)).slice(0, 6));
      if (idx > 0) refs[idx - 1].current?.focus();
    } else if (/^\d$/.test(e.key)) {
      const next = (value.slice(0, idx) + e.key + value.slice(idx + 1)).slice(0, 6);
      onChange(next);
      if (idx < 5) refs[idx + 1].current?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const p = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    onChange(p);
    refs[Math.min(p.length, 5)].current?.focus();
  };

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vf-text-secondary)', marginBottom: 10 }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {refs.map((ref, i) => (
          <input
            key={i} ref={ref} type="text" inputMode="numeric" maxLength={1}
            value={digits[i].trim()}
            onChange={() => {/* handled in onKeyDown */}}
            onKeyDown={(e) => handleKey(i, e)}
            onPaste={handlePaste}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#1967D2'; e.currentTarget.style.background = '#f0f4ff'; e.currentTarget.select(); }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--vf-border-default)'; e.currentTarget.style.background = digits[i].trim() ? '#f0f4ff' : 'var(--vf-surface)'; }}
            style={{
              width: 44, height: 52, textAlign: 'center', fontSize: 20, fontWeight: 700,
              border: '2px solid var(--vf-border-default)', borderRadius: 8, outline: 'none',
              color: 'var(--vf-text-primary)', background: digits[i].trim() ? '#f0f4ff' : 'var(--vf-surface)',
              transition: 'border-color 0.15s, background 0.15s', cursor: 'text',
              fontFamily: 'var(--vf-font-mono, monospace)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
      background: enabled ? '#dcfce7' : '#fef2f2',
      color: enabled ? '#166534' : '#dc2626',
      border: `1px solid ${enabled ? '#86efac' : '#fecaca'}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: enabled ? '#22c55e' : '#ef4444', display: 'inline-block' }} />
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepIndicator({ step, current }: { step: number; current: number }) {
  const done = current > step;
  const active = current === step;
  return (
    <div style={{
      width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      background: done ? '#22c55e' : active ? '#1967D2' : 'var(--vf-surface)',
      border: `2px solid ${done ? '#22c55e' : active ? '#1967D2' : 'var(--vf-border-default)'}`,
      color: done || active ? '#fff' : 'var(--vf-text-muted)',
      fontSize: 12, fontWeight: 700,
    }}>
      {done ? '✓' : step}
    </div>
  );
}

// ── Alert box ─────────────────────────────────────────────────────────────────
function Alert({ type, children }: { type: 'error' | 'success' | 'info'; children: React.ReactNode }) {
  const styles = {
    error:   { bg: '#fef2f2', border: '#fecaca', color: '#dc2626', icon: '✕' },
    success: { bg: '#f0fdf4', border: '#86efac', color: '#166534', icon: '✓' },
    info:    { bg: '#f0f4ff', border: '#c7d2fe', color: '#1b3270', icon: 'ℹ' },
  }[type];
  return (
    <div style={{
      background: styles.bg, border: `1px solid ${styles.border}`, borderRadius: 8,
      padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <span style={{ color: styles.color, fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{styles.icon}</span>
      <span style={{ color: styles.color, fontSize: 13, lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

// ── Main MFA Panel ────────────────────────────────────────────────────────────
type PanelStep = 'status' | 'scan' | 'verify' | 'done' | 'disable-confirm';

export default function V2ProfilePage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<PanelStep>('status');
  const [setup, setSetup] = useState<MfaSetupResult | null>(null);
  const [otp, setOtp] = useState('');
  const [disableOtp, setDisableOtp] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getMfaStatus();
      setStatus(s);
    } catch {
      setStatus({ mfaEnabled: false, mfaEnabledAt: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // ── Start MFA setup ──────────────────────────────────────────────────────────
  const handleStartSetup = async () => {
    setError('');
    setSubmitting(true);
    try {
      const result = await setupMfa();
      setSetup(result);
      setOtp('');
      setStep('scan');
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || 'Failed to generate QR code');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Verify OTP and activate ──────────────────────────────────────────────────
  const handleVerify = async () => {
    setError('');
    setSubmitting(true);
    try {
      await verifyMfaSetup(otp);
      await loadStatus();
      setStep('done');
      setSuccess('MFA has been enabled. Your account is now protected with two-factor authentication.');
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || 'Invalid code. Please try again.');
      setOtp('');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Disable MFA ──────────────────────────────────────────────────────────────
  const handleDisable = async () => {
    setError('');
    setSubmitting(true);
    try {
      await disableMfa(disableOtp);
      await loadStatus();
      setStep('status');
      setDisableOtp('');
      setSuccess('MFA has been disabled.');
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || 'Invalid code. Please try again.');
      setDisableOtp('');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => { setStep('status'); setOtp(''); setDisableOtp(''); setError(''); setSetup(null); setSuccess(''); };

  // ── Card wrapper ─────────────────────────────────────────────────────────────
  const Card = ({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={{
      background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-default)',
      borderRadius: 12, padding: '24px 28px', ...style,
    }}>
      {children}
    </div>
  );

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--vf-text-primary)', margin: '0 0 4px' }}>
      {children}
    </h3>
  );

  const SectionSub = ({ children }: { children: React.ReactNode }) => (
    <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: '0 0 20px', lineHeight: 1.5 }}>
      {children}
    </p>
  );

  const PrimaryBtn = ({ children, onClick, disabled = false, danger = false }: {
    children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? '#93c5fd' : danger ? '#dc2626' : '#1967D2',
      border: 'none', borderRadius: 7, color: '#fff', fontSize: 13, fontWeight: 600,
      padding: '10px 20px', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background 0.15s',
    }}>
      {children}
    </button>
  );

  const GhostBtn = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick} style={{
      background: 'transparent', border: '1px solid var(--vf-border-default)',
      borderRadius: 7, color: 'var(--vf-text-secondary)', fontSize: 13, fontWeight: 500,
      padding: '10px 20px', cursor: 'pointer',
    }}>
      {children}
    </button>
  );

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 24px' }}>
      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--vf-text-primary)', margin: '0 0 6px' }}>
          Security Settings
        </h1>
        <p style={{ fontSize: 14, color: 'var(--vf-text-muted)', margin: 0, lineHeight: 1.5 }}>
          Manage two-factor authentication and account security for <strong>{user?.username}</strong>
        </p>
      </div>

      {/* Success toast */}
      {success && (
        <div style={{ marginBottom: 20 }}>
          <Alert type="success">{success}</Alert>
        </div>
      )}

      {/* ── MFA Status Card ─────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: status?.mfaEnabled ? '#f0fdf4' : '#fef2f2',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <svg viewBox="0 0 20 20" width={18} height={18} fill="none"
                  stroke={status?.mfaEnabled ? '#22c55e' : '#ef4444'} strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 2L3 5v5c0 4.418 3.134 7.814 7 8.938C13.866 17.814 17 14.418 17 10V5l-7-3z"/>
                  {status?.mfaEnabled && <polyline points="7 10 9 12 13 8" stroke="#22c55e"/>}
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
                  Two-Factor Authentication
                </div>
                {status?.mfaEnabled && status.mfaEnabledAt && (
                  <div style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>
                    Enabled {new Date(status.mfaEnabledAt).toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>
            <p style={{ fontSize: 13, color: 'var(--vf-text-muted)', margin: 0, lineHeight: 1.5 }}>
              {status?.mfaEnabled
                ? 'Your account is secured with TOTP two-factor authentication. Each login requires your authenticator app.'
                : 'Add an extra layer of security. Once enabled, logging in requires both your password and a code from your authenticator app.'}
            </p>
          </div>
          <div style={{ flexShrink: 0, paddingTop: 4 }}>
            {loading ? (
              <span style={{ fontSize: 12, color: 'var(--vf-text-muted)' }}>Loading…</span>
            ) : (
              <StatusBadge enabled={status?.mfaEnabled ?? false} />
            )}
          </div>
        </div>
      </Card>

      {/* ── Setup Flow Card ─────────────────────────────────────────────────── */}
      {!loading && !status?.mfaEnabled && step !== 'done' && (
        <Card style={{ marginBottom: 16 }}>

          {/* Step progress bar */}
          {step !== 'status' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
              {[1, 2, 3].map((s, i) => (
                <React.Fragment key={s}>
                  <StepIndicator step={s} current={step === 'scan' ? 1 : step === 'verify' ? 2 : 3} />
                  {i < 2 && (
                    <div style={{ flex: 1, height: 2, background: (step === 'scan' ? 1 : step === 'verify' ? 2 : 3) > s ? '#22c55e' : 'var(--vf-border-default)', borderRadius: 2 }} />
                  )}
                </React.Fragment>
              ))}
              <div style={{ fontSize: 12, color: 'var(--vf-text-muted)', marginLeft: 8 }}>
                {step === 'scan' ? 'Step 1 of 3 — Scan QR Code' : step === 'verify' ? 'Step 2 of 3 — Enter Code' : 'Step 3 — Done'}
              </div>
            </div>
          )}

          {/* ── Step: status (not enabled, start) ────────────────────────── */}
          {step === 'status' && (
            <>
              <SectionTitle>Enable Two-Factor Authentication</SectionTitle>
              <SectionSub>
                Works with Google Authenticator, Authy, 1Password, Microsoft Authenticator, and any TOTP app.
                Setup takes 30 seconds.
              </SectionSub>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                {['📱 Google Authenticator', '🔒 Authy', '🔑 1Password', '🛡️ Microsoft Authenticator'].map(app => (
                  <span key={app} style={{
                    background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)',
                    borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--vf-text-secondary)',
                  }}>{app}</span>
                ))}
              </div>
              {error && <div style={{ marginBottom: 12 }}><Alert type="error">{error}</Alert></div>}
              <PrimaryBtn onClick={handleStartSetup} disabled={submitting}>
                {submitting ? 'Generating QR code…' : '🔐 Enable MFA — Get QR Code'}
              </PrimaryBtn>
            </>
          )}

          {/* ── Step: scan QR ────────────────────────────────────────────── */}
          {step === 'scan' && setup && (
            <>
              <SectionTitle>Scan this QR Code</SectionTitle>
              <SectionSub>
                Open your authenticator app, tap <strong>+</strong> → <strong>Scan QR code</strong>, then point your camera at the code below.
              </SectionSub>

              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 24 }}>
                {/* QR code */}
                <div style={{ flexShrink: 0 }}>
                  <div style={{ border: '3px solid var(--vf-border-default)', borderRadius: 12, padding: 10, background: '#fff', display: 'inline-block' }}>
                    <img src={setup.qrCodeDataUrl} alt="TOTP QR Code" style={{ display: 'block', width: 180, height: 180, borderRadius: 6 }} />
                  </div>
                </div>

                {/* Manual key */}
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ background: 'var(--vf-surface)', border: '1px solid var(--vf-border-default)', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--vf-text-muted)', marginBottom: 8 }}>
                      Can't scan? Enter this key manually
                    </div>
                    <div style={{
                      fontFamily: 'var(--vf-font-mono, monospace)', fontSize: 15, fontWeight: 700,
                      color: '#1967D2', letterSpacing: 3, wordBreak: 'break-all', lineHeight: 1.6,
                    }}>
                      {setup.manualEntryKey}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 8 }}>
                      Type: Time-based (TOTP) · Period: 30s · Digits: 6
                    </div>
                  </div>
                  <Alert type="info">
                    After scanning, look for <strong>UBR-NMS:{user?.username}</strong> in your app with a 6-digit code that refreshes every 30 seconds.
                  </Alert>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <PrimaryBtn onClick={() => { setStep('verify'); setOtp(''); setError(''); }} disabled={false}>
                  I've scanned it — Enter Code →
                </PrimaryBtn>
                <GhostBtn onClick={reset}>Cancel</GhostBtn>
              </div>
            </>
          )}

          {/* ── Step: verify OTP ─────────────────────────────────────────── */}
          {step === 'verify' && (
            <>
              <SectionTitle>Enter the 6-Digit Code</SectionTitle>
              <SectionSub>
                Open your authenticator app and enter the current code for <strong>UBR-NMS:{user?.username}</strong>.
                The code refreshes every 30 seconds.
              </SectionSub>

              <div style={{ marginBottom: 20 }}>
                <OtpInput value={otp} onChange={setOtp} label="Authenticator code" />
              </div>

              {error && <div style={{ marginBottom: 16 }}><Alert type="error">{error}</Alert></div>}

              <div style={{ display: 'flex', gap: 10 }}>
                <PrimaryBtn onClick={handleVerify} disabled={otp.length !== 6 || submitting}>
                  {submitting ? 'Verifying…' : 'Verify & Enable MFA'}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setStep('scan'); setError(''); }}>← Back</GhostBtn>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── MFA Enabled — success card ─────────────────────────────────────── */}
      {step === 'done' && (
        <Card style={{ marginBottom: 16, borderColor: '#86efac', background: '#f0fdf4' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg viewBox="0 0 20 20" width={22} height={22} fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 10 8 14 16 6"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#166534', marginBottom: 6 }}>
                MFA is now active on your account
              </div>
              <p style={{ margin: 0, fontSize: 13, color: '#166534', lineHeight: 1.5 }}>
                Your next login will show the Two-Factor Authentication screen. Enter your authenticator code to sign in.
                Works on local <strong>and</strong> the deployed version — same app entry, same codes.
              </p>
              <div style={{ marginTop: 12 }}>
                <GhostBtn onClick={reset}>← Back to Security Settings</GhostBtn>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── Disable MFA Card (shown when MFA is enabled) ───────────────────── */}
      {!loading && status?.mfaEnabled && (
        <Card style={{ borderColor: step === 'disable-confirm' ? '#fecaca' : 'var(--vf-border-default)' }}>
          {step !== 'disable-confirm' ? (
            <>
              <SectionTitle>Disable Two-Factor Authentication</SectionTitle>
              <SectionSub>
                This will remove MFA from your account. You'll need your current authenticator code to confirm.
                Only do this if you're switching apps or enrolled on a new device.
              </SectionSub>
              <button
                onClick={() => { setStep('disable-confirm'); setError(''); setDisableOtp(''); }}
                style={{
                  background: 'transparent', border: '1px solid #fecaca', borderRadius: 7,
                  color: '#dc2626', fontSize: 13, fontWeight: 600, padding: '9px 18px', cursor: 'pointer',
                }}
              >
                Disable MFA
              </button>
            </>
          ) : (
            <>
              <SectionTitle>⚠️ Confirm Disable MFA</SectionTitle>
              <SectionSub>
                Enter the current 6-digit code from your authenticator app to disable MFA.
                This action takes effect immediately.
              </SectionSub>

              <div style={{ marginBottom: 20 }}>
                <OtpInput value={disableOtp} onChange={setDisableOtp} label="Current authenticator code" />
              </div>

              {error && <div style={{ marginBottom: 16 }}><Alert type="error">{error}</Alert></div>}

              <div style={{ display: 'flex', gap: 10 }}>
                <PrimaryBtn onClick={handleDisable} disabled={disableOtp.length !== 6 || submitting} danger>
                  {submitting ? 'Disabling…' : 'Disable MFA'}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setStep('status'); setError(''); setDisableOtp(''); }}>Cancel</GhostBtn>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── Info card ─────────────────────────────────────────────────── */}
      <div style={{ marginTop: 24, padding: '16px 20px', background: 'var(--vf-surface)', border: '1px solid var(--vf-border-subtle)', borderRadius: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--vf-text-secondary)', marginBottom: 8 }}>
          ℹ️ How TOTP MFA works
        </div>
        <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, color: 'var(--vf-text-muted)', lineHeight: 1.8 }}>
          <li>Your authenticator app generates a new 6-digit code every 30 seconds using a shared secret</li>
          <li>The same app entry works on <strong>both local and deployed</strong> environments — no re-enrollment needed</li>
          <li>If you lose access to your authenticator, contact an admin to reset your MFA</li>
          <li>Supported apps: Google Authenticator, Authy, 1Password, Microsoft Authenticator, Bitwarden</li>
        </ul>
      </div>
    </div>
  );
}

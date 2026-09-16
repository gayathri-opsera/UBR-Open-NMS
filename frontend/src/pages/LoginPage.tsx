import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// ── Inline styles reused across steps ────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: '#fff', border: '1px solid #dde1e7',
  borderRadius: 6, color: '#1a1a2e', fontSize: 14,
  boxSizing: 'border-box', marginBottom: 16, outline: 'none',
  transition: 'border-color 0.15s',
};
const focusBorder = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = '#1967D2'; };
const blurBorder  = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = '#dde1e7'; };

// ── OTP digit input ───────────────────────────────────────────────────────────
function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = [
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
  ];

  const digits = value.padEnd(6, ' ').split('').slice(0, 6);

  const handleKey = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      const next = value.slice(0, idx) + value.slice(idx + 1);
      onChange(next.slice(0, 6));
      if (idx > 0) refs[idx - 1].current?.focus();
    } else if (/^\d$/.test(e.key)) {
      const next = (value.slice(0, idx) + e.key + value.slice(idx + 1)).slice(0, 6);
      onChange(next);
      if (idx < 5) refs[idx + 1].current?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    onChange(pasted);
    const focusIdx = Math.min(pasted.length, 5);
    refs[focusIdx].current?.focus();
  };

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
      {refs.map((ref, i) => (
        <input
          key={i}
          ref={ref}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digits[i].trim()}
          onChange={() => {/* handled in onKeyDown */}}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#1967D2'; e.currentTarget.select(); }}
          onBlur={(e) => { e.currentTarget.style.borderColor = '#dde1e7'; }}
          style={{
            width: 44, height: 52, textAlign: 'center', fontSize: 22, fontWeight: 700,
            border: '2px solid #dde1e7', borderRadius: 8, outline: 'none',
            color: '#1b3270', background: digits[i].trim() ? '#f0f4ff' : '#fff',
            transition: 'border-color 0.15s, background 0.15s',
          }}
        />
      ))}
    </div>
  );
}

// ── Countdown timer for MFA token expiry ──────────────────────────────────────
function Countdown({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    const t = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const color = remaining < 60 ? '#dc2626' : '#718096';
  return (
    <span style={{ color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

// ── Senao / UBR Logo ──────────────────────────────────────────────────────────
function Logo() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
      <svg viewBox="0 0 48 48" width={56} height={56}>
        <rect x="1" y="1" width="46" height="46" rx="12" fill="#1253a4"/>
        <path d="M15 20 C15 15.5 18 13 22.5 13 C27 13 29 15.5 29 18.5 C29 22 26.5 23.5 23.5 24.5 C20.5 25.5 18 27.5 18 30.5 C18 33 20 35 24 35.5 L32 35.5"
          stroke="white" strokeWidth="3" strokeLinecap="round" fill="none"/>
        <circle cx="24" cy="35.5" r="2" fill="white"/>
      </svg>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1b3270 0%, #1e4a9e 50%, #1253a4 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#ffffff', borderRadius: 12, padding: '40px 44px',
        width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.30)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Step 1: Username + Password ───────────────────────────────────────────────
function CredentialsStep() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/v2/dashboard';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      // If MFA is NOT required, login() sets the user → navigate
      // If MFA IS required, mfaChallenge is set → parent switches to OTP step automatically
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { message?: string }; message?: string } }; message?: string };
      setError(
        axiosErr?.response?.data?.error?.message ||
        axiosErr?.response?.data?.message ||
        axiosErr?.message ||
        'Invalid username or password',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Logo />
      <h1 style={{ color: '#1b3270', marginBottom: 4, fontSize: 22, fontWeight: 700, textAlign: 'center' }}>
        UBR NMS
      </h1>
      <p style={{ color: '#718096', marginBottom: 28, fontSize: 13, textAlign: 'center' }}>
        Network Management System
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="nms-username" style={{ display: 'block', color: '#4a5568', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
          Username
        </label>
        <input
          id="nms-username" name="username" value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username" required
          style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
        />

        <label htmlFor="nms-password" style={{ display: 'block', color: '#4a5568', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
          Password
        </label>
        <input
          id="nms-password" name="password" type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password" required
          style={{ ...inputStyle, marginBottom: error ? 8 : 20 }}
          onFocus={focusBorder} onBlur={blurBorder}
        />

        {error && (
          <p role="alert" style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password}
          style={{
            width: '100%', padding: '11px',
            background: loading || !username || !password ? '#93c5fd' : '#1967D2',
            border: 'none', borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 600,
            cursor: loading || !username || !password ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </Card>
  );
}

// ── Step 2: OTP Input ─────────────────────────────────────────────────────────
function MfaStep() {
  const { mfaChallenge, completeMfaChallenge, cancelMfaChallenge } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/v2/dashboard';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!mfaChallenge) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setError('');
    setLoading(true);
    try {
      await completeMfaChallenge(code);
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setError(
        axiosErr?.response?.data?.error?.message ||
        axiosErr?.message ||
        'Invalid OTP code. Please try again.',
      );
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Logo />

      {/* Shield icon */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'linear-gradient(135deg, #1967D2, #1253a4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <polyline points="9 12 11 14 15 10"/>
          </svg>
        </div>
      </div>

      <h1 style={{ color: '#1b3270', marginBottom: 6, fontSize: 20, fontWeight: 700, textAlign: 'center' }}>
        Two-Factor Authentication
      </h1>
      <p style={{ color: '#718096', marginBottom: 8, fontSize: 13, textAlign: 'center', lineHeight: 1.5 }}>
        Open your authenticator app and enter the<br/>
        6-digit code for <strong style={{ color: '#1b3270' }}>UBR-NMS</strong>
      </p>

      {/* Countdown */}
      <div style={{ textAlign: 'center', marginBottom: 24, fontSize: 13, color: '#718096' }}>
        Code expires in&nbsp;
        <Countdown seconds={mfaChallenge.mfaTokenExpiresIn} />
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <OtpInput value={code} onChange={setCode} />

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 6, padding: '10px 14px', marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <svg viewBox="0 0 20 20" width={16} height={16} fill="#dc2626">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
            </svg>
            <span style={{ fontSize: 13, color: '#dc2626' }}>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          style={{
            width: '100%', padding: '11px',
            background: loading || code.length !== 6 ? '#93c5fd' : '#1967D2',
            border: 'none', borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 600,
            cursor: loading || code.length !== 6 ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s', marginBottom: 12,
          }}
        >
          {loading ? 'Verifying…' : 'Verify Code'}
        </button>

        <button
          type="button"
          onClick={cancelMfaChallenge}
          style={{
            width: '100%', padding: '10px',
            background: 'transparent', border: '1px solid #dde1e7',
            borderRadius: 6, color: '#4a5568', fontSize: 13, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          ← Back to Login
        </button>
      </form>

      {/* Help text */}
      <div style={{
        marginTop: 20, padding: '12px 14px', background: '#f0f4ff',
        borderRadius: 8, fontSize: 12, color: '#4a5568', lineHeight: 1.6,
      }}>
        <strong style={{ color: '#1b3270' }}>Using Google Authenticator or Authy?</strong><br/>
        Find the <em>UBR-NMS</em> entry in your app and enter the current 6-digit code.
        Codes refresh every 30 seconds.
      </div>
    </Card>
  );
}

// ── Main export — switches between Step 1 and Step 2 ─────────────────────────
export function LoginPage(): React.ReactElement {
  const { mfaChallenge } = useAuth();
  return mfaChallenge ? <MfaStep /> : <CredentialsStep />;
}

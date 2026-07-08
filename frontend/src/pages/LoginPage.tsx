import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function LoginPage(): React.ReactElement {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/dashboard';

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
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { message?: string }; message?: string } }; message?: string };
      const msg =
        axiosErr?.response?.data?.error?.message ||
        axiosErr?.response?.data?.message ||
        axiosErr?.message ||
        'Invalid username or password';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1b3270 0%, #1e4a9e 50%, #1253a4 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Card */}
      <div style={{
        background: '#ffffff',
        borderRadius: 12, padding: '40px 44px',
        width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.30)',
      }}>
        {/* Senao Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <svg viewBox="0 0 48 48" width={56} height={56}>
            <rect x="1" y="1" width="46" height="46" rx="12" fill="#1253a4"/>
            <path d="M15 20 C15 15.5 18 13 22.5 13 C27 13 29 15.5 29 18.5 C29 22 26.5 23.5 23.5 24.5 C20.5 25.5 18 27.5 18 30.5 C18 33 20 35 24 35.5 L32 35.5"
              stroke="white" strokeWidth="3" strokeLinecap="round" fill="none"/>
            <circle cx="24" cy="35.5" r="2" fill="white"/>
          </svg>
        </div>

        <h1 style={{ color: '#1b3270', marginBottom: 4, fontSize: 22, fontWeight: 700, textAlign: 'center', letterSpacing: '-0.3px' }}>
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
            id="nms-username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            style={{
              width: '100%', padding: '10px 12px',
              background: '#fff', border: '1px solid #dde1e7',
              borderRadius: 6, color: '#1a1a2e', fontSize: 14,
              boxSizing: 'border-box', marginBottom: 16, outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = '#1967D2')}
            onBlur={(e) => (e.currentTarget.style.borderColor = '#dde1e7')}
          />

          <label htmlFor="nms-password" style={{ display: 'block', color: '#4a5568', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
            Password
          </label>
          <input
            id="nms-password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{
              width: '100%', padding: '10px 12px',
              background: '#fff', border: '1px solid #dde1e7',
              borderRadius: 6, color: '#1a1a2e', fontSize: 14,
              boxSizing: 'border-box', marginBottom: error ? 8 : 20, outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = '#1967D2')}
            onBlur={(e) => (e.currentTarget.style.borderColor = '#dde1e7')}
          />

          {error && (
            <p role="alert" style={{ color: '#dc2626', fontSize: 13, marginBottom: 16, marginTop: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            style={{
              width: '100%', padding: '11px',
              background: loading || !username || !password ? '#93c5fd' : '#1967D2',
              border: 'none', borderRadius: 6, color: '#fff', fontSize: 14,
              fontWeight: 600,
              cursor: loading || !username || !password ? 'not-allowed' : 'pointer',
              letterSpacing: '0.02em',
              transition: 'background 0.15s',
            }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ color: '#a0aec0', fontSize: 12, marginTop: 20, textAlign: 'center' }}>
          Default: <span style={{ color: '#1967D2', fontWeight: 600 }}>admin</span> / Admin@NMS2024!
        </p>
      </div>
    </div>
  );
}

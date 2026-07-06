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
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#0a1628',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#0d1b2a', border: '1px solid #1e3a5f',
        borderRadius: 12, padding: 40, width: 360,
      }}>
        <h1 style={{ color: '#60a5fa', marginBottom: 8, fontSize: 22, fontWeight: 700 }}>UBR NMS</h1>
        <p style={{ color: '#64748b', marginBottom: 32, fontSize: 14 }}>Network Management System</p>
        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', color: '#94a3b8', fontSize: 13, marginBottom: 6 }}>
            Username
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            style={{
              width: '100%', padding: '10px 12px', background: '#0f172a',
              border: '1px solid #1e3a5f', borderRadius: 6, color: '#e2e8f0',
              fontSize: 14, boxSizing: 'border-box', marginBottom: 16,
            }}
          />
          <label style={{ display: 'block', color: '#94a3b8', fontSize: 13, marginBottom: 6 }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{
              width: '100%', padding: '10px 12px', background: '#0f172a',
              border: '1px solid #1e3a5f', borderRadius: 6, color: '#e2e8f0',
              fontSize: 14, boxSizing: 'border-box', marginBottom: 8,
            }}
          />
          {error && (
            <p style={{ color: '#f87171', fontSize: 13, marginBottom: 8 }}>{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '11px', background: loading ? '#1e3a5f' : '#2563eb',
              border: 'none', borderRadius: 6, color: '#fff', fontSize: 14,
              fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', marginTop: 8,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

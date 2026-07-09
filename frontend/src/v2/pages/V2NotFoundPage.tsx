import React from 'react';
import { Link } from 'react-router-dom';

export default function V2NotFoundPage() {
  return (
    <div className="vf-page vf-flex-center" style={{ minHeight: '60vh' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 64, fontWeight: 700, color: 'var(--vf-text-dim)', marginBottom: 8 }}>404</div>
        <p style={{ color: 'var(--vf-text-muted)', marginBottom: 20 }}>Page not found.</p>
        <Link
          to="/v2/dashboard"
          style={{
            padding: '8px 20px',
            background: 'var(--vf-accent)',
            color: '#fff',
            borderRadius: 'var(--vf-radius-md)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}

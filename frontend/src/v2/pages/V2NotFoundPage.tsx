import { useNavigate } from 'react-router-dom';
import { Button } from '../components/common/Button';

export default function V2NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="vf-page" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 64, lineHeight: 1, color: 'var(--vf-text-dim)', fontWeight: 900 }}>404</div>
        <h2 style={{ margin: 0, fontSize: 'var(--vf-type-h2-size)', color: 'var(--vf-text-primary)' }}>Page not found</h2>
        <p style={{ color: 'var(--vf-text-muted)', fontSize: 14, maxWidth: 360 }}>
          The page you are looking for does not exist or has been moved.
        </p>
        <Button variant="primary" onClick={() => navigate('/v2/dashboard')}>Go to Dashboard</Button>
      </div>
    </div>
  );
}

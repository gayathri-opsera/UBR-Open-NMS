import React from 'react';

export interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: number;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  icon?: React.ReactNode;
  loading?: boolean;
  onClick?: () => void;
}

const variantColor: Record<NonNullable<MetricCardProps['variant']>, string> = {
  default: 'var(--vf-text-primary)',
  success: 'var(--vf-success)',
  warning: 'var(--vf-warning)',
  danger:  'var(--vf-danger)',
  accent:  'var(--vf-accent)',
};

export function MetricCard({ label, value, unit, trend, variant = 'default', icon, loading = false, onClick }: MetricCardProps) {
  const color = variantColor[variant];

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      style={{
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow var(--vf-transition-fast), transform var(--vf-transition-fast)',
        boxShadow: 'var(--vf-shadow-low)',
      }}
      onMouseEnter={(e) => { if (onClick) { (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--vf-shadow-medium)'; (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)'; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--vf-shadow-low)'; (e.currentTarget as HTMLDivElement).style.transform = ''; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vf-text-muted)' }}>
          {label}
        </span>
        {icon && <span style={{ color: 'var(--vf-text-muted)', display: 'flex' }}>{icon}</span>}
      </div>

      {loading ? (
        <div style={{ height: 32, background: 'var(--vf-elevated)', borderRadius: 4, animation: 'vf-skeleton-shimmer 1.4s ease-in-out infinite', backgroundSize: '200% 100%' }} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>
            {value}
          </span>
          {unit && <span style={{ fontSize: 13, color: 'var(--vf-text-muted)' }}>{unit}</span>}
        </div>
      )}

      {trend !== undefined && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: trend >= 0 ? 'var(--vf-success)' : 'var(--vf-danger)', fontWeight: 600 }}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
          <span style={{ fontSize: 11, color: 'var(--vf-text-dim)' }}>vs last period</span>
        </div>
      )}
    </div>
  );
}

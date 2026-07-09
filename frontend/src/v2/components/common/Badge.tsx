import React from 'react';

export type BadgeVariant =
  | 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
  | 'critical' | 'major' | 'minor' | 'clear'
  | 'online' | 'offline' | 'degraded' | 'unknown';

export interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

const variantMap: Record<BadgeVariant, { color: string; bg: string }> = {
  default:  { color: 'var(--vf-text-secondary)', bg: 'var(--vf-elevated)' },
  accent:   { color: 'var(--vf-accent)',          bg: 'var(--vf-accent-subtle)' },
  success:  { color: 'var(--vf-success)',          bg: 'var(--vf-success-subtle)' },
  warning:  { color: 'var(--vf-warning)',          bg: 'var(--vf-warning-subtle)' },
  danger:   { color: 'var(--vf-danger)',            bg: 'var(--vf-danger-subtle)' },
  info:     { color: 'var(--vf-info)',              bg: 'var(--vf-info-subtle)' },
  critical: { color: 'var(--vf-sev-critical)',      bg: 'var(--vf-sev-critical-bg)' },
  major:    { color: 'var(--vf-sev-major)',          bg: 'var(--vf-sev-major-bg)' },
  minor:    { color: 'var(--vf-sev-minor)',          bg: 'var(--vf-sev-minor-bg)' },
  clear:    { color: 'var(--vf-sev-clear)',          bg: 'var(--vf-sev-clear-bg)' },
  online:   { color: 'var(--vf-status-online)',      bg: 'var(--vf-success-subtle)' },
  offline:  { color: 'var(--vf-status-offline)',     bg: 'var(--vf-danger-subtle)' },
  degraded: { color: 'var(--vf-status-degraded)',    bg: 'var(--vf-warning-subtle)' },
  unknown:  { color: 'var(--vf-status-unknown)',     bg: 'var(--vf-elevated)' },
};

export function Badge({ variant = 'default', dot = false, children, style, className }: BadgeProps) {
  const { color, bg } = variantMap[variant];

  return (
    <span
      role="status"
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dot ? 5 : 0,
        padding: '2px 8px',
        borderRadius: 'var(--vf-radius-full)',
        fontSize: 'var(--vf-type-caption-size)',
        fontWeight: 600,
        lineHeight: 'var(--vf-type-caption-line)',
        letterSpacing: '0.02em',
        color,
        background: bg,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </span>
  );
}

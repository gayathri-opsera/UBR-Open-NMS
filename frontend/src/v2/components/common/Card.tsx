import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  title?: string;
  titleRight?: React.ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  elevated?: boolean;
  style?: React.CSSProperties;
  className?: string;
  onClick?: () => void;
}

const paddingMap = { none: 0, sm: 12, md: 16, lg: 24 };

export function Card({ children, title, titleRight, padding = 'md', elevated = false, style, className, onClick }: CardProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      style={{
        background: elevated ? 'var(--vf-elevated)' : 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)',
        boxShadow: elevated ? 'var(--vf-shadow-medium)' : 'var(--vf-shadow-low)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : undefined,
        transition: onClick ? `box-shadow var(--vf-transition-fast)` : undefined,
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `10px ${paddingMap[padding]}px`,
            borderBottom: '1px solid var(--vf-border-subtle)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--vf-type-h4-size)',
              fontWeight: 'var(--vf-type-h4-weight)' as React.CSSProperties['fontWeight'],
              color: 'var(--vf-text-primary)',
              letterSpacing: 'var(--vf-type-h4-tracking)',
            }}
          >
            {title}
          </span>
          {titleRight && <div>{titleRight}</div>}
        </div>
      )}
      <div style={{ padding: paddingMap[padding] }}>{children}</div>
    </div>
  );
}

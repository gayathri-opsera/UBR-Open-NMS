import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--vf-accent)',
    color: '#fff',
    border: '1px solid var(--vf-accent)',
  },
  secondary: {
    background: 'var(--vf-accent-bg)',
    color: 'var(--vf-accent)',
    border: '1px solid var(--vf-border-default)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--vf-text-primary)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'var(--vf-danger-bg)',
    color: 'var(--vf-danger)',
    border: '1px solid var(--vf-danger)',
  },
  warning: {
    background: 'rgba(245,158,11,0.12)',
    color: '#f59e0b',
    border: '1px solid rgba(245,158,11,0.4)',
  },
  success: {
    background: 'rgba(34,197,94,0.12)',
    color: '#22c55e',
    border: '1px solid rgba(34,197,94,0.4)',
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { fontSize: 'var(--vf-type-caption-size)', padding: '4px 10px', borderRadius: 'var(--vf-radius-sm)', height: 28 },
  md: { fontSize: 'var(--vf-type-body-size)', padding: '6px 14px', borderRadius: 'var(--vf-radius-md)', height: 34 },
  lg: { fontSize: 'var(--vf-type-h4-size)', padding: '9px 20px', borderRadius: 'var(--vf-radius-md)', height: 42 },
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, iconLeft, iconRight, fullWidth = false, children, disabled, style, ...props }, ref) => {
    const isDisabled = disabled || loading;

    const base: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      fontFamily: 'var(--vf-font-sans)',
      fontWeight: 600,
      lineHeight: 1,
      cursor: isDisabled ? 'not-allowed' : 'pointer',
      opacity: isDisabled ? 0.5 : 1,
      transition: `background var(--vf-transition-fast), opacity var(--vf-transition-fast), box-shadow var(--vf-transition-fast)`,
      width: fullWidth ? '100%' : undefined,
      ...variantStyles[variant],
      ...sizeStyles[size],
      ...style,
    };

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading}
        aria-disabled={isDisabled}
        style={base}
        {...props}
      >
        {loading ? <Spinner size={size === 'lg' ? 16 : 13} /> : iconLeft}
        {children}
        {!loading && iconRight}
      </button>
    );
  }
);
Button.displayName = 'VFButton';

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ animation: 'vf-spin 0.7s linear infinite', flexShrink: 0 }}
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40" strokeDashoffset="30" strokeLinecap="round" />
    </svg>
  );
}

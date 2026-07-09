import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  fullWidth?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, iconLeft, iconRight, fullWidth = false, id, style, ...props }, ref) => {
    const inputId = id ?? (label ? `vf-input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

    const inputStyle: React.CSSProperties = {
      width: '100%',
      background: 'var(--vf-input-bg)',
      border: `1px solid ${error ? 'var(--vf-danger)' : 'var(--vf-border-default)'}`,
      borderRadius: 'var(--vf-radius-md)',
      color: 'var(--vf-text-primary)',
      fontSize: 'var(--vf-type-body-size)',
      lineHeight: 'var(--vf-type-body-line)',
      padding: iconLeft ? '7px 10px 7px 34px' : iconRight ? '7px 34px 7px 10px' : '7px 10px',
      fontFamily: 'var(--vf-font-sans)',
      outline: 'none',
      transition: `border-color var(--vf-transition-fast), box-shadow var(--vf-transition-fast)`,
    };

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          width: fullWidth ? '100%' : undefined,
          ...style,
        }}
      >
        {label && (
          <label
            htmlFor={inputId}
            style={{
              fontSize: 'var(--vf-type-caption-size)',
              fontWeight: 600,
              color: 'var(--vf-text-secondary)',
              letterSpacing: '0.03em',
            }}
          >
            {label}
          </label>
        )}
        <div style={{ position: 'relative' }}>
          {iconLeft && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--vf-text-muted)',
                display: 'flex',
                pointerEvents: 'none',
              }}
            >
              {iconLeft}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
            style={inputStyle}
            {...props}
          />
          {iconRight && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--vf-text-muted)',
                display: 'flex',
                pointerEvents: 'none',
              }}
            >
              {iconRight}
            </span>
          )}
        </div>
        {error && (
          <span
            id={`${inputId}-error`}
            role="alert"
            style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-danger)' }}
          >
            {error}
          </span>
        )}
        {hint && !error && (
          <span
            id={`${inputId}-hint`}
            style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)' }}
          >
            {hint}
          </span>
        )}
      </div>
    );
  }
);
Input.displayName = 'VFInput';

import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  error?: string;
  hint?: string;
  options: SelectOption[];
  placeholder?: string;
  fullWidth?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, options, placeholder, fullWidth = false, id, style, ...props }, ref) => {
    const selectId = id ?? (label ? `vf-select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

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
            htmlFor={selectId}
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
          <select
            ref={ref}
            id={selectId}
            aria-invalid={!!error}
            aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
            style={{
              width: '100%',
              appearance: 'none',
              background: 'var(--vf-input-bg)',
              border: `1px solid ${error ? 'var(--vf-danger)' : 'var(--vf-border-default)'}`,
              borderRadius: 'var(--vf-radius-md)',
              color: 'var(--vf-text-primary)',
              fontSize: 'var(--vf-type-body-size)',
              padding: '7px 34px 7px 10px',
              fontFamily: 'var(--vf-font-sans)',
              cursor: 'pointer',
              outline: 'none',
              transition: `border-color var(--vf-transition-fast)`,
            }}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
          {/* chevron icon */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
              color: 'var(--vf-text-muted)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        {error && (
          <span
            id={`${selectId}-error`}
            role="alert"
            style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-danger)' }}
          >
            {error}
          </span>
        )}
        {hint && !error && (
          <span
            id={`${selectId}-hint`}
            style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)' }}
          >
            {hint}
          </span>
        )}
      </div>
    );
  }
);
Select.displayName = 'VFSelect';

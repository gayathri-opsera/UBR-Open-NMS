import React from 'react';

export interface SpinnerProps {
  size?: number;
  color?: string;
  label?: string;
  style?: React.CSSProperties;
}

export function Spinner({ size = 20, color = 'var(--vf-accent)', label = 'Loading…', style }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ animation: 'vf-spin 0.7s linear infinite', display: 'block' }}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray="48"
          strokeDashoffset="36"
          strokeLinecap="round"
          opacity="0.9"
        />
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray="48"
          strokeDashoffset="0"
          strokeLinecap="round"
          opacity="0.15"
        />
      </svg>
    </span>
  );
}

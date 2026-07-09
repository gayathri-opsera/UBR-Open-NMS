import React from 'react';

// ── Error Boundary ─────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.(error, info);
    // Structured logging — avoids exposing stack traces to UI per security policy
    console.error('[VF ErrorBoundary]', { message: error.message, componentStack: info.componentStack });
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return <>{this.props.fallback(this.state.error, this.reset)}</>;
      }
      return <DefaultErrorFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 48,
        textAlign: 'center',
        minHeight: 240,
      }}
    >
      <div aria-hidden="true" style={{ fontSize: 40 }}>⚠</div>
      <div>
        <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 'var(--vf-type-h4-size)', color: 'var(--vf-text-primary)' }}>
          Something went wrong
        </p>
        <p style={{ margin: 0, fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)', maxWidth: 360 }}>
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
      </div>
      <button
        onClick={reset}
        aria-label="Retry"
        style={{
          padding: '6px 18px',
          background: 'var(--vf-accent-bg)',
          border: '1px solid var(--vf-accent)',
          borderRadius: 'var(--vf-radius-md)',
          color: 'var(--vf-accent)',
          fontFamily: 'var(--vf-font-sans)',
          fontSize: 'var(--vf-type-body-size)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}

// ── Loading State ──────────────────────────────────────────────────────────────

export interface LoadingStateProps {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  fullPage?: boolean;
}

const sizeMap = { sm: 20, md: 28, lg: 40 };

export function LoadingState({ label = 'Loading…', size = 'md', fullPage = false }: LoadingStateProps) {
  const spinnerSize = sizeMap[size];

  return (
    <div
      role="status"
      aria-label={label}
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: fullPage ? 0 : 48,
        minHeight: fullPage ? '100vh' : 180,
        background: fullPage ? 'var(--vf-canvas)' : undefined,
      }}
    >
      <svg
        width={spinnerSize}
        height={spinnerSize}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ animation: 'vf-spin 0.7s linear infinite' }}
      >
        <circle cx="12" cy="12" r="9" stroke="var(--vf-accent)" strokeWidth="2.5" strokeDasharray="48" strokeDashoffset="36" strokeLinecap="round" opacity="0.9" />
        <circle cx="12" cy="12" r="9" stroke="var(--vf-accent)" strokeWidth="2.5" strokeDasharray="48" strokeDashoffset="0" strokeLinecap="round" opacity="0.15" />
      </svg>
      <span style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)' }}>
        {label}
      </span>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 8 : 12,
        padding: compact ? 24 : 56,
        textAlign: 'center',
        minHeight: compact ? 120 : 240,
        animation: 'vf-fade-in 200ms ease',
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{
            width: compact ? 36 : 56,
            height: compact ? 36 : 56,
            borderRadius: '50%',
            background: 'var(--vf-elevated)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--vf-text-muted)',
            fontSize: compact ? 18 : 24,
          }}
        >
          {icon}
        </div>
      )}
      <div>
        <p
          style={{
            margin: '0 0 4px',
            fontWeight: 600,
            fontSize: compact ? 'var(--vf-type-body-size)' : 'var(--vf-type-h4-size)',
            color: 'var(--vf-text-primary)',
          }}
        >
          {title}
        </p>
        {description && (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--vf-type-caption-size)',
              color: 'var(--vf-text-muted)',
              maxWidth: 320,
            }}
          >
            {description}
          </p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

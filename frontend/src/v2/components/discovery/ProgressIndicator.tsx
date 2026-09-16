/**
 * ProgressIndicator — reusable horizontal progress bar with label.
 *
 * Used by DiscoveryRunStatusView to display ICMP sweep progress.
 * Renders a labeled bar with percentage and optional description.
 */

export interface ProgressIndicatorProps {
  /** 0–100 percentage; clamped to [0, 100]. */
  pct: number;
  /** Primary label shown above the bar. */
  label: string;
  /** Optional secondary description shown below the bar. */
  description?: string;
  /** Accessible label for the progress element. Defaults to `label`. */
  ariaLabel?: string;
}

/**
 * ProgressIndicator renders an accessible progress bar.
 * The bar color transitions from accent (in progress) to success (100%).
 */
export function ProgressIndicator({ pct, label, description, ariaLabel }: ProgressIndicatorProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const isComplete = clamped >= 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
          {label}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: isComplete ? 'var(--vf-success)' : 'var(--vf-accent)',
            fontFamily: 'var(--vf-font-mono)',
          }}
        >
          {clamped}%
        </span>
      </div>

      {/* Progress bar track */}
      <div
        style={{
          width: '100%',
          height: 8,
          background: 'var(--vf-border-subtle)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          role="progressbar"
          aria-label={ariaLabel ?? label}
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: '100%',
            width: `${clamped}%`,
            background: isComplete ? 'var(--vf-success)' : 'var(--vf-accent)',
            borderRadius: 4,
            transition: 'width 0.5s ease, background 0.3s ease',
          }}
        />
      </div>

      {description && (
        <span style={{ fontSize: 11, color: 'var(--vf-text-muted)' }}>{description}</span>
      )}
    </div>
  );
}

/**
 * AvailabilityBadge — WO-041
 *
 * Renders a device availability health state badge (UP/DOWN/DEGRADED/UNKNOWN)
 * with reason text, last-observed timestamp, and stale/dampened indicators.
 *
 * Used in device detail pages, KPI cards, and topology overlays.
 * Does not contain availability calculation logic — state is provided by caller.
 */
import React from 'react';
import type { DeviceAvailabilitySummary, AvailabilityHealthState } from '../../api/kpi.types';
import { availabilityStateColor, availabilityStateBadge } from '../../api/kpi.types';

interface AvailabilityBadgeProps {
  /** Full availability summary. Either this or `state` must be provided. */
  summary?: DeviceAvailabilitySummary;
  /** Simplified state-only mode when full summary is unavailable. */
  state?: AvailabilityHealthState;
  /** Show reason text below badge. Defaults to true when summary provided. */
  showReason?: boolean;
  /** Show last-observed timestamp. Defaults to true when summary provided. */
  showTimestamp?: boolean;
  /** Show confidence indicator. Defaults to false. */
  showConfidence?: boolean;
  /** Compact mode — badge only, no text. */
  compact?: boolean;
}

const STATE_ICONS: Record<AvailabilityHealthState, string> = {
  UP:       '✓',
  DOWN:     '✗',
  DEGRADED: '⚠',
  UNKNOWN:  '?',
};

export function AvailabilityBadge({
  summary,
  state: stateOverride,
  showReason = !!summary,
  showTimestamp = !!summary,
  showConfidence = false,
  compact = false,
}: AvailabilityBadgeProps) {
  const state: AvailabilityHealthState = summary?.healthState ?? stateOverride ?? 'UNKNOWN';
  const color = availabilityStateColor(state);
  const icon  = STATE_ICONS[state];

  if (compact) {
    return (
      <span
        aria-label={`Availability: ${state}${summary?.primaryReason ? ` — ${summary.primaryReason}` : ''}`}
        title={summary?.primaryReason}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 12,
          fontSize: 11, fontWeight: 700,
          color: 'white',
          background: color,
          border: `1px solid ${color}`,
          userSelect: 'none',
        }}
      >
        {icon} {state}
      </span>
    );
  }

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', gap: 4,
      padding: '8px 12px',
      background: 'var(--vf-surface)',
      border: `1px solid var(--vf-border-subtle)`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 8,
      minWidth: 160,
    }}>
      {/* State badge row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-label={`Availability state: ${state}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 10,
            fontSize: 11, fontWeight: 700,
            color: 'white',
            background: color,
          }}
        >
          {icon} {state}
        </span>

        {/* Stale indicator */}
        {summary?.stale && (
          <span
            aria-label="Data may be stale"
            title="Observation timestamp older than freshness window"
            style={{ fontSize: 10, color: 'var(--vf-warning)', fontStyle: 'italic' }}
          >
            stale
          </span>
        )}

        {/* Flap dampening indicator */}
        {summary?.dampenedUntil && (
          <span
            aria-label="Flap dampening active"
            title={`Dampened until ${new Date(summary.dampenedUntil).toLocaleTimeString()}`}
            style={{ fontSize: 10, color: 'var(--vf-text-muted)', fontStyle: 'italic' }}
          >
            dampened
          </span>
        )}
      </div>

      {/* Reason */}
      {showReason && summary?.primaryReason && (
        <div style={{ fontSize: 11, color: 'var(--vf-text-secondary)', lineHeight: '1.4' }}>
          {summary.primaryReason}
        </div>
      )}

      {/* Secondary reasons */}
      {showReason && summary?.secondaryReasons && summary.secondaryReasons.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 14, fontSize: 10, color: 'var(--vf-text-muted)', lineHeight: '1.5' }}>
          {summary.secondaryReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {/* Last observed */}
      {showTimestamp && (
        <div style={{ fontSize: 10, color: 'var(--vf-text-dim)' }}>
          {summary?.lastObservedAt
            ? `Last seen: ${new Date(summary.lastObservedAt).toLocaleString()}`
            : 'Last seen: unknown'}
          {summary?.source && summary.source !== 'UNKNOWN' && (
            <span style={{ marginLeft: 6 }}>· via {summary.source}</span>
          )}
        </div>
      )}

      {/* Confidence */}
      {showConfidence && summary != null && (
        <div style={{ fontSize: 10, color: 'var(--vf-text-dim)' }}>
          Confidence: {(summary.confidence * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}

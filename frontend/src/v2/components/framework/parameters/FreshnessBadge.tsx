/**
 * WO-014: FreshnessBadge renders the freshness state of a polled parameter value.
 *
 * Accessibility: the badge uses role="status" and an aria-label so screen-reader
 * users receive the same information as sighted users. Freshness is never
 * communicated through colour alone — the label text is always present.
 */
import React from 'react';
import { Badge } from '../../common/Badge';
import type { BadgeVariant } from '../../common/Badge';
import type { FreshnessState } from '../../../../api/framework-parameters.types';

interface FreshnessBadgeProps {
  /** Freshness state from the parameter-poller current-value API. */
  state: FreshnessState;
  /** ISO-8601 timestamp of the last successful collection. Used for tooltip. */
  lastSuccessAt?: string;
  className?: string;
}

const FRESHNESS_CONFIG: Record<FreshnessState, { variant: BadgeVariant; label: string }> = {
  FRESH:          { variant: 'success', label: 'Fresh' },
  STALE:          { variant: 'warning', label: 'Stale' },
  FAILED:         { variant: 'danger',  label: 'Failed' },
  UNMAPPED:       { variant: 'default', label: 'Unmapped' },
  UNKNOWN_DEVICE: { variant: 'unknown', label: 'No framework' },
};

/**
 * FreshnessBadge — displays the freshness state of a polled parameter.
 *
 * @example
 *   <FreshnessBadge state="STALE" lastSuccessAt="2026-09-17T09:45:00Z" />
 *   // renders: ⚠ Stale (with tooltip showing the last success time)
 */
export function FreshnessBadge({ state, lastSuccessAt, className }: FreshnessBadgeProps) {
  const { variant, label } = FRESHNESS_CONFIG[state] ?? FRESHNESS_CONFIG.UNKNOWN_DEVICE;

  const title = lastSuccessAt
    ? `Last collected: ${new Date(lastSuccessAt).toLocaleString()}`
    : state === 'FRESH'
    ? 'Value is up to date'
    : 'No successful collection recorded';

  return (
    <Badge
      variant={variant}
      dot
      className={className}
      aria-label={`Freshness: ${label}`}
      title={title}
    >
      {label}
    </Badge>
  );
}

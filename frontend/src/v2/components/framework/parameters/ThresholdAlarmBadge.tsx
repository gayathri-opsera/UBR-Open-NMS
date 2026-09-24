/**
 * WO-014: ThresholdAlarmBadge indicates whether a parameter value has breached
 * a configured threshold from the Product Definition metadata.
 *
 * The badge is only rendered when a numeric value AND threshold metadata are both
 * present. It shows a CRITICAL badge for values that are breached and a clear
 * badge for values that are within range.
 *
 * Accessibility: the alarm state is never communicated through colour alone —
 * the label text is always present, and aria-label provides screen-reader context.
 */
import React from 'react';
import { Badge } from '../../common/Badge';
import type { ParameterThresholds } from '../../../../api/framework-panels.types';

interface ThresholdAlarmBadgeProps {
  /** Resolved numeric parameter value. Undefined = do not render. */
  valueNumeric?: number;
  /** Threshold metadata from the Product Definition parameter spec. */
  thresholds?: ParameterThresholds;
  /** Parameter label — used in aria-label for context. */
  parameterLabel?: string;
  className?: string;
}

/**
 * Determine whether a value is breaching a threshold.
 * Returns 'HIGH', 'LOW', or null when no breach.
 */
function detectBreach(value: number, thresholds: ParameterThresholds): 'HIGH' | 'LOW' | null {
  if (thresholds.high !== undefined && value >= thresholds.high) return 'HIGH';
  if (thresholds.low  !== undefined && value <= thresholds.low)  return 'LOW';
  return null;
}

/**
 * ThresholdAlarmBadge — shows threshold breach status for a numeric parameter.
 *
 * @example
 *   // Breached high threshold
 *   <ThresholdAlarmBadge valueNumeric={95} thresholds={{ high: 90 }} parameterLabel="CPU Load" />
 *   // renders: ● HIGH ALARM
 *
 *   // Within range
 *   <ThresholdAlarmBadge valueNumeric={30} thresholds={{ high: 90 }} parameterLabel="CPU Load" />
 *   // renders: ● OK
 */
export function ThresholdAlarmBadge({
  valueNumeric,
  thresholds,
  parameterLabel = 'parameter',
  className,
}: ThresholdAlarmBadgeProps) {
  // Only render when both a numeric value and at least one threshold are present.
  if (valueNumeric === undefined || !thresholds) return null;
  if (thresholds.high === undefined && thresholds.low === undefined) return null;

  const breach = detectBreach(valueNumeric, thresholds);

  if (breach === 'HIGH') {
    return (
      <Badge
        variant="critical"
        dot
        className={className}
        aria-label={`${parameterLabel}: threshold high alarm`}
        title={`Value ${valueNumeric} ≥ high threshold ${thresholds.high}`}
      >
        HIGH ALARM
      </Badge>
    );
  }

  if (breach === 'LOW') {
    return (
      <Badge
        variant="major"
        dot
        className={className}
        aria-label={`${parameterLabel}: threshold low alarm`}
        title={`Value ${valueNumeric} ≤ low threshold ${thresholds.low}`}
      >
        LOW ALARM
      </Badge>
    );
  }

  return (
    <Badge
      variant="clear"
      dot
      className={className}
      aria-label={`${parameterLabel}: within threshold range`}
      title="Value is within configured threshold range"
    >
      OK
    </Badge>
  );
}

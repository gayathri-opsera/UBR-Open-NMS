/**
 * WO-014: ParameterValueCard renders a single parameter's current value
 * with freshness, threshold alarm, and read-only widget display.
 *
 * All controls are read-only in P0. The effectiveWidget determines the
 * display format (textfield, gauge label, counter, slider range, dropdown,
 * toggle, readonly) but no interactive write affordance is enabled.
 *
 * Accessibility: each card has a unique id linking label to value, and both
 * FreshnessBadge and ThresholdAlarmBadge carry screen-reader labels.
 */
import React from 'react';
import type { AdaptiveParameter } from '../../../../api/framework-panels.types';
import type { ParameterCurrentValue } from '../../../../api/framework-parameters.types';
import { FreshnessBadge } from './FreshnessBadge';
import { ThresholdAlarmBadge } from './ThresholdAlarmBadge';

interface ParameterValueCardProps {
  /** Template parameter metadata (widget, thresholds, label). */
  parameter: AdaptiveParameter;
  /** Current polled value — undefined when not yet polled. */
  currentValue?: ParameterCurrentValue;
  className?: string;
}

/** Display the value string with unit suffix when available. */
function formatValue(value?: string, unit?: string): string {
  if (!value) return '—';
  return unit ? `${value} ${unit}` : value;
}

/**
 * Choose display text for the widget type.
 * All representations are read-only in P0.
 */
function renderWidgetDisplay(parameter: AdaptiveParameter, value?: string): React.ReactNode {
  switch (parameter.effectiveWidget) {
    case 'toggle':
      return (
        <span
          role="switch"
          aria-checked={value === 'true' || value === '1'}
          aria-readonly
          aria-label={parameter.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--vf-type-label-size)',
            color: 'var(--vf-text-primary)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 28,
              height: 16,
              borderRadius: 8,
              background: value === 'true' || value === '1'
                ? 'var(--vf-success)'
                : 'var(--vf-elevated)',
              border: '1px solid var(--vf-border-subtle)',
            }}
            aria-hidden="true"
          />
          {value === 'true' || value === '1' ? 'On' : 'Off'}
        </span>
      );

    case 'dropdown':
      return (
        <span
          aria-readonly
          style={{
            fontSize: 'var(--vf-type-label-size)',
            color: 'var(--vf-text-primary)',
            fontFamily: 'var(--vf-font-mono)',
          }}
        >
          {value ?? '—'}
        </span>
      );

    case 'slider':
      // Render as a visual range bar — read-only, not an interactive range input.
      const min = parameter.minValue ?? 0;
      const max = parameter.maxValue ?? 100;
      const num = parseFloat(value ?? '0');
      const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));
      return (
        <div aria-label={`${parameter.label}: ${formatValue(value, parameter.unit)}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            role="progressbar"
            aria-valuenow={num}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={formatValue(value, parameter.unit)}
            style={{
              width: '100%',
              height: 8,
              borderRadius: 4,
              background: 'var(--vf-elevated)',
              border: '1px solid var(--vf-border-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: `${pct}%`,
                height: '100%',
                background: 'var(--vf-accent)',
                borderRadius: 4,
              }}
            />
          </div>
          <span style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-secondary)' }}>
            {formatValue(value, parameter.unit)} / {max}{parameter.unit ? ` ${parameter.unit}` : ''}
          </span>
        </div>
      );

    default:
      // textfield, gauge, counter, readonly → plain text display
      return (
        <span
          aria-label={parameter.label}
          style={{
            fontSize: 'var(--vf-type-label-size)',
            color: 'var(--vf-text-primary)',
            fontFamily: 'var(--vf-font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {formatValue(value, parameter.unit)}
        </span>
      );
  }
}

/**
 * ParameterValueCard — a card displaying the current value of one parameter.
 *
 * @example
 *   <ParameterValueCard parameter={ifInOctetsMeta} currentValue={ifInOctetsValue} />
 */
export function ParameterValueCard({ parameter, currentValue, className }: ParameterValueCardProps) {
  const cardId = `param-card-${parameter.parameterId}`;

  return (
    <div
      id={cardId}
      className={className}
      role="region"
      aria-label={parameter.label}
      style={{
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-md)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header row: label + freshness + threshold badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          id={`${cardId}-label`}
          style={{
            fontSize: 'var(--vf-type-label-size)',
            fontWeight: 600,
            color: 'var(--vf-text-primary)',
            flex: 1,
            minWidth: 0,
          }}
        >
          {parameter.label}
        </span>

        {currentValue && (
          <FreshnessBadge
            state={currentValue.freshnessState}
            lastSuccessAt={currentValue.lastSuccessAt}
          />
        )}

        {currentValue && parameter.thresholds && (
          <ThresholdAlarmBadge
            valueNumeric={currentValue.valueNumeric}
            thresholds={parameter.thresholds}
            parameterLabel={parameter.label}
          />
        )}
      </div>

      {/* Value display */}
      <div aria-labelledby={`${cardId}-label`}>
        {renderWidgetDisplay(parameter, currentValue?.value)}
      </div>

      {/* Failure reason when not fresh */}
      {currentValue?.failureReason && currentValue.freshnessState !== 'FRESH' && (
        <p
          role="alert"
          style={{
            fontSize: 'var(--vf-type-caption-size)',
            color: 'var(--vf-warning)',
            margin: 0,
          }}
        >
          {currentValue.failureReason}
        </p>
      )}

      {/* Source footer */}
      {currentValue?.source && (
        <span
          style={{
            fontSize: 'var(--vf-type-caption-size)',
            color: 'var(--vf-text-secondary)',
          }}
        >
          via {currentValue.source}
          {currentValue.collectedAt && (
            <> · {new Date(currentValue.collectedAt).toLocaleTimeString()}</>
          )}
        </span>
      )}
    </div>
  );
}

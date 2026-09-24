/**
 * WO-014 / UI-ENHANCEMENT: ParameterValueCard renders a single parameter's
 * current value with freshness, threshold alarm, description, and an optional
 * inline edit affordance for writable parameters (readOnly = false).
 *
 * Layout (per NMS framework spec screenshot):
 *   Left  — parameter name (bold) + description text below
 *   Right — value string (large, color-coded by freshness/alarm) + badge below
 *
 * Color rules:
 *   FRESH + no alarm   → success (green)
 *   STALE              → warning (orange)
 *   threshold breached → danger  (red)
 *   no value yet       → text-primary (neutral)
 *
 * Write support: when {@code parameter.readOnly === false} and {@code onWrite}
 * is provided, an Edit button appears. Clicking it shows an inline text input
 * and a Save/Cancel pair. The parent is responsible for calling the API and
 * showing toast feedback.
 *
 * Accessibility: each card has a unique id linking label to value, and both
 * FreshnessBadge and ThresholdAlarmBadge carry screen-reader labels.
 */
import React, { useState } from 'react';
import type { AdaptiveParameter, ParameterThresholds } from '../../../../api/framework-panels.types';
import type { ParameterCurrentValue } from '../../../../api/framework-parameters.types';
import { FreshnessBadge } from './FreshnessBadge';
import { ThresholdAlarmBadge } from './ThresholdAlarmBadge';

// ── Value color helper ────────────────────────────────────────────────────────

/**
 * Determines the color for the displayed value based on freshness state and
 * whether a threshold has been breached. Matches the NMS design spec.
 */
function resolveValueColor(
  freshnessState: string | undefined,
  thresholds: ParameterThresholds | undefined,
  valueNumeric: number | undefined,
): string {
  if (!freshnessState) return 'var(--vf-text-primary)';

  // Threshold breach always surfaces as danger, regardless of staleness.
  if (thresholds && valueNumeric !== undefined) {
    if (thresholds.high !== undefined && valueNumeric >= thresholds.high) return 'var(--vf-danger)';
    if (thresholds.low  !== undefined && valueNumeric <= thresholds.low)  return 'var(--vf-danger)';
  }

  if (freshnessState === 'FRESH') return 'var(--vf-success)';
  if (freshnessState === 'STALE') return 'var(--vf-warning)';
  return 'var(--vf-text-primary)';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ParameterValueCardProps {
  /** Template parameter metadata (widget, thresholds, label). */
  parameter: AdaptiveParameter;
  /** Current polled value — undefined when not yet polled. */
  currentValue?: ParameterCurrentValue;
  /**
   * Called when the operator submits a new value via the inline editor.
   * Only invoked for parameters where {@code parameter.readOnly === false}.
   * The parent should call the API and show toast feedback; the card resets
   * to view mode regardless of outcome (parent handles error toasts).
   */
  onWrite?: (parameterId: string, value: string) => Promise<void>;
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Display the value string with unit suffix when available. */
function formatValue(value?: string, unit?: string): string {
  if (!value) return '—';
  return unit ? `${value} ${unit}` : value;
}

/**
 * Renders the widget-specific value display (all read-only in P0).
 * Slider, toggle, dropdown, and default text variants are handled.
 */
function renderWidgetDisplay(
  parameter: AdaptiveParameter,
  value: string | undefined,
  valueColor: string,
): React.ReactNode {
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
            color: valueColor,
            fontWeight: 700,
          }}
        >
          <span
            aria-hidden
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
          />
          {value === 'true' || value === '1' ? 'On' : 'Off'}
        </span>
      );

    case 'dropdown':
      return (
        <span
          aria-readonly
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: valueColor,
            fontFamily: 'var(--vf-font-mono)',
          }}
        >
          {value ?? '—'}
        </span>
      );

    case 'slider': {
      // Read-only range bar with value displayed large at top-right.
      const min = parameter.minValue ?? 0;
      const max = parameter.maxValue ?? 100;
      const num = parseFloat(value ?? '0');
      const pct = Math.min(100, Math.max(0, ((num - min) / (max - min)) * 100));
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
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
              aria-hidden
              style={{
                width: `${pct}%`,
                height: '100%',
                background: 'var(--vf-accent)',
                borderRadius: 4,
              }}
            />
          </div>
          <span style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-secondary)' }}>
            Range: {min}{parameter.unit ? ` ${parameter.unit}` : ''} – {max}{parameter.unit ? ` ${parameter.unit}` : ''}
          </span>
        </div>
      );
    }

    default:
      // textfield, gauge, counter, readonly → plain mono text
      return (
        <span
          aria-label={parameter.label}
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: valueColor,
            fontFamily: 'var(--vf-font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {formatValue(value, parameter.unit)}
        </span>
      );
  }
}

// ── Card component ────────────────────────────────────────────────────────────

/**
 * ParameterValueCard — a card displaying the current value of one parameter.
 * The layout matches the NMS framework spec design: name+description on the left,
 * large colored value + freshness/threshold badge on the right.
 *
 * @example
 *   <ParameterValueCard parameter={txPowerMeta} currentValue={txPowerValue} />
 */
export function ParameterValueCard({ parameter, currentValue, onWrite, className }: ParameterValueCardProps) {
  const cardId    = `param-card-${parameter.parameterId}`;
  const valueColor = resolveValueColor(
    currentValue?.freshnessState,
    parameter.thresholds,
    currentValue?.valueNumeric,
  );

  const isSlider  = parameter.effectiveWidget === 'slider';
  const isWritable = !parameter.readOnly && typeof onWrite === 'function';

  const [editing, setEditing]   = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving]     = useState(false);

  function handleEditClick() {
    setEditValue(currentValue?.value ?? '');
    setEditing(true);
  }

  function handleCancel() {
    setEditing(false);
    setEditValue('');
  }

  async function handleSave() {
    if (!onWrite) return;
    setSaving(true);
    try {
      await onWrite(parameter.parameterId, editValue);
    } finally {
      setSaving(false);
      setEditing(false);
      setEditValue('');
    }
  }

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
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* ── Top row: name+description (left) | value+badge (right) ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Left: name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            id={`${cardId}-label`}
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--vf-text-primary)',
              marginBottom: parameter.description ? 4 : 0,
            }}
          >
            {parameter.label}
          </div>
          {parameter.description && (
            <p
              style={{
                fontSize: 12,
                color: 'var(--vf-text-secondary)',
                margin: 0,
                lineHeight: 1.4,
              }}
            >
              {parameter.description}
            </p>
          )}
        </div>

        {/* Right: value + badges (hidden for slider — rendered below) */}
        {!isSlider && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
            <div aria-labelledby={`${cardId}-label`}>
              {renderWidgetDisplay(parameter, currentValue?.value, valueColor)}
            </div>
            {/* Badges: freshness and threshold alarm */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
          </div>
        )}
      </div>

      {/* ── Slider widget: spans full width below name/description ── */}
      {isSlider && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Value + badges inline with slider */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div aria-labelledby={`${cardId}-label`}>
              <span style={{ fontSize: 20, fontWeight: 700, color: valueColor, fontFamily: 'var(--vf-font-mono)' }}>
                {formatValue(currentValue?.value, parameter.unit)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {currentValue && (
                <FreshnessBadge state={currentValue.freshnessState} lastSuccessAt={currentValue.lastSuccessAt} />
              )}
              {currentValue && parameter.thresholds && (
                <ThresholdAlarmBadge valueNumeric={currentValue.valueNumeric} thresholds={parameter.thresholds} parameterLabel={parameter.label} />
              )}
            </div>
          </div>
          {/* The slider bar */}
          {renderWidgetDisplay(parameter, currentValue?.value, valueColor)}
        </div>
      )}

      {/* ── Inline write editor (writable parameters only) ── */}
      {isWritable && (
        editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <input
              aria-label={`New value for ${parameter.label}`}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); if (e.key === 'Escape') handleCancel(); }}
              autoFocus
              disabled={saving}
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 13,
                border: '1px solid var(--vf-border-subtle)',
                borderRadius: 'var(--vf-radius-sm)',
                background: 'var(--vf-surface)',
                color: 'var(--vf-text-primary)',
                outline: 'none',
              }}
            />
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              aria-label="Save value"
              style={{
                padding: '4px 10px', fontSize: 12, fontWeight: 600,
                background: 'var(--vf-accent)', color: '#fff',
                border: 'none', borderRadius: 'var(--vf-radius-sm)', cursor: saving ? 'wait' : 'pointer',
              }}
            >
              {saving ? '…' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              aria-label="Cancel edit"
              style={{
                padding: '4px 10px', fontSize: 12,
                background: 'var(--vf-elevated)', color: 'var(--vf-text-secondary)',
                border: '1px solid var(--vf-border-subtle)', borderRadius: 'var(--vf-radius-sm)', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={handleEditClick}
            aria-label={`Edit ${parameter.label}`}
            style={{
              alignSelf: 'flex-start',
              marginTop: 2,
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 500,
              background: 'none',
              border: '1px solid var(--vf-border-subtle)',
              borderRadius: 'var(--vf-radius-sm)',
              color: 'var(--vf-text-secondary)',
              cursor: 'pointer',
            }}
          >
            Edit
          </button>
        )
      )}

      {/* ── Failure reason (when stale and a reason is known) ── */}
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

      {/* ── Source footer ── */}
      {currentValue?.source && (
        <span style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-muted)' }}>
          Source: poll via SPAL {currentValue.source} adapter
          {currentValue.collectedAt && (
            <> · {new Date(currentValue.collectedAt).toLocaleTimeString()}</>
          )}
        </span>
      )}
    </div>
  );
}

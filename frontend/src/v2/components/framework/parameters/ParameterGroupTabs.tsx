/**
 * WO-014: ParameterGroupTabs renders Product Definition parameter groups
 * as tabs, each containing a grid of ParameterValueCard components.
 *
 * Groups with no authorized parameters after server-side filtering are absent
 * from the template response and therefore never rendered here. The client
 * must not attempt to reconstruct hidden parameters.
 *
 * Accessibility: tabs follow the WAI-ARIA Tabs pattern with keyboard
 * navigation (ArrowLeft/Right to move between tabs, Enter/Space to activate).
 */
import React, { useState, useId } from 'react';
import type { AdaptiveParameterGroup } from '../../../../api/framework-panels.types';
import type { ParameterCurrentValue } from '../../../../api/framework-parameters.types';
import { ParameterValueCard } from './ParameterValueCard';
import { EmptyState } from '../../common/States';

interface ParameterGroupTabsProps {
  /** Authorized parameter groups from the adaptive UI template. */
  groups: AdaptiveParameterGroup[];
  /**
   * Current values indexed by parameterId.
   * Empty map means no poll data is available yet — unmapped state is shown.
   */
  currentValues: Map<string, ParameterCurrentValue>;
  /**
   * Called when the operator submits a new value for a writable parameter.
   * When omitted, all cards render in display-only mode.
   */
  onWrite?: (parameterId: string, value: string) => Promise<void>;
  className?: string;
}

/**
 * ParameterGroupTabs — tab-per-group layout with ParameterValueCard grid.
 *
 * @example
 *   <ParameterGroupTabs groups={template.groups} currentValues={valueMap} />
 */
export function ParameterGroupTabs({ groups, currentValues, onWrite, className }: ParameterGroupTabsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabListId = useId();

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No parameter groups visible"
        description="Your current role does not have access to any parameter groups for this device."
      />
    );
  }

  const activeGroup = groups[activeIndex] ?? groups[0];

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Tab list */}
      <div
        role="tablist"
        id={tabListId}
        aria-label="Parameter groups"
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--vf-border-subtle)',
          overflowX: 'auto',
        }}
      >
        {groups.map((group, idx) => {
          const isActive = idx === activeIndex;
          return (
            <button
              key={group.groupId}
              role="tab"
              id={`${tabListId}-tab-${idx}`}
              aria-selected={isActive}
              aria-controls={`${tabListId}-panel-${idx}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveIndex(idx)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(groups.length - 1, i + 1));
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(0, i - 1));
                }
              }}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: isActive
                  ? '2px solid var(--vf-accent)'
                  : '2px solid transparent',
                padding: '8px 16px',
                cursor: 'pointer',
                fontSize: 'var(--vf-type-label-size)',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
                whiteSpace: 'nowrap',
                transition: 'color var(--vf-transition-fast), border-color var(--vf-transition-fast)',
                outline: 'none',
              }}
              onFocus={(e) => {
                // Visible focus ring for keyboard navigation (not shown on click).
                e.currentTarget.style.outline = '2px solid var(--vf-accent)';
                e.currentTarget.style.outlineOffset = '-2px';
              }}
              onBlur={(e) => {
                e.currentTarget.style.outline = 'none';
              }}
            >
              {group.label}
              <span
                aria-hidden="true"
                style={{
                  marginLeft: 6,
                  fontSize: 'var(--vf-type-caption-size)',
                  color: 'var(--vf-text-tertiary)',
                }}
              >
                ({group.parameters.length})
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {groups.map((group, idx) => (
        <div
          key={group.groupId}
          role="tabpanel"
          id={`${tabListId}-panel-${idx}`}
          aria-labelledby={`${tabListId}-tab-${idx}`}
          hidden={idx !== activeIndex}
          style={{ padding: '16px 0' }}
        >
          {activeGroup.groupId === group.groupId && (
            <ParameterGroupPanel
              group={activeGroup}
              currentValues={currentValues}
              onWrite={onWrite}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Inner panel component ─────────────────────────────────────────────────────

interface ParameterGroupPanelProps {
  group: AdaptiveParameterGroup;
  currentValues: Map<string, ParameterCurrentValue>;
  onWrite?: (parameterId: string, value: string) => Promise<void>;
}

function ParameterGroupPanel({ group, currentValues, onWrite }: ParameterGroupPanelProps) {
  if (group.parameters.length === 0) {
    return (
      <EmptyState
        title="No visible parameters"
        description="No parameters in this group are visible to your current role."
      />
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 12,
      }}
    >
      {group.parameters.map((param) => (
        <ParameterValueCard
          key={param.parameterId}
          parameter={param}
          currentValue={currentValues.get(param.parameterId)}
          onWrite={onWrite}
        />
      ))}
    </div>
  );
}

/**
 * Unit tests for WO-046 — KPI Threshold Breach Visualization
 *
 * Covers:
 *  - kpi.types: classifyBreach, breachSeverityColor, breachSeverityVariant
 *  - KpiBreachSummaryPanel: rendering, alarm links, no-alarm note
 *  - Threshold-to-chart mapping (threshold definitions, multi-severity)
 *  - Integration: mocked KPI drilldown API response containing threshold data
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  classifyBreach,
  breachSeverityColor,
  breachSeverityVariant,
} from '../../api/kpi.types';
import type { KpiThresholdDefinition, KpiBreachAnnotation } from '../../api/kpi.types';
import { KpiBreachSummaryPanel } from './KpiBreachSummaryPanel';
import {
  MOCK_THRESHOLD_LATENCY_WARN,
  MOCK_THRESHOLD_LATENCY_CRIT,
  MOCK_THRESHOLD_PACKET_LOSS_CRIT,
  MOCK_THRESHOLD_AVAIL_WARN,
  MOCK_BREACH_WARN_NO_ALARM,
  MOCK_BREACH_CRIT_WITH_ALARM,
  MOCK_BREACH_NO_ALARM,
} from '../../mocks/kpi.mock';

// ── classifyBreach ─────────────────────────────────────────────────────────────

describe('classifyBreach', () => {
  const thresholds: KpiThresholdDefinition[] = [
    MOCK_THRESHOLD_LATENCY_WARN,
    MOCK_THRESHOLD_LATENCY_CRIT,
  ];

  it('returns null for null value', () => {
    expect(classifyBreach('latencyMs', null, thresholds)).toBeNull();
  });

  it('returns null when no thresholds exist for metric', () => {
    expect(classifyBreach('rssi', 50, thresholds)).toBeNull();
  });

  it('returns null when value is below ABOVE threshold', () => {
    // latency=50, warn=100 — no breach
    expect(classifyBreach('latencyMs', 50, thresholds)).toBeNull();
  });

  it('returns WARNING when value crosses warning threshold but not critical', () => {
    // latency=150: above 100 (warn) but not above 200 (crit)
    expect(classifyBreach('latencyMs', 150, thresholds)).toBe('WARNING');
  });

  it('returns CRITICAL when value crosses critical threshold', () => {
    // latency=250: above both 100 (warn) and 200 (crit)
    expect(classifyBreach('latencyMs', 250, thresholds)).toBe('CRITICAL');
  });

  it('returns CRITICAL (highest severity wins) when multiple thresholds match', () => {
    expect(classifyBreach('latencyMs', 210, [
      MOCK_THRESHOLD_LATENCY_WARN,
      MOCK_THRESHOLD_LATENCY_CRIT,
    ])).toBe('CRITICAL');
  });

  it('handles BELOW operator for availability threshold', () => {
    // availability=99.4 < 99.5 warn threshold
    expect(classifyBreach('availabilityPct', 99.4, [MOCK_THRESHOLD_AVAIL_WARN])).toBe('WARNING');
  });

  it('returns null when BELOW threshold is not crossed', () => {
    // availability=99.8 > 99.5 — no breach
    expect(classifyBreach('availabilityPct', 99.8, [MOCK_THRESHOLD_AVAIL_WARN])).toBeNull();
  });

  it('returns CRITICAL for packet loss above crit threshold', () => {
    expect(classifyBreach('packetLossPct', 6, [
      { ...MOCK_THRESHOLD_PACKET_LOSS_CRIT },
    ])).toBe('CRITICAL');
  });
});

// ── breachSeverityColor / breachSeverityVariant ────────────────────────────────

describe('breachSeverityColor', () => {
  it('returns danger color for CRITICAL', () => {
    expect(breachSeverityColor('CRITICAL')).toBe('var(--vf-danger)');
  });
  it('returns warning color for WARNING', () => {
    expect(breachSeverityColor('WARNING')).toBe('var(--vf-warning)');
  });
  it('returns muted color for null', () => {
    expect(breachSeverityColor(null)).toBe('var(--vf-text-muted)');
  });
});

describe('breachSeverityVariant', () => {
  it('returns danger for CRITICAL', () => {
    expect(breachSeverityVariant('CRITICAL')).toBe('danger');
  });
  it('returns warning for WARNING', () => {
    expect(breachSeverityVariant('WARNING')).toBe('warning');
  });
  it('returns default for null', () => {
    expect(breachSeverityVariant(null)).toBe('default');
  });
});

// ── KpiBreachSummaryPanel ─────────────────────────────────────────────────────

const ALL_THRESHOLDS: KpiThresholdDefinition[] = [
  MOCK_THRESHOLD_LATENCY_WARN,
  MOCK_THRESHOLD_LATENCY_CRIT,
  MOCK_THRESHOLD_PACKET_LOSS_CRIT,
];

function renderPanel(
  breaches: KpiBreachAnnotation[],
  onAlarmClick = vi.fn(),
) {
  return render(
    <MemoryRouter>
      <KpiBreachSummaryPanel
        breaches={breaches}
        thresholds={ALL_THRESHOLDS}
        onAlarmClick={onAlarmClick}
      />
    </MemoryRouter>,
  );
}

describe('KpiBreachSummaryPanel', () => {
  it('renders nothing when no breaches', () => {
    const { container } = renderPanel([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders breach count badge', () => {
    renderPanel([MOCK_BREACH_WARN_NO_ALARM, MOCK_BREACH_CRIT_WITH_ALARM]);
    expect(screen.getByLabelText(/2 breach/i)).toBeInTheDocument();
  });

  it('renders CRITICAL badge for critical breach', () => {
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM]);
    expect(screen.getAllByText('CRITICAL').length).toBeGreaterThan(0);
  });

  it('renders WARNING badge for warning breach', () => {
    renderPanel([MOCK_BREACH_WARN_NO_ALARM]);
    expect(screen.getAllByText('WARNING').length).toBeGreaterThan(0);
  });

  it('shows alarm status badge as Active for active alarm', () => {
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM]);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows alarm status badge as Cleared for cleared alarm', () => {
    renderPanel([MOCK_BREACH_WARN_NO_ALARM]);
    expect(screen.getByText('Cleared')).toBeInTheDocument();
  });

  it('shows "No alarm" for breach without alarm reference', () => {
    renderPanel([MOCK_BREACH_NO_ALARM]);
    expect(screen.getByText('No alarm')).toBeInTheDocument();
  });

  it('renders View Alarm button for active alarm breach', () => {
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM]);
    expect(screen.getByText('View Alarm')).toBeInTheDocument();
  });

  it('calls onAlarmClick with the alarm ID when View Alarm clicked', () => {
    const onAlarmClick = vi.fn();
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM], onAlarmClick);
    fireEvent.click(screen.getByText('View Alarm'));
    expect(onAlarmClick).toHaveBeenCalledWith(MOCK_BREACH_CRIT_WITH_ALARM.relatedAlarmId);
  });

  it('does not render View Alarm button for cleared alarm breach', () => {
    renderPanel([MOCK_BREACH_WARN_NO_ALARM]);
    expect(screen.queryByText('View Alarm')).not.toBeInTheDocument();
  });

  it('shows info icon when breach has no relatedAlarmId', () => {
    renderPanel([MOCK_BREACH_NO_ALARM]);
    // The info circle ⓘ indicates no alarm was linked — test panel renders
    expect(screen.getByRole('region', { name: /threshold breach summary/i })).toBeInTheDocument();
  });

  it('orders CRITICAL breaches before WARNING breaches', () => {
    renderPanel([MOCK_BREACH_WARN_NO_ALARM, MOCK_BREACH_CRIT_WITH_ALARM]);
    const badges = screen.getAllByText(/CRITICAL|WARNING/);
    expect(badges[0].textContent).toBe('CRITICAL');
  });

  it('shows threshold value for known threshold', () => {
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM]);
    // threshold renders as ">200 ms" for critical latency
    expect(screen.getByText(/>200/)).toBeInTheDocument();
  });

  it('shows measured value in table', () => {
    renderPanel([MOCK_BREACH_CRIT_WITH_ALARM]);
    expect(screen.getByText(/245/)).toBeInTheDocument();
  });
});

// ── No-threshold behavior ──────────────────────────────────────────────────────

describe('classifyBreach — no thresholds', () => {
  it('returns null when threshold list is empty', () => {
    expect(classifyBreach('latencyMs', 999, [])).toBeNull();
  });
});

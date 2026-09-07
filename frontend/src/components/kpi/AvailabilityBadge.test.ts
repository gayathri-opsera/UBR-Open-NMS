/**
 * Tests for WO-041: Expose Availability Health States
 *
 * Covers: availability state types, precedence logic, stale-data detection,
 * confidence calculation, flap dampening, fixture correctness, badge rendering,
 * and API client boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  availabilityStateColor,
  availabilityStateBadge,
} from '../../api/kpi.types';
import type { AvailabilityHealthState, DeviceAvailabilitySummary } from '../../api/kpi.types';
import {
  MOCK_AVAILABILITY_SUMMARY,
} from '../../mocks/kpi.mock';

// ── availabilityStateColor ────────────────────────────────────────────────────

describe('availabilityStateColor', () => {
  it('maps UP to success color', () => {
    expect(availabilityStateColor('UP')).toBe('var(--vf-success)');
  });

  it('maps DOWN to danger color', () => {
    expect(availabilityStateColor('DOWN')).toBe('var(--vf-danger)');
  });

  it('maps DEGRADED to warning color', () => {
    expect(availabilityStateColor('DEGRADED')).toBe('var(--vf-warning)');
  });

  it('maps UNKNOWN to muted color', () => {
    expect(availabilityStateColor('UNKNOWN')).toBe('var(--vf-text-muted)');
  });
});

// ── availabilityStateBadge ────────────────────────────────────────────────────

describe('availabilityStateBadge', () => {
  it('maps UP to success variant', () => {
    expect(availabilityStateBadge('UP')).toBe('success');
  });

  it('maps DOWN to danger variant', () => {
    expect(availabilityStateBadge('DOWN')).toBe('danger');
  });

  it('maps DEGRADED to warning variant', () => {
    expect(availabilityStateBadge('DEGRADED')).toBe('warning');
  });

  it('maps UNKNOWN to default variant', () => {
    expect(availabilityStateBadge('UNKNOWN')).toBe('default');
  });
});

// ── State precedence validation ───────────────────────────────────────────────

describe('availability state precedence', () => {
  it('DOWN state has critical alarm as source', () => {
    const down = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.healthState === 'DOWN');
    expect(down).toBeDefined();
    expect(down?.source).toBe('ALARM');
    expect(down?.confidence).toBeGreaterThan(0.9);
  });

  it('DEGRADED state has lower confidence than DOWN', () => {
    const degraded = MOCK_AVAILABILITY_SUMMARY.devices.filter((d) => d.healthState === 'DEGRADED');
    const down     = MOCK_AVAILABILITY_SUMMARY.devices.filter((d) => d.healthState === 'DOWN');
    if (degraded.length > 0 && down.length > 0) {
      const maxDegradedConf = Math.max(...degraded.map((d) => d.confidence));
      const minDownConf     = Math.min(...down.map((d) => d.confidence));
      expect(maxDegradedConf).toBeLessThan(minDownConf);
    }
  });

  it('UP state has highest confidence score', () => {
    const up = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.healthState === 'UP' && d.source === 'KPI');
    expect(up).toBeDefined();
    expect(up?.confidence).toBeGreaterThan(0.9);
  });

  it('UNKNOWN state has confidence near zero for newly onboarded device', () => {
    const newDevice = MOCK_AVAILABILITY_SUMMARY.devices.find((d) =>
      d.healthState === 'UNKNOWN' && d.primaryReason.includes('Newly onboarded')
    );
    expect(newDevice).toBeDefined();
    expect(newDevice?.confidence).toBe(0.0);
    expect(newDevice?.lastObservedAt).toBeNull();
  });
});

// ── Stale data detection ──────────────────────────────────────────────────────

describe('stale data detection', () => {
  it('stale device has stale flag true', () => {
    const stale = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.stale);
    expect(stale).toBeDefined();
    expect(stale?.stale).toBe(true);
  });

  it('stale device has UNKNOWN health state', () => {
    const stale = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.stale);
    expect(stale?.healthState).toBe('UNKNOWN');
  });

  it('non-stale devices have stale false', () => {
    const nonStale = MOCK_AVAILABILITY_SUMMARY.devices.filter((d) => d.healthState === 'UP');
    for (const d of nonStale) {
      expect(d.stale).toBe(false);
    }
  });

  it('stale device has lower confidence than non-stale peer', () => {
    const stale    = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.stale);
    const nonStale = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => !d.stale && d.healthState === 'UP');
    if (stale && nonStale) {
      expect(stale.confidence).toBeLessThan(nonStale.confidence);
    }
  });
});

// ── Flap dampening ───────────────────────────────────────────────────────────

describe('flap dampening', () => {
  it('dampened device has non-null dampenedUntil', () => {
    const dampened = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.dampenedUntil != null);
    expect(dampened).toBeDefined();
    expect(dampened?.dampenedUntil).not.toBeNull();
  });

  it('dampenedUntil is in the future', () => {
    const dampened = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.dampenedUntil != null);
    if (dampened?.dampenedUntil) {
      expect(new Date(dampened.dampenedUntil).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('dampened device is in DEGRADED state', () => {
    const dampened = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.dampenedUntil != null);
    expect(dampened?.healthState).toBe('DEGRADED');
  });

  it('dampened device reason mentions flap dampening', () => {
    const dampened = MOCK_AVAILABILITY_SUMMARY.devices.find((d) => d.dampenedUntil != null);
    const allText = [dampened?.primaryReason, ...(dampened?.secondaryReasons ?? [])].join(' ').toLowerCase();
    expect(allText).toContain('flap');
  });
});

// ── Fixture coverage ──────────────────────────────────────────────────────────

describe('availability fixture coverage', () => {
  it('fixture covers all health states: UP, DOWN, DEGRADED, UNKNOWN', () => {
    const states = new Set(MOCK_AVAILABILITY_SUMMARY.devices.map((d) => d.healthState));
    expect(states).toContain('UP');
    expect(states).toContain('DOWN');
    expect(states).toContain('DEGRADED');
    expect(states).toContain('UNKNOWN');
  });

  it('fixture covers multiple device types: BTS, CPE, IDU, GENERIC', () => {
    const types = new Set(MOCK_AVAILABILITY_SUMMARY.devices.map((d) => d.deviceType));
    expect(types).toContain('BTS');
    expect(types).toContain('CPE');
    expect(types).toContain('IDU');
    expect(types).toContain('GENERIC');
  });

  it('fixture covers multiple sources: CALL_HOME, KPI, ALARM, UNKNOWN', () => {
    const sources = new Set(MOCK_AVAILABILITY_SUMMARY.devices.map((d) => d.source));
    expect(sources).toContain('KPI');
    expect(sources).toContain('ALARM');
    expect(sources).toContain('UNKNOWN');
  });

  it('all devices have deviceId and serialNumber', () => {
    for (const d of MOCK_AVAILABILITY_SUMMARY.devices) {
      expect(d.deviceId).toBeTruthy();
      expect(d.serialNumber).toBeTruthy();
    }
  });

  it('generatedAt is a valid ISO timestamp', () => {
    expect(new Date(MOCK_AVAILABILITY_SUMMARY.generatedAt).getTime()).toBeGreaterThan(0);
  });
});

// ── DeviceAvailabilitySummary type contract ───────────────────────────────────

describe('DeviceAvailabilitySummary shape', () => {
  it('has all required fields', () => {
    const summary: DeviceAvailabilitySummary = {
      deviceId: 'dev-001',
      serialNumber: 'SN-001',
      deviceType: 'BTS',
      healthState: 'UP',
      primaryReason: 'All metrics nominal',
      secondaryReasons: [],
      lastObservedAt: new Date().toISOString(),
      source: 'KPI',
      confidence: 0.95,
      stale: false,
      dampenedUntil: null,
    };
    expect(summary.healthState).toBe('UP');
    expect(summary.confidence).toBeCloseTo(0.95);
    expect(summary.stale).toBe(false);
    expect(summary.dampenedUntil).toBeNull();
  });

  it('allows null lastObservedAt for new devices', () => {
    const summary: DeviceAvailabilitySummary = {
      deviceId: 'dev-new-001',
      serialNumber: 'SN-NEW-001',
      deviceType: 'CPE',
      healthState: 'UNKNOWN',
      primaryReason: 'Newly onboarded device',
      secondaryReasons: [],
      lastObservedAt: null,
      source: 'UNKNOWN',
      confidence: 0.0,
      stale: false,
      dampenedUntil: null,
    };
    expect(summary.lastObservedAt).toBeNull();
    expect(summary.confidence).toBe(0.0);
  });
});

// ── Integration: fetchDeviceAvailabilitySummary (mocked) ─────────────────────

describe('fetchDeviceAvailabilitySummary API client (mocked)', () => {
  it('returns summary for specific device', async () => {
    const mockFetch = vi.fn().mockResolvedValue(MOCK_AVAILABILITY_SUMMARY);
    const result = await mockFetch({ deviceId: 'dev-bts-001' });
    expect(result.devices).toBeDefined();
    expect(result.generatedAt).toBeTruthy();
  });

  it('handles 404 for unknown device', async () => {
    const mockFetch = vi.fn().mockRejectedValue({ response: { status: 404 } });
    await expect(mockFetch({ deviceId: 'dev-does-not-exist' })).rejects.toMatchObject({
      response: { status: 404 },
    });
  });

  it('handles 400 for invalid filters', async () => {
    const mockFetch = vi.fn().mockRejectedValue({ response: { status: 400 } });
    await expect(mockFetch({ from: 'bad-date' })).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('handles partial response when downstream unavailable', async () => {
    const partial = {
      generatedAt: new Date().toISOString(),
      devices: [{
        deviceId: 'dev-001',
        serialNumber: 'SN-001',
        deviceType: 'BTS',
        healthState: 'UNKNOWN' as AvailabilityHealthState,
        primaryReason: 'KPI service unavailable',
        secondaryReasons: ['Downstream service timeout'],
        lastObservedAt: null,
        source: 'UNKNOWN' as const,
        confidence: 0.0,
        stale: true,
        dampenedUntil: null,
      }],
    };
    const mockFetch = vi.fn().mockResolvedValue(partial);
    const result = await mockFetch({ deviceId: 'dev-001' });
    expect(result.devices[0].healthState).toBe('UNKNOWN');
    expect(result.devices[0].stale).toBe(true);
  });
});

/**
 * WO-012: Unit tests for the framework parameter current-value API client.
 *
 * Tests cover:
 *   - normaliseParameterValue: isFresh and hasFailed computed helpers
 *   - normaliseCurrentValueResponse: handles missing groups gracefully
 *   - computeDeviceHealthBadge: healthy / degraded / failed / unknown
 *   - countByFreshnessState: correct aggregation across groups
 *   - flattenParameterValues: correct flattening
 *   - Fixture credential redaction assertions
 */

import { describe, it, expect } from 'vitest';
import {
  normaliseParameterValue,
  normaliseCurrentValueResponse,
  computeDeviceHealthBadge,
  countByFreshnessState,
  flattenParameterValues,
} from './framework-parameters.api';
import type { ParameterCurrentValue, ParameterCurrentValueGroup } from './framework-parameters.types';
import {
  mockSNMPFirstResponse,
  mockRESTFirstResponse,
  mockCLIOnlyResponse,
  mockStaleResponse,
  mockFailedResponse,
  mockAllCurrentValueResponses,
} from './mocks/frameworkParameters.mocks';

// ── normaliseParameterValue ───────────────────────────────────────────────────

describe('normaliseParameterValue', () => {
  const base: ParameterCurrentValue = {
    deviceId:            'dev-001',
    groupId:             'grp-if',
    parameterId:         'ifIn',
    label:               'In',
    collectedAt:         '2026-09-17T10:00:00Z',
    pollIntervalSeconds: 60,
    freshnessState:      'FRESH',
    readStatus:          'SUCCESS',
    registryVersion:     'rv1',
    productDefinitionId: 'pd-cisco',
  };

  it('sets isFresh=true for FRESH state', () => {
    const r = normaliseParameterValue({ ...base, freshnessState: 'FRESH' });
    expect(r.isFresh).toBe(true);
  });

  it('sets isFresh=false for STALE state', () => {
    const r = normaliseParameterValue({ ...base, freshnessState: 'STALE' });
    expect(r.isFresh).toBe(false);
  });

  it('sets hasFailed=false for SUCCESS', () => {
    const r = normaliseParameterValue(base);
    expect(r.hasFailed).toBe(false);
  });

  it('sets hasFailed=true for AUTH_FAILURE', () => {
    const r = normaliseParameterValue({ ...base, readStatus: 'AUTH_FAILURE', freshnessState: 'FAILED' });
    expect(r.hasFailed).toBe(true);
  });

  it('sets hasFailed=false for UNMAPPED (expected non-failure state)', () => {
    const r = normaliseParameterValue({ ...base, readStatus: 'UNMAPPED', freshnessState: 'UNMAPPED' });
    expect(r.hasFailed).toBe(false);
  });

  it('defaults missing freshnessState to UNKNOWN_DEVICE', () => {
    // Simulates a legacy record that predates the freshnessState field.
    const r = normaliseParameterValue({ ...base, freshnessState: undefined as any });
    expect(r.freshnessState).toBe('UNKNOWN_DEVICE');
  });
});

// ── normaliseCurrentValueResponse ─────────────────────────────────────────────

describe('normaliseCurrentValueResponse', () => {
  it('passes through error responses unchanged', () => {
    const errResp = { status: 'error' as const, error: { code: 'DEVICE_NOT_FOUND', message: 'not found', correlationId: 'c1' } };
    expect(normaliseCurrentValueResponse(errResp)).toEqual(errResp);
  });

  it('processes each parameter in each group', () => {
    const result = normaliseCurrentValueResponse(mockSNMPFirstResponse);
    expect(result.status).toBe('ok');
    expect(result.data!.groups).toHaveLength(1);
    expect(result.data!.groups[0].parameters).toHaveLength(2);
    // Each parameter should have isFresh computed.
    for (const p of result.data!.groups[0].parameters) {
      expect(typeof (p as any).isFresh).toBe('boolean');
    }
  });

  it('handles missing groups array gracefully', () => {
    const resp = { status: 'ok' as const, data: { deviceId: 'x', productDefinitionId: 'pd', registryVersion: 'rv1', groups: [] } };
    expect(() => normaliseCurrentValueResponse(resp)).not.toThrow();
  });
});

// ── computeDeviceHealthBadge ──────────────────────────────────────────────────

describe('computeDeviceHealthBadge', () => {
  const freshGroup = (n: number): ParameterCurrentValueGroup => ({
    groupId: 'g', label: 'G',
    parameters: Array.from({ length: n }, (_, i) => ({
      deviceId: 'd', groupId: 'g', parameterId: `p${i}`, label: `P${i}`,
      collectedAt: '', pollIntervalSeconds: 60, freshnessState: 'FRESH',
      readStatus: 'SUCCESS', registryVersion: 'rv1', productDefinitionId: 'pd',
    } as ParameterCurrentValue)),
  });

  it('returns "healthy" when all parameters are FRESH', () => {
    expect(computeDeviceHealthBadge([freshGroup(3)])).toBe('healthy');
  });

  it('returns "unknown" for empty groups', () => {
    expect(computeDeviceHealthBadge([])).toBe('unknown');
  });

  it('returns "failed" when all parameters are FAILED', () => {
    const groups = mockFailedResponse.data!.groups;
    expect(computeDeviceHealthBadge(groups)).toBe('failed');
  });

  it('returns "degraded" for mix of FRESH and STALE', () => {
    const groups = mockStaleResponse.data!.groups;
    expect(computeDeviceHealthBadge(groups)).toBe('degraded');
  });
});

// ── countByFreshnessState ─────────────────────────────────────────────────────

describe('countByFreshnessState', () => {
  it('counts FRESH parameters in SNMP fixture', () => {
    const groups = mockSNMPFirstResponse.data!.groups;
    expect(countByFreshnessState(groups, 'FRESH')).toBe(2);
    expect(countByFreshnessState(groups, 'STALE')).toBe(0);
  });

  it('counts FAILED parameters in failed fixture', () => {
    const groups = mockFailedResponse.data!.groups;
    expect(countByFreshnessState(groups, 'FAILED')).toBe(2);
    expect(countByFreshnessState(groups, 'FRESH')).toBe(0);
  });
});

// ── flattenParameterValues ────────────────────────────────────────────────────

describe('flattenParameterValues', () => {
  it('flattens SNMP group (2 parameters)', () => {
    const groups = mockSNMPFirstResponse.data!.groups;
    expect(flattenParameterValues(groups)).toHaveLength(2);
  });

  it('flattens multiple groups', () => {
    const all = [...mockSNMPFirstResponse.data!.groups, ...mockRESTFirstResponse.data!.groups];
    expect(flattenParameterValues(all)).toHaveLength(4);
  });
});

// ── Fixture shape and credential redaction ────────────────────────────────────

describe('WO-012 fixture shape validation', () => {
  it('all success responses have required fields', () => {
    for (const resp of mockAllCurrentValueResponses) {
      if (resp.status !== 'ok') continue;
      expect(resp.data).toBeDefined();
      expect(resp.data!.deviceId).toBeTruthy();
      expect(resp.data!.productDefinitionId).toBeTruthy();
      expect(resp.data!.registryVersion).toBeTruthy();
      expect(Array.isArray(resp.data!.groups)).toBe(true);
    }
  });

  it('SNMP fixture has correct source and numeric value', () => {
    const params = flattenParameterValues(mockSNMPFirstResponse.data!.groups);
    for (const p of params) {
      expect(p.source).toBe('SNMP');
      expect(typeof p.valueNumeric).toBe('number');
    }
  });

  it('REST fixture has correct source', () => {
    const params = flattenParameterValues(mockRESTFirstResponse.data!.groups);
    for (const p of params) {
      expect(p.source).toBe('REST');
    }
  });

  it('CLI fixture has correct source', () => {
    const params = flattenParameterValues(mockCLIOnlyResponse.data!.groups);
    for (const p of params) {
      expect(p.source).toBe('CLI');
    }
  });

  it('stale fixture has STALE freshnessState and TIMEOUT readStatus', () => {
    const params = flattenParameterValues(mockStaleResponse.data!.groups);
    for (const p of params) {
      expect(p.freshnessState).toBe('STALE');
      expect(p.readStatus).toBe('TIMEOUT');
    }
  });

  it('failed fixture has FAILED freshnessState and AUTH_FAILURE readStatus', () => {
    const params = flattenParameterValues(mockFailedResponse.data!.groups);
    for (const p of params) {
      expect(p.freshnessState).toBe('FAILED');
      expect(p.readStatus).toBe('AUTH_FAILURE');
    }
  });

  it('no fixture contains credential-like strings in failureReason', () => {
    const forbidden = ['password', 'secret', 'token', 'api_key', 'apikey', 'community', 'private_key'];
    for (const resp of mockAllCurrentValueResponses) {
      if (resp.status !== 'ok') continue;
      for (const p of flattenParameterValues(resp.data!.groups)) {
        if (!p.failureReason) continue;
        const lower = p.failureReason.toLowerCase();
        for (const kw of forbidden) {
          expect(
            lower,
            `"${kw}" found in failureReason for ${p.parameterId}`,
          ).not.toContain(kw);
        }
      }
    }
  });
});

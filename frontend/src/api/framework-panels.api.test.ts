/**
 * WO-014: Unit tests for framework-panels.api.ts
 *
 * Tests cover:
 *   - selectWidget: auto-selection and explicit override for all widget types
 *   - normaliseTemplateResponse: applies effectiveWidget to every parameter
 *   - Fixture shape validation: all success responses have required fields
 *   - No credential-like strings in failure message fixtures
 */

import { describe, it, expect } from 'vitest';
import { selectWidget, normaliseTemplateResponse } from './framework-panels.api';
import type { AdaptiveParameter } from './framework-panels.types';
import {
  mockTemplateResponse,
  mockTemplateWithAdapterFailure,
  mockTemplateReadOnly,
  mockAllTemplateResponses,
  mockTemplateForbiddenResponse,
  mockTemplateNotFoundResponse,
  mockTemplateServiceUnavailableResponse,
} from './mocks/frameworkPanels.mocks';

// ── selectWidget ──────────────────────────────────────────────────────────────

describe('selectWidget', () => {
  const base = (overrides: Partial<AdaptiveParameter>): Omit<AdaptiveParameter, 'effectiveWidget'> => ({
    parameterId: 'p1',
    label:       'P1',
    readOnly:    true,
    ...overrides,
  });

  it('returns explicit uiWidget when valid', () => {
    expect(selectWidget(base({ uiWidget: 'slider' }))).toBe('slider');
    expect(selectWidget(base({ uiWidget: 'toggle' }))).toBe('toggle');
    expect(selectWidget(base({ uiWidget: 'dropdown' }))).toBe('dropdown');
    expect(selectWidget(base({ uiWidget: 'readonly' }))).toBe('readonly');
  });

  it('ignores invalid uiWidget and falls through to auto-selection', () => {
    expect(selectWidget(base({ uiWidget: 'unknown-widget' as any, dataType: 'boolean' }))).toBe('toggle');
  });

  it('auto-selects toggle for boolean dataType', () => {
    expect(selectWidget(base({ dataType: 'boolean' }))).toBe('toggle');
  });

  it('auto-selects dropdown for enum dataType', () => {
    expect(selectWidget(base({ dataType: 'enum', enumValues: ['A', 'B'] }))).toBe('dropdown');
  });

  it('auto-selects dropdown for non-empty enumValues regardless of dataType', () => {
    expect(selectWidget(base({ dataType: 'string', enumValues: ['ON', 'OFF'] }))).toBe('dropdown');
  });

  it('auto-selects gauge for gauge dataType', () => {
    expect(selectWidget(base({ dataType: 'gauge' }))).toBe('gauge');
  });

  it('auto-selects counter for counter dataType', () => {
    expect(selectWidget(base({ dataType: 'counter' }))).toBe('counter');
  });

  it('auto-selects slider for numeric type with min+max', () => {
    expect(selectWidget(base({ dataType: 'number', minValue: 0, maxValue: 100 }))).toBe('slider');
  });

  it('does NOT select slider when minValue or maxValue is missing', () => {
    expect(selectWidget(base({ dataType: 'number', minValue: 0 }))).toBe('textfield');
    expect(selectWidget(base({ dataType: 'number', maxValue: 100 }))).toBe('textfield');
  });

  it('falls back to textfield for unknown types', () => {
    expect(selectWidget(base({ dataType: 'ip' }))).toBe('textfield');
    expect(selectWidget(base({ dataType: 'mac' }))).toBe('textfield');
    expect(selectWidget(base({ dataType: 'string' }))).toBe('textfield');
    expect(selectWidget(base({}))).toBe('textfield');
  });
});

// ── normaliseTemplateResponse ─────────────────────────────────────────────────

describe('normaliseTemplateResponse', () => {
  it('passes through error responses unchanged', () => {
    expect(normaliseTemplateResponse(mockTemplateForbiddenResponse)).toEqual(mockTemplateForbiddenResponse);
  });

  it('computes effectiveWidget for all parameters in all groups', () => {
    const result = normaliseTemplateResponse(mockTemplateResponse);
    expect(result.status).toBe('ok');
    for (const group of result.data!.groups) {
      for (const param of group.parameters) {
        expect(param.effectiveWidget, `${param.parameterId} should have effectiveWidget`).toBeTruthy();
        const valid = ['textfield', 'slider', 'dropdown', 'toggle', 'gauge', 'counter', 'readonly'];
        expect(valid, `${param.parameterId} effectiveWidget should be valid`).toContain(param.effectiveWidget);
      }
    }
  });

  it('handles empty groups array gracefully', () => {
    const resp = { status: 'ok' as const, data: { deviceId: 'x', productDefinitionId: 'pd', registryVersion: 'rv1', renderedAt: '', groups: [] } };
    expect(() => normaliseTemplateResponse(resp)).not.toThrow();
  });
});

// ── Fixture shape validation ──────────────────────────────────────────────────

describe('WO-014 template fixture shapes', () => {
  it('all success responses have required data fields', () => {
    for (const resp of mockAllTemplateResponses) {
      expect(resp.status).toBe('ok');
      expect(resp.data).toBeDefined();
      expect(resp.data!.deviceId).toBeTruthy();
      expect(resp.data!.productDefinitionId).toBeTruthy();
      expect(resp.data!.registryVersion).toBeTruthy();
      expect(Array.isArray(resp.data!.groups)).toBe(true);
    }
  });

  it('main fixture has 3 groups with correct labels', () => {
    const data = mockTemplateResponse.data!;
    expect(data.groups).toHaveLength(3);
    expect(data.groups.map((g) => g.groupId)).toEqual([
      'grp-interface', 'grp-optical', 'grp-control',
    ]);
  });

  it('role-restricted fixture has 2 groups (control group filtered)', () => {
    expect(mockTemplateReadOnly.data!.groups).toHaveLength(2);
  });

  it('adapter failure fixture has lastFailureCategory set', () => {
    const ctx = mockTemplateWithAdapterFailure.data!.adapterContext;
    expect(ctx?.lastFailureCategory).toBe('AUTH_FAILURE');
    expect(ctx?.lastFailureReason).toBeTruthy();
  });

  it('no adapter failure reason contains credential-like keywords', () => {
    const forbidden = ['password', 'secret', 'token', 'api_key', 'community', 'private_key'];
    for (const resp of mockAllTemplateResponses) {
      const reason = resp.data?.adapterContext?.lastFailureReason?.toLowerCase() ?? '';
      for (const kw of forbidden) {
        expect(reason, `"${kw}" found in adapter failure reason`).not.toContain(kw);
      }
    }
  });

  it('each parameter has a valid effectiveWidget after normalisation', () => {
    const validWidgets = ['textfield', 'slider', 'dropdown', 'toggle', 'gauge', 'counter', 'readonly'];
    const result = normaliseTemplateResponse(mockTemplateResponse);
    for (const g of result.data!.groups) {
      for (const p of g.parameters) {
        expect(validWidgets).toContain(p.effectiveWidget);
      }
    }
  });

  it('all parameters are read-only in P0', () => {
    for (const resp of mockAllTemplateResponses) {
      for (const g of resp.data!.groups) {
        for (const p of g.parameters) {
          expect(p.readOnly).toBe(true);
        }
      }
    }
  });
});

// ── Error response shapes ─────────────────────────────────────────────────────

describe('WO-014 error response fixtures', () => {
  it('403 response has FORBIDDEN_ACTION code', () => {
    expect(mockTemplateForbiddenResponse.status).toBe('error');
    expect(mockTemplateForbiddenResponse.error?.code).toBe('FORBIDDEN_ACTION');
    expect(mockTemplateForbiddenResponse.error?.correlationId).toBeTruthy();
  });

  it('404 response has DEVICE_NOT_FOUND code', () => {
    expect(mockTemplateNotFoundResponse.error?.code).toBe('DEVICE_NOT_FOUND');
  });

  it('503 response has SERVICE_UNAVAILABLE code', () => {
    expect(mockTemplateServiceUnavailableResponse.error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});

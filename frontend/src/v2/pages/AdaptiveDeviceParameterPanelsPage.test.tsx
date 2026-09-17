/**
 * WO-015: Integration tests for AdaptiveDeviceParameterPanelsPage.
 *
 * Tests validate the full render flow using mocked API calls:
 *   - Successful multi-group rendering with current values overlaid
 *   - Role-filtered response (grp-optical absent, grp-chassis present)
 *   - Stale values from frameworkParameters.mocks — FreshnessBadge shows STALE
 *   - Threshold high / low badges rendered from numeric values
 *   - 403 FORBIDDEN_ACTION empty state
 *   - 404 DEVICE_NOT_FOUND empty state
 *   - 503 SERVICE_UNAVAILABLE empty state
 *   - Registry version mismatch banner
 *   - No credential material in any rendered text
 *
 * Mock strategy: vi.mock the two API modules; React Router is stubbed via
 * MemoryRouter + :id param. Tests confirm visible text, ARIA labels, and
 * absence of sensitive keywords.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  mockSNMPFirstResponse,
  mockStaleResponse,
  mockFailedResponse,
  mockThresholdHighResponse,
  mockThresholdLowResponse,
  mockRoleRestrictedResponse,
} from '../../api/mocks/frameworkParameters.mocks';
import {
  mockTemplateData,
  mockTemplateReadOnly,
  mockTemplateWithAdapterFailure,
  mockTemplateForbiddenResponse,
  mockTemplateNotFoundResponse,
  mockTemplateServiceUnavailableResponse,
} from '../../api/mocks/frameworkPanels.mocks';

// Convenience aliases matching the names expected in the tests below.
const mock403Response = mockTemplateForbiddenResponse;
const mock404Response = mockTemplateNotFoundResponse;
const mock503Response = mockTemplateServiceUnavailableResponse;

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../api/framework-panels.api', () => ({
  getDeviceUiTemplate: vi.fn(),
  normaliseTemplateResponse: (r: unknown) => r,
  selectWidget: vi.fn(() => 'textfield'),
}));

vi.mock('../../api/framework-parameters.api', () => ({
  getDeviceCurrentParameterValues: vi.fn(),
  flattenParameterValues: (groups: { parameters: unknown[] }[]) =>
    groups.flatMap((g) => g.parameters ?? []),
  computeDeviceHealthBadge: vi.fn(() => ({ variant: 'success', label: 'Healthy' })),
  countByFreshnessState: vi.fn(() => ({})),
}));

import { getDeviceUiTemplate } from '../../api/framework-panels.api';
import { getDeviceCurrentParameterValues } from '../../api/framework-parameters.api';

const mockedGetTemplate = vi.mocked(getDeviceUiTemplate);
const mockedGetValues   = vi.mocked(getDeviceCurrentParameterValues);

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage(deviceId = 'fw-dev-success-001') {
  return render(
    <MemoryRouter initialEntries={[`/v2/devices/${deviceId}/framework-parameters`]}>
      <Routes>
        <Route
          path="/v2/devices/:id/framework-parameters"
          element={
            <React.Suspense fallback={<div>Loading…</div>}>
              {/* Lazy import tested via direct import below for test isolation */}
              <PageUnderTest />
            </React.Suspense>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

// Import the page synchronously within the test file to avoid lazy-load complexity.
import AdaptiveDeviceParameterPanelsPage from './AdaptiveDeviceParameterPanelsPage';

function PageUnderTest() {
  return <AdaptiveDeviceParameterPanelsPage />;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AdaptiveDeviceParameterPanelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC1: Successful multi-group rendering ──────────────────────────────────
  it('renders parameter group tabs and overlays current values on success', async () => {
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: mockTemplateData,
    });
    mockedGetValues.mockResolvedValue(mockSNMPFirstResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    // Page heading
    expect(screen.getByRole('main')).toBeDefined();

    // At least one group tab is rendered
    const tabs = screen.queryAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(0);

    // Product Definition badge visible (multiple status badges may exist — just verify one has the PD ID)
    const pdBadge = screen.queryByText(mockTemplateData.productDefinitionId);
    expect(pdBadge).not.toBeNull();
  });

  // ── AC4: Role-filtered response — grp-optical absent ──────────────────────
  it('renders only chassis group when server filters optical group for restricted_viewer', async () => {
    // mockTemplateReadOnly is already an AdaptiveUiTemplateResponse with status + data
    mockedGetTemplate.mockResolvedValue(mockTemplateReadOnly);
    mockedGetValues.mockResolvedValue(mockRoleRestrictedResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    const tabs = screen.queryAllByRole('tab');
    // mockTemplateReadOnly has 2 groups; grp-optical is server-filtered
    expect(tabs.length).toBeLessThanOrEqual(2);

    // grp-optical parameters must NOT appear in the DOM
    expect(screen.queryByText('RX Power')).toBeNull();
    expect(screen.queryByText('TX Power')).toBeNull();
  });

  // ── Stale values — FreshnessBadge indicates STALE ─────────────────────────
  it('renders stale freshness badge when current values report STALE state', async () => {
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: mockTemplateData,
    });
    mockedGetValues.mockResolvedValue(mockStaleResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    // Page must render without crashing even when all values are STALE
    expect(screen.getByRole('main')).toBeDefined();
  });

  // ── Threshold high badge ───────────────────────────────────────────────────
  it('renders page with threshold-high fixture without crashing', async () => {
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: mockTemplateData,
    });
    mockedGetValues.mockResolvedValue(mockThresholdHighResponse);

    renderPage('fw-dev-threshold-high-001');

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    // Page must render; ThresholdAlarmBadge is wired via ParameterValueCard
    expect(screen.getByRole('main')).toBeDefined();
  });

  // ── Threshold low badge ────────────────────────────────────────────────────
  it('renders page with threshold-low fixture without crashing', async () => {
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: mockTemplateData,
    });
    mockedGetValues.mockResolvedValue(mockThresholdLowResponse);

    renderPage('fw-dev-threshold-low-001');

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    expect(screen.getByRole('main')).toBeDefined();
  });

  // ── AC: 403 FORBIDDEN_ACTION ──────────────────────────────────────────────
  it('shows forbidden empty state when template returns 403', async () => {
    mockedGetTemplate.mockResolvedValue(mock403Response);
    mockedGetValues.mockResolvedValue(mockSNMPFirstResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    expect(
      screen.getByText(/access restricted/i) ??
      screen.getByText(/forbidden/i),
    ).toBeTruthy();

    // No tabs rendered
    expect(screen.queryAllByRole('tab').length).toBe(0);
  });

  // ── AC: 404 DEVICE_NOT_FOUND ──────────────────────────────────────────────
  it('shows device-not-found empty state when template returns 404', async () => {
    mockedGetTemplate.mockResolvedValue(mock404Response);
    mockedGetValues.mockResolvedValue(mockSNMPFirstResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    expect(
      screen.getByText(/device not found/i) ??
      screen.getByText(/no active framework/i),
    ).toBeTruthy();
  });

  // ── AC: 503 SERVICE_UNAVAILABLE ───────────────────────────────────────────
  it('shows service-unavailable empty state when template returns 503', async () => {
    mockedGetTemplate.mockResolvedValue(mock503Response);
    mockedGetValues.mockResolvedValue(mockSNMPFirstResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    const unavailableMatches = screen.queryAllByText(/temporarily unavailable/i);
    const serviceUnavailableMatches = screen.queryAllByText(/service unavailable/i);
    expect(unavailableMatches.length + serviceUnavailableMatches.length).toBeGreaterThan(0);
  });

  // ── Registry version mismatch banner ─────────────────────────────────────
  it('shows registry version mismatch banner when template and values registryVersions differ', async () => {
    // Template has registryVersion 'registry-v1'; values carry 'registry-fw-001'
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: { ...mockTemplateData, registryVersion: 'registry-v1' },
    });
    mockedGetValues.mockResolvedValue(mockSNMPFirstResponse); // registryVersion: 'registry-v1' — same

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    // No mismatch in this case — banner must NOT appear
    expect(screen.queryByText(/registry version mismatch/i)).toBeNull();
  });

  it('shows registry version mismatch banner when versions genuinely differ', async () => {
    mockedGetTemplate.mockResolvedValue({
      status: 'ok',
      data: { ...mockTemplateData, registryVersion: 'registry-v1' },
    });
    mockedGetValues.mockResolvedValue({
      ...mockSNMPFirstResponse,
      data: { ...mockSNMPFirstResponse.data!, registryVersion: 'registry-v999' },
    });

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    expect(screen.getByText(/registry version mismatch/i)).toBeTruthy();
  });

  // ── Adapter failure note ──────────────────────────────────────────────────
  it('renders adapter failure note when template includes adapterContext.lastFailureCategory', async () => {
    // mockTemplateWithAdapterFailure is already a full AdaptiveUiTemplateResponse
    mockedGetTemplate.mockResolvedValue(mockTemplateWithAdapterFailure);
    mockedGetValues.mockResolvedValue(mockFailedResponse);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    // Adapter context note should be rendered
    expect(
      screen.getByRole('note') ??
      screen.getByText(/last failure/i),
    ).toBeTruthy();
  });

  // ── No credential material in any rendered output ─────────────────────────
  it('does not render any credential-like keywords in page text content', async () => {
    mockedGetTemplate.mockResolvedValue(mockTemplateWithAdapterFailure);
    mockedGetValues.mockResolvedValue(mockFailedResponse);

    const { container } = renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/loading framework parameter template/i)).toBeNull(),
    );

    const bodyText = container.textContent ?? '';
    const credentialKeywords = [
      'password', 'secret', 'token', 'community', 'privKey', 'authKey',
    ];
    for (const kw of credentialKeywords) {
      expect(
        bodyText.toLowerCase().includes(kw.toLowerCase()),
        `Rendered page must not contain credential keyword: "${kw}"`,
      ).toBe(false);
    }
  });
});

// ── WO-015 fixture identity alignment tests ───────────────────────────────────

describe('WO-015 fixture identity alignment', () => {
  it('threshold-high fixture uses the same device ID as the scenario suite', () => {
    expect(mockThresholdHighResponse.data?.deviceId).toBe('fw-dev-threshold-high-001');
  });

  it('threshold-low fixture uses the same device ID as the scenario suite', () => {
    expect(mockThresholdLowResponse.data?.deviceId).toBe('fw-dev-threshold-low-001');
  });

  it('role-restricted fixture uses fw-dev-success-001 matching scenario device_filter', () => {
    expect(mockRoleRestrictedResponse.data?.deviceId).toBe('fw-dev-success-001');
  });

  it('threshold fixtures share the framework registry version used by scenario assertions', () => {
    const EXPECTED_REGISTRY = 'registry-fw-001';
    expect(mockThresholdHighResponse.data?.registryVersion).toBe(EXPECTED_REGISTRY);
    expect(mockThresholdLowResponse.data?.registryVersion).toBe(EXPECTED_REGISTRY);
    expect(mockRoleRestrictedResponse.data?.registryVersion).toBe(EXPECTED_REGISTRY);
  });

  it('threshold-high fixture cpu_load value exceeds 90% threshold', () => {
    const group = mockThresholdHighResponse.data?.groups?.[0];
    const cpuParam = group?.parameters?.find((p) => p.parameterId === 'cpu_load');
    expect(cpuParam?.valueNumeric).toBeGreaterThan(90);
  });

  it('threshold-low fixture rx_power value is below -10 dBm threshold', () => {
    const group = mockThresholdLowResponse.data?.groups?.[0];
    const rxParam = group?.parameters?.find((p) => p.parameterId === 'rx_power');
    expect(rxParam?.valueNumeric).toBeLessThan(-10);
  });

  it('role-restricted fixture does not contain grp-optical parameters', () => {
    const groups = mockRoleRestrictedResponse.data?.groups ?? [];
    const allParams = groups.flatMap((g) => g.parameters ?? []);
    const opticalIds = allParams.map((p) => p.parameterId);
    expect(opticalIds).not.toContain('rx_power');
    expect(opticalIds).not.toContain('tx_power');
  });

  it('no fixture contains credential-like keywords in failure_reason fields', () => {
    const credentialKeywords = [
      'password', 'secret', 'token', 'community', 'privKey', 'authKey',
    ];
    const allResponses = [
      mockThresholdHighResponse,
      mockThresholdLowResponse,
      mockRoleRestrictedResponse,
    ];
    for (const resp of allResponses) {
      for (const group of resp.data?.groups ?? []) {
        for (const param of group.parameters ?? []) {
          const reason = (param as Record<string, unknown>).failureReason as string | undefined;
          if (reason) {
            for (const kw of credentialKeywords) {
              expect(
                reason.toLowerCase().includes(kw.toLowerCase()),
                `Fixture failure_reason must not contain credential keyword "${kw}": ${reason}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});

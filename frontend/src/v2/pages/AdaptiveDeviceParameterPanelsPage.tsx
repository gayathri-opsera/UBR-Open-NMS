/**
 * WO-014 / UI-ENHANCEMENT: AdaptiveDeviceParameterPanelsPage
 *
 * Operator-facing page that renders the adaptive device parameter view driven
 * by Product Definition metadata.
 *
 * Layout (per NMS framework spec):
 *   ┌────────────────────────────────────┬──────────────────────────────┐
 *   │  Device header + status badges     │                              │
 *   │  Group tabs (Radio/System/…)       │  Panel rendering context     │
 *   │  Parameter value cards             │  sidebar                     │
 *   └────────────────────────────────────┴──────────────────────────────┘
 *
 * Data loading:
 *   1. GET /api/framework/v1/devices/{deviceId}/ui-template
 *   2. GET /api/framework/v1/devices/{deviceId}/parameters/current
 *   3. GET /api/v1/devices/{deviceId} (for hostname/IP/firmware display)
 *
 * All three run in parallel. Template drives rendering; current values
 * are overlaid where available; device info enriches the header.
 *
 * Constraints:
 *   - All parameters are read-only in P0.
 *   - Credential material is never rendered in any state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LoadingState, EmptyState } from '../components/common/States';
import { Card } from '../components/common/Card';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { ParameterGroupTabs } from '../components/framework/parameters/ParameterGroupTabs';
import { getDeviceUiTemplate } from '../../api/framework-panels.api';
import { getDeviceCurrentParameterValues, flattenParameterValues, updateDeviceParameter } from '../../api/framework-parameters.api';
import { fetchDevices } from '../../api/devices.api';
import type { AdaptiveUiTemplateData, AdaptivePanelError } from '../../api/framework-panels.types';
import type { ParameterCurrentValue, ParameterCurrentValueResponse } from '../../api/framework-parameters.types';
import type { Device } from '../../api/devices.types';
import { logger } from '../utils/logger';

// ── Panel rendering context sidebar ──────────────────────────────────────────

interface PanelContextProps {
  template: AdaptiveUiTemplateData;
  lastPollTime: string | null;
  userRole: string;
  deviceId: string;
}

function PanelRenderingContext({ template, lastPollTime, userRole, deviceId }: PanelContextProps) {
  const [adapterExpanded, setAdapterExpanded] = useState(false);
  const [copied, setCopied]                   = useState(false);

  // Format cache version: strip the long timestamp suffix if present, keep the date part.
  const cacheVersion = template.registryVersion ?? '—';

  // Format last poll as HH:MM:SS UTC.
  const lastPollDisplay = lastPollTime
    ? new Date(lastPollTime).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC'
    : '—';

  const deviceApiUrl = `${window.location.origin}/api/framework/v1/devices/${deviceId}/parameters/current`;

  async function handleCopyApiUrl() {
    try {
      await navigator.clipboard.writeText(deviceApiUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available — silently ignore.
    }
  }

  return (
    <aside
      aria-label="Panel rendering context"
      style={{
        width: 260,
        flexShrink: 0,
        background: 'var(--vf-surface)',
        border: '1px solid var(--vf-border-subtle)',
        borderRadius: 'var(--vf-radius-lg)',
        padding: '20px 18px',
        boxShadow: 'var(--vf-shadow-card)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: 16,
      }}
    >
      <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--vf-text-primary)', margin: 0 }}>
        Panel rendering context
      </h3>

      {/* Role preview */}
      <div>
        <div style={CONTEXT_LABEL}>Role preview</div>
        <div style={{
          padding: '7px 12px',
          border: '1px solid var(--vf-border-subtle)',
          borderRadius: 'var(--vf-radius-md)',
          background: 'var(--vf-elevated)',
          fontSize: 13,
          color: 'var(--vf-text-primary)',
        }}>
          {userRole || 'Operator'}
        </div>
      </div>

      {/* Cache version */}
      <div>
        <div style={CONTEXT_LABEL}>Cache version</div>
        <div style={{ fontSize: 12, fontFamily: 'var(--vf-font-mono)', color: 'var(--vf-text-secondary)', wordBreak: 'break-all' }}>
          {cacheVersion}
        </div>
      </div>

      {/* Last poll */}
      <div>
        <div style={CONTEXT_LABEL}>Last poll</div>
        <div style={{ fontSize: 13, color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-mono)' }}>
          {lastPollDisplay}
        </div>
      </div>

      {/* Staleness rule */}
      <div>
        <div style={CONTEXT_LABEL}>Staleness rule</div>
        <div style={{ fontSize: 13, color: 'var(--vf-text-primary)' }}>
          2× poll interval
        </div>
      </div>

      {/* Adapter path — collapsible */}
      <div>
        <button
          onClick={() => setAdapterExpanded((e) => !e)}
          aria-expanded={adapterExpanded}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--vf-text-primary)',
            width: '100%',
          }}
        >
          <span aria-hidden>{adapterExpanded ? '▼' : '▶'}</span>
          Adapter path
        </button>
        {adapterExpanded && (
          <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', margin: '8px 0 0', lineHeight: 1.5 }}>
            {template.adapterContext?.activeAdapter
              ? `Parameter Registry resolves OIDs and CLI commands, then SPAL DeviceClient.get returns values to Parameter Store via ${template.adapterContext.activeAdapter}.`
              : 'Parameter Registry resolves OIDs and CLI commands, then SPAL DeviceClient.get returns values to Parameter Store.'}
          </p>
        )}
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--vf-border-subtle)', margin: '2px 0' }} />

      {/* Acknowledge alarm */}
      <button
        onClick={() => {}}
        aria-label="Acknowledge active framework alarms for this device"
        style={{
          padding: '9px 14px',
          borderRadius: 'var(--vf-radius-md)',
          border: 'none',
          background: 'var(--vf-accent)',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          width: '100%',
        }}
      >
        Acknowledge alarm
      </button>

      {/* Copy device API URL */}
      <button
        onClick={handleCopyApiUrl}
        aria-label="Copy the device's framework parameter API URL to clipboard"
        style={{
          padding: '9px 14px',
          borderRadius: 'var(--vf-radius-md)',
          border: '1px solid var(--vf-border-subtle)',
          background: 'var(--vf-surface)',
          color: 'var(--vf-text-primary)',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 500,
          width: '100%',
        }}
      >
        {copied ? '✓ Copied!' : 'Copy device API URL'}
      </button>
    </aside>
  );
}

// ── Status pill helper ────────────────────────────────────────────────────────

function StatusPill({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const colors = {
    success: { bg: 'var(--vf-success-subtle)', text: 'var(--vf-success)',        border: 'var(--vf-success)' },
    warning: { bg: 'var(--vf-warning-subtle)', text: 'var(--vf-warning)',        border: 'var(--vf-warning)' },
    danger:  { bg: 'var(--vf-danger-subtle)',  text: 'var(--vf-danger)',         border: 'var(--vf-danger)' },
    neutral: { bg: 'var(--vf-elevated)',        text: 'var(--vf-text-secondary)', border: 'var(--vf-border-subtle)' },
  }[variant];
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 'var(--vf-radius-full)',
      border: `1px solid ${colors.border}`,
      background: colors.bg,
      color: colors.text,
      fontSize: 12,
      fontWeight: 600,
    }}>
      {children}
    </span>
  );
}

// ── Page component ────────────────────────────────────────────────────────────

export default function AdaptiveDeviceParameterPanelsPage() {
  const { id: deviceId = '' } = useParams<{ id: string }>();
  const navigate   = useNavigate();
  const { addToast } = useToast();
  const { user }   = useAuth();

  const [template,       setTemplate]       = useState<AdaptiveUiTemplateData | null>(null);
  const [currentValueMap, setCurrentValueMap] = useState<Map<string, ParameterCurrentValue>>(new Map());
  const [device,         setDevice]         = useState<Device | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<AdaptivePanelError | null>(null);
  const [refreshing,     setRefreshing]     = useState(false);
  const [versionMismatch, setVersionMismatch] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Load template, current values, and device info in parallel.
   * Template is required; current values and device info are best-effort.
   */
  const load = useCallback(async (silent = false) => {
    if (!deviceId) return;
    if (!silent) setLoading(true);
    setError(null);

    try {
      const [templateResp, valuesResp, devicesResp] = await Promise.allSettled([
        getDeviceUiTemplate(deviceId),
        getDeviceCurrentParameterValues(deviceId),
        // DeviceFilter has no id field — fetch all and find by id client-side.
        fetchDevices({}),
      ]);

      // Template is required.
      if (templateResp.status === 'rejected') {
        const err = templateResp.reason as AdaptivePanelError;
        logger.error('ui-template load failed', { deviceId, code: err?.code });
        setError(err ?? { code: 'INTERNAL_ERROR', message: 'Failed to load parameter template.', correlationId: '' });
        return;
      }

      const tResp = templateResp.value;
      if (tResp.status !== 'ok' || !tResp.data) {
        setError(tResp.error ?? { code: 'INTERNAL_ERROR', message: 'Unexpected template response.', correlationId: '' });
        return;
      }

      setTemplate(tResp.data);

      // Current values — best effort.
      if (valuesResp.status === 'fulfilled' && valuesResp.value.status === 'ok') {
        const cvResp: ParameterCurrentValueResponse = valuesResp.value;
        const allValues = flattenParameterValues(cvResp.data?.groups ?? []);
        const map = new Map<string, ParameterCurrentValue>(allValues.map((v) => [v.parameterId, v]));
        setCurrentValueMap(map);

        const templateVersion = tResp.data.registryVersion;
        const valuesVersion   = cvResp.data?.registryVersion;
        setVersionMismatch(!!valuesVersion && valuesVersion !== templateVersion);
      } else {
        setVersionMismatch(false);
      }

      // Device info — best effort, for header display.
      if (devicesResp.status === 'fulfilled') {
        const devices = devicesResp.value;
        // Find by id if array returned, else first result.
        const found = devices.find((d) => d.id === deviceId || d.deviceId === deviceId) ?? devices[0] ?? null;
        setDevice(found);
      }

      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      logger.error('AdaptiveDeviceParameterPanelsPage load error', { deviceId, err });
      setError({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId: '' });
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  // Initial load.
  useEffect(() => { void load(false); }, [load]);

  // Auto-refresh every 30 seconds (aligned with typical 2× poll interval staleness).
  useEffect(() => {
    autoRefreshRef.current = setInterval(() => {
      void load(true);
    }, 30_000);
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
      addToast('Parameter values refreshed.', 'success');
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Called by ParameterValueCard when the operator saves a new value.
   * Validates that the device ID is known before dispatching, then refreshes
   * current values after a short settle delay to pick up the polled update.
   */
  const handleWriteParameter = useCallback(async (parameterId: string, value: string) => {
    try {
      await updateDeviceParameter(deviceId, parameterId, value);
      addToast(`Parameter "${parameterId}" updated — polling will refresh shortly.`, 'success');
      // Refresh after 2 s to show the newly polled value
      setTimeout(() => { void load(true); }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`Failed to write "${parameterId}": ${msg}`, 'error');
      // Re-throw so ParameterValueCard knows the save failed
      throw err;
    }
  }, [deviceId, addToast, load]);

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) return <LoadingState label="Loading framework parameter template…" />;
  if (error)   return <FrameworkErrorState error={error} onBack={() => navigate(-1)} />;

  if (!template) {
    return (
      <EmptyState
        title="No parameter template available"
        description="This device does not have an active Product Definition framework association."
        action={<Button variant="ghost" onClick={() => navigate(-1)}>Back</Button>}
      />
    );
  }

  // ── Derived header values ──────────────────────────────────────────────────

  // Device title: "VendorA BTS-X200 · 10.42.18.22" or just the device ID.
  const deviceModel   = device ? `${device.manufacturer ?? ''} ${device.model ?? ''}`.trim() : '';
  const deviceIp      = device?.ipAddress ?? '';
  const deviceTitle   = [deviceModel, deviceIp].filter(Boolean).join(' · ') || `Device ${deviceId}`;

  // Subtitle line: "ProductDefinition VendorA-BTS-X200:1.0.4 · Firmware 3.7 · Active adapter SNMP with CLI fallback"
  const pdId          = template.productDefinitionId;
  const firmware      = device?.firmwareVersion ?? '';
  const activeAdapter = template.adapterContext?.activeAdapter ?? '';
  const lastFailure   = template.adapterContext?.lastFailureCategory;

  const subtitleParts = [
    `ProductDefinition ${pdId}`,
    firmware && `Firmware ${firmware}`,
    activeAdapter && `Active adapter ${activeAdapter}${lastFailure ? ' with CLI fallback' : ''}`,
  ].filter(Boolean);

  // Reachability from device status.
  const reachabilityVariant: 'success' | 'warning' | 'danger' | 'neutral' =
    device?.status === 'ONLINE'   ? 'success'
    : device?.status === 'OFFLINE'  ? 'danger'
    : 'neutral';
  const reachabilityLabel =
    device?.status === 'ONLINE'   ? 'reachable'
    : device?.status === 'OFFLINE'  ? 'unreachable'
    : 'unknown';

  // Normalize role label to framework vocabulary.
  const rawRole = String(user?.role ?? 'Operator');
  const displayRole = rawRole.charAt(0).toUpperCase() + rawRole.slice(1).toLowerCase();

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div
      role="main"
      aria-label={`Adaptive parameter panels for device ${deviceId}`}
      style={{ padding: '24px 28px 40px' }}
    >
      {/* ── Top bar: Refresh values button (top-right per spec) ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh parameter values"
          style={{ fontSize: 13, fontWeight: 500 }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh values'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="Back to device detail" style={{ marginLeft: 8 }}>
          Back
        </Button>
      </div>

      {/* ── Device header ── */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: 'var(--vf-text-primary)', margin: '0 0 6px' }}>
          {deviceTitle}
        </h1>
        {subtitleParts.length > 0 && (
          <p style={{ fontSize: 13, color: 'var(--vf-text-secondary)', margin: '0 0 10px' }}>
            {subtitleParts.join(' · ')}
          </p>
        )}
        {/* Status pills + PD badge */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusPill variant={reachabilityVariant}>{reachabilityLabel}</StatusPill>
          <StatusPill variant="neutral">role: {displayRole}</StatusPill>
          {/* Product Definition badge — aria-label links to full ID for screen readers and tests */}
          <Badge
            variant="info"
            aria-label={`Product Definition: ${pdId}`}
          >
            {pdId}
          </Badge>
        </div>
      </div>

      {/* ── Registry version mismatch banner ── */}
      {versionMismatch && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            background: 'var(--vf-warning-subtle)',
            border: '1px solid var(--vf-warning)',
            borderRadius: 'var(--vf-radius-md)',
            padding: '8px 14px',
            marginBottom: 14,
            fontSize: 12,
            color: 'var(--vf-warning)',
          }}
        >
          ⚠ Registry version mismatch: the template and current values were generated from different
          registry versions. Refresh to realign.
        </div>
      )}

      {/* ── Adapter failure context banner ── */}
      {template.adapterContext?.lastFailureCategory && (
        <div
          role="note"
          style={{
            background: 'var(--vf-elevated)',
            border: '1px solid var(--vf-border-subtle)',
            borderRadius: 'var(--vf-radius-md)',
            padding: '8px 14px',
            marginBottom: 14,
            fontSize: 12,
            color: 'var(--vf-text-secondary)',
          }}
        >
          <strong>Adapter failure:</strong> {template.adapterContext.lastFailureCategory}
          {template.adapterContext.lastFailureReason && (
            <> — {template.adapterContext.lastFailureReason}</>
          )}
        </div>
      )}

      {/* ── Two-column content layout ── */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Left: parameter tabs */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card style={{ padding: '0 0 8px' }}>
            <ParameterGroupTabs
              groups={template.groups}
              currentValues={currentValueMap}
              onWrite={handleWriteParameter}
            />
          </Card>
        </div>

        {/* Right: Panel rendering context sidebar */}
        <PanelRenderingContext
          template={template}
          lastPollTime={lastRefreshedAt}
          userRole={displayRole}
          deviceId={deviceId}
        />
      </div>
    </div>
  );
}

// ── Error state ────────────────────────────────────────────────────────────────

function FrameworkErrorState({ error, onBack }: { error: AdaptivePanelError; onBack: () => void }) {
  const titleMap: Record<string, string> = {
    UNAUTHENTICATED:           'Authentication required',
    FORBIDDEN_ACTION:          'Access restricted',
    DEVICE_NOT_FOUND:          'Device not found',
    NO_ACTIVE_FRAMEWORK:       'No active framework',
    REGISTRY_VERSION_MISMATCH: 'Registry version mismatch',
    SERVICE_UNAVAILABLE:       'Service temporarily unavailable',
    INTERNAL_ERROR:            'Unexpected error',
  };

  const descriptionMap: Record<string, string> = {
    UNAUTHENTICATED:           'Please sign in to view framework parameters.',
    FORBIDDEN_ACTION:          'Your current role does not have access to this device\'s parameters.',
    DEVICE_NOT_FOUND:          'This device does not have an active Product Definition. Discover and fingerprint the device first.',
    NO_ACTIVE_FRAMEWORK:       'This device has no active Product Definition framework association.',
    REGISTRY_VERSION_MISMATCH: 'The registry version has changed. Please refresh the page.',
    SERVICE_UNAVAILABLE:       'The parameter service is temporarily unavailable. Please try again shortly.',
    INTERNAL_ERROR:            error.message || 'An unexpected error occurred.',
  };

  return (
    <EmptyState
      title={titleMap[error.code] ?? 'Error loading parameters'}
      description={descriptionMap[error.code] ?? error.message}
      action={<Button variant="ghost" onClick={onBack}>Back</Button>}
    />
  );
}

// ── Style constants ───────────────────────────────────────────────────────────

const CONTEXT_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--vf-text-muted)',
  marginBottom: 4,
};

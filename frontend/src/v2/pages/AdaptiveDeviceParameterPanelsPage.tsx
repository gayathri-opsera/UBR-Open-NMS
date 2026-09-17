/**
 * WO-014: AdaptiveDeviceParameterPanelsPage
 *
 * Operator-facing page that renders the adaptive device parameter view driven
 * by Product Definition metadata. This page is only shown when the device has
 * an active framework Product Definition association.
 *
 * Data loading:
 *   1. GET /api/framework/v1/devices/{deviceId}/ui-template
 *      → Provides role-filtered parameter groups and widget metadata.
 *   2. GET /api/framework/v1/devices/{deviceId}/parameters/current
 *      → Provides polled current values with freshness state.
 *
 * Both requests run in parallel. The template drives rendering; current values
 * are overlaid where available.
 *
 * Error states handled:
 *   - 401 UNAUTHENTICATED  → redirect to login (handled by auth context upstream)
 *   - 403 FORBIDDEN_ACTION → forbidden empty state
 *   - 404 DEVICE_NOT_FOUND or NO_ACTIVE_FRAMEWORK → actionable empty state
 *   - 409 REGISTRY_VERSION_MISMATCH → informational banner, partial rendering
 *   - 503 SERVICE_UNAVAILABLE → retry suggestion
 *
 * Constraints:
 *   - All controls are read-only in P0.
 *   - No credential material is rendered in any state.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LoadingState, EmptyState } from '../components/common/States';
import { Card } from '../components/common/Card';
import { Badge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { useToast } from '../components/common/Toast';
import { ParameterGroupTabs } from '../components/framework/parameters/ParameterGroupTabs';
import { getDeviceUiTemplate } from '../../api/framework-panels.api';
import { getDeviceCurrentParameterValues, flattenParameterValues } from '../../api/framework-parameters.api';
import type { AdaptiveUiTemplateData, AdaptivePanelError } from '../../api/framework-panels.types';
import type { ParameterCurrentValue, ParameterCurrentValueResponse } from '../../api/framework-parameters.types';
import { logger } from '../utils/logger';

// ── Page component ────────────────────────────────────────────────────────────

export default function AdaptiveDeviceParameterPanelsPage() {
  const { id: deviceId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [template, setTemplate] = useState<AdaptiveUiTemplateData | null>(null);
  const [currentValueMap, setCurrentValueMap] = useState<Map<string, ParameterCurrentValue>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdaptivePanelError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [versionMismatch, setVersionMismatch] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  /**
   * Load template and current values in parallel.
   * Version mismatch (template registryVersion !== values registryVersion)
   * is surfaced as an informational banner without blocking rendering.
   */
  const load = useCallback(async (silent = false) => {
    if (!deviceId) return;

    if (!silent) setLoading(true);
    setError(null);

    try {
      const [templateResp, valuesResp] = await Promise.allSettled([
        getDeviceUiTemplate(deviceId),
        getDeviceCurrentParameterValues(deviceId),
      ]);

      // Template is required — if it fails, show an error state.
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

      // Current values are best-effort — a failure here does not block rendering.
      if (valuesResp.status === 'fulfilled' && valuesResp.value.status === 'ok') {
        const cvResp: ParameterCurrentValueResponse = valuesResp.value;
        const allValues = flattenParameterValues(cvResp.data?.groups ?? []);
        const map = new Map<string, ParameterCurrentValue>(
          allValues.map((v) => [v.parameterId, v]),
        );
        setCurrentValueMap(map);

        // Detect registry version mismatch between template and values.
        const templateVersion = tResp.data.registryVersion;
        const valuesVersion   = cvResp.data?.registryVersion;
        setVersionMismatch(!!valuesVersion && valuesVersion !== templateVersion);
      } else {
        // Values failed or returned error — keep previous values or empty map.
        setVersionMismatch(false);
      }

      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      logger.error('AdaptiveDeviceParameterPanelsPage load error', { deviceId, err });
      setError({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', correlationId: '' });
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
      addToast({ type: 'success', message: 'Parameter values refreshed.' });
    } finally {
      setRefreshing(false);
    }
  };

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState label="Loading framework parameter template…" />;
  }

  if (error) {
    return <FrameworkErrorState error={error} onBack={() => navigate(-1)} />;
  }

  if (!template) {
    return (
      <EmptyState
        title="No parameter template available"
        description="This device does not have an active Product Definition framework association."
        action={<Button variant="ghost" onClick={() => navigate(-1)}>Back</Button>}
      />
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div
      role="main"
      aria-label={`Adaptive parameter panels for device ${deviceId}`}
      style={{ padding: '0 0 32px' }}
    >
      {/* Page header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <h1
          style={{
            fontSize: 'var(--vf-type-h3-size)',
            fontWeight: 'var(--vf-type-h3-weight)' as React.CSSProperties['fontWeight'],
            color: 'var(--vf-text-primary)',
            margin: 0,
            flex: 1,
          }}
        >
          Framework Parameters
        </h1>

        <Badge variant="info" aria-label={`Product Definition: ${template.productDefinitionId}`}>
          {template.productDefinitionId}
        </Badge>

        {lastRefreshedAt && (
          <span
            style={{ fontSize: 'var(--vf-type-caption-size)', color: 'var(--vf-text-tertiary)' }}
            aria-label={`Last refreshed at ${new Date(lastRefreshedAt).toLocaleTimeString()}`}
          >
            Updated {new Date(lastRefreshedAt).toLocaleTimeString()}
          </span>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh parameter values"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>

        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="Back to previous page">
          Back
        </Button>
      </div>

      {/* Registry version mismatch banner */}
      {versionMismatch && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            background: 'var(--vf-warning-subtle)',
            border: '1px solid var(--vf-warning)',
            borderRadius: 'var(--vf-radius-md)',
            padding: '8px 14px',
            marginBottom: 12,
            fontSize: 'var(--vf-type-caption-size)',
            color: 'var(--vf-warning)',
          }}
        >
          ⚠ Registry version mismatch: the template and current values were generated from different
          registry versions. Refresh to realign.
        </div>
      )}

      {/* Adapter context when available */}
      {template.adapterContext?.lastFailureCategory && (
        <div
          role="note"
          style={{
            background: 'var(--vf-elevated)',
            border: '1px solid var(--vf-border-subtle)',
            borderRadius: 'var(--vf-radius-md)',
            padding: '8px 14px',
            marginBottom: 12,
            fontSize: 'var(--vf-type-caption-size)',
            color: 'var(--vf-text-secondary)',
          }}
        >
          <strong>Adapter:</strong> {template.adapterContext.activeAdapter ?? 'unknown'} ·{' '}
          <strong>Last failure:</strong> {template.adapterContext.lastFailureCategory}
          {template.adapterContext.lastFailureReason && (
            <> — {template.adapterContext.lastFailureReason}</>
          )}
        </div>
      )}

      {/* Parameter groups */}
      <Card>
        <ParameterGroupTabs
          groups={template.groups}
          currentValues={currentValueMap}
        />
      </Card>

      {/* Read-only disclaimer */}
      <p
        aria-live="off"
        style={{
          marginTop: 12,
          fontSize: 'var(--vf-type-caption-size)',
          color: 'var(--vf-text-tertiary)',
          textAlign: 'center',
        }}
      >
        All parameters are read-only in this release. Parameter write support is planned for a future version.
      </p>
    </div>
  );
}

// ── Error state component ─────────────────────────────────────────────────────

function FrameworkErrorState({
  error,
  onBack,
}: {
  error: AdaptivePanelError;
  onBack: () => void;
}) {
  const titleMap: Record<string, string> = {
    UNAUTHENTICATED:          'Authentication required',
    FORBIDDEN_ACTION:         'Access restricted',
    DEVICE_NOT_FOUND:         'Device not found',
    NO_ACTIVE_FRAMEWORK:      'No active framework',
    REGISTRY_VERSION_MISMATCH: 'Registry version mismatch',
    SERVICE_UNAVAILABLE:      'Service temporarily unavailable',
    INTERNAL_ERROR:           'Unexpected error',
  };

  const descriptionMap: Record<string, string> = {
    UNAUTHENTICATED:          'Please sign in to view framework parameters.',
    FORBIDDEN_ACTION:         'Your current role does not have access to this device\'s parameters.',
    DEVICE_NOT_FOUND:         'This device does not have an active Product Definition. Discover and fingerprint the device first.',
    NO_ACTIVE_FRAMEWORK:      'This device has no active Product Definition framework association.',
    REGISTRY_VERSION_MISMATCH: 'The registry version has changed. Please refresh the page.',
    SERVICE_UNAVAILABLE:      'The parameter service is temporarily unavailable. Please try again shortly.',
    INTERNAL_ERROR:           error.message || 'An unexpected error occurred.',
  };

  const title = titleMap[error.code] ?? 'Error loading parameters';
  const description = descriptionMap[error.code] ?? error.message;

  return (
    <EmptyState
      title={title}
      description={description}
      action={
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      }
    />
  );
}

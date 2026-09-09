/**
 * V2 Compliance Page — WO-068
 * Generate CTSO/TSOC incident evidence packages with privacy-compliant data masking
 */

import React, { useState, useEffect } from 'react';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { LoadingState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { EvidenceCompletenessCard } from '../components/compliance/EvidenceCompletenessCard';
import { EvidenceSummaryView } from '../components/compliance/EvidenceSummaryView';
import {
  requestIncidentEvidence,
  getIncidentEvidenceStatus,
  downloadIncidentEvidence,
} from '../../api/reports.api';
import { downloadBlob } from '../../utils/download';
import type { IncidentEvidenceResponse } from '../../api/reports.types';
import { logger } from '../utils/logger';

type TabType = 'request' | 'status';
type LookupType = 'alarmId' | 'correlationId' | 'incidentRef' | 'deviceId';

export default function V2CompliancePage() {
  const [activeTab, setActiveTab] = useState<TabType>('request');
  const { addToast } = useToast();

  // Form state
  const [lookupType, setLookupType] = useState<LookupType>('alarmId');
  const [lookupValue, setLookupValue] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [requesting, setRequesting] = useState(false);

  // Evidence state
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [evidenceResponse, setEvidenceResponse] = useState<IncidentEvidenceResponse | null>(null);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  // Initialize date range to last 7 days
  useEffect(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    setToDate(now.toISOString().slice(0, 16));
    setFromDate(sevenDaysAgo.toISOString().slice(0, 16));
  }, []);

  // Poll for evidence status
  useEffect(() => {
    if (activeEvidenceId && evidenceResponse?.status === 'PENDING') {
      const interval = setInterval(async () => {
        try {
          const status = await getIncidentEvidenceStatus(activeEvidenceId);
          setEvidenceResponse(status);
          if (status.status !== 'PENDING') {
            clearInterval(interval);
            setPollInterval(null);
            if (status.status === 'COMPLETED') {
              addToast('Evidence package generated successfully', 'success');
              setActiveTab('status');
            } else if (status.status === 'FAILED') {
              addToast(`Evidence generation failed: ${status.errorMessage}`, 'error');
            }
          }
        } catch (err) {
          logger.error('Failed to poll evidence status', err);
        }
      }, 2000);
      setPollInterval(interval);
      return () => clearInterval(interval);
    }
  }, [activeEvidenceId, evidenceResponse?.status]);

  const handleRequestEvidence = async () => {
    if (!lookupValue.trim()) {
      addToast('Please enter a lookup value', 'warning');
      return;
    }
    if (!fromDate || !toDate) {
      addToast('Please select a time range', 'warning');
      return;
    }

    setRequesting(true);
    setEvidenceResponse(null);
    try {
      const reportId = await requestIncidentEvidence({
        scope: {
          [lookupType]: lookupValue.trim(),
        },
        from: new Date(fromDate).toISOString(),
        to: new Date(toDate).toISOString(),
      });
      setActiveEvidenceId(reportId);
      setEvidenceResponse({
        reportId,
        status: 'PENDING',
        reportType: 'CTSO_TSOC_INCIDENT_EVIDENCE',
      });
      addToast('Evidence generation started', 'info');
    } catch (err) {
      logger.error('Failed to request evidence', err);
      addToast('Failed to start evidence generation', 'error');
    } finally {
      setRequesting(false);
    }
  };

  const handleDownload = async () => {
    if (!activeEvidenceId) return;
    try {
      const blob = await downloadIncidentEvidence(activeEvidenceId);
      downloadBlob(`evidence-${activeEvidenceId}.json`, blob);
      addToast('Evidence package downloaded', 'success');
    } catch (err) {
      logger.error('Failed to download evidence', err);
      addToast('Failed to download evidence package', 'error');
    }
  };

  const handleCopyChecksum = () => {
    if (evidenceResponse?.data?.checksum) {
      navigator.clipboard.writeText(evidenceResponse.data.checksum);
      addToast('Checksum copied to clipboard', 'success');
    }
  };

  const handleRefresh = async () => {
    if (!activeEvidenceId) return;
    try {
      const status = await getIncidentEvidenceStatus(activeEvidenceId);
      setEvidenceResponse(status);
      addToast('Status refreshed', 'success');
    } catch (err) {
      logger.error('Failed to refresh status', err);
      addToast('Failed to refresh status', 'error');
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
          Compliance Evidence Export
        </h1>
        <p style={{ fontSize: 14, color: 'var(--vf-text-muted)' }}>
          Generate CTSO/TSOC incident evidence packages with privacy-compliant data masking
        </p>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          borderBottom: '1px solid var(--vf-border-subtle)',
          marginBottom: 24,
        }}
      >
        <TabButton active={activeTab === 'request'} onClick={() => setActiveTab('request')}>
          Request Evidence
        </TabButton>
        <TabButton active={activeTab === 'status'} onClick={() => setActiveTab('status')}>
          Evidence Status
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === 'request' ? (
        <RequestTab
          lookupType={lookupType}
          setLookupType={setLookupType}
          lookupValue={lookupValue}
          setLookupValue={setLookupValue}
          fromDate={fromDate}
          setFromDate={setFromDate}
          toDate={toDate}
          setToDate={setToDate}
          requesting={requesting}
          onRequest={handleRequestEvidence}
          evidenceResponse={evidenceResponse}
        />
      ) : (
        <StatusTab
          evidenceResponse={evidenceResponse}
          onDownload={handleDownload}
          onRefresh={handleRefresh}
          onCopyChecksum={handleCopyChecksum}
        />
      )}
    </div>
  );
}

// ── Tab Button ───────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 20px',
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        color: active ? 'var(--vf-accent)' : 'var(--vf-text-secondary)',
        borderBottom: active ? '2px solid var(--vf-accent)' : '2px solid transparent',
        transition: 'color 0.15s, border-color 0.15s',
      }}
    >
      {children}
    </button>
  );
}

// ── Request Tab ──────────────────────────────────────────────────────────────

function RequestTab({
  lookupType,
  setLookupType,
  lookupValue,
  setLookupValue,
  fromDate,
  setFromDate,
  toDate,
  setToDate,
  requesting,
  onRequest,
  evidenceResponse,
}: {
  lookupType: LookupType;
  setLookupType: (val: LookupType) => void;
  lookupValue: string;
  setLookupValue: (val: string) => void;
  fromDate: string;
  setFromDate: (val: string) => void;
  toDate: string;
  setToDate: (val: string) => void;
  requesting: boolean;
  onRequest: () => void;
  evidenceResponse: IncidentEvidenceResponse | null;
}) {
  const lookupOptions = [
    { value: 'alarmId', label: 'Alarm ID' },
    { value: 'correlationId', label: 'Correlation ID' },
    { value: 'incidentRef', label: 'Incident Reference' },
    { value: 'deviceId', label: 'Device ID' },
  ];

  const placeholderMap: Record<LookupType, string> = {
    alarmId: 'e.g., ALM-001',
    correlationId: 'e.g., CORR-2026-09-07-001',
    incidentRef: 'e.g., INC-12345',
    deviceId: 'e.g., DEV-001',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Request Form */}
      <Card title="Evidence Request" padding="lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Lookup Type */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
              Lookup Criteria
            </label>
            <Select
              value={lookupType}
              onChange={(e) => setLookupType(e.target.value as LookupType)}
              disabled={requesting || evidenceResponse?.status === 'PENDING'}
              style={{ width: '100%', maxWidth: 300 }}
            >
              {lookupOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Lookup Value */}
          <div>
            <label
              htmlFor="lookup-value"
              style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', marginBottom: 8 }}
            >
              Value
            </label>
            <Input
              id="lookup-value"
              value={lookupValue}
              onChange={(e) => setLookupValue(e.target.value)}
              placeholder={placeholderMap[lookupType]}
              disabled={requesting || evidenceResponse?.status === 'PENDING'}
              style={{ width: '100%', maxWidth: 500 }}
            />
          </div>

          {/* Time Range */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
              Time Range
            </label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Input
                type="datetime-local"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                disabled={requesting || evidenceResponse?.status === 'PENDING'}
                style={{ flex: 1, maxWidth: 280 }}
              />
              <span style={{ color: 'var(--vf-text-muted)' }}>to</span>
              <Input
                type="datetime-local"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={requesting || evidenceResponse?.status === 'PENDING'}
                style={{ flex: 1, maxWidth: 280 }}
              />
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              loading={requesting || evidenceResponse?.status === 'PENDING'}
              onClick={onRequest}
              disabled={!lookupValue.trim() || !fromDate || !toDate}
            >
              {evidenceResponse?.status === 'PENDING' ? 'Generating Evidence...' : 'Request Evidence'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Pending Status */}
      {evidenceResponse && evidenceResponse.status === 'PENDING' && (
        <Card padding="lg">
          <LoadingState message="Collecting and assembling incident evidence..." />
        </Card>
      )}
    </div>
  );
}

// ── Status Tab ───────────────────────────────────────────────────────────────

function StatusTab({
  evidenceResponse,
  onDownload,
  onRefresh,
  onCopyChecksum,
}: {
  evidenceResponse: IncidentEvidenceResponse | null;
  onDownload: () => void;
  onRefresh: () => void;
  onCopyChecksum: () => void;
}) {
  if (!evidenceResponse) {
    return (
      <Card padding="lg">
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--vf-text-muted)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No evidence package requested</div>
          <div style={{ fontSize: 13 }}>Request an incident evidence package to view status</div>
        </div>
      </Card>
    );
  }

  if (evidenceResponse.status === 'PENDING') {
    return (
      <Card padding="lg">
        <LoadingState message="Collecting and assembling incident evidence..." />
      </Card>
    );
  }

  if (evidenceResponse.status === 'FAILED') {
    return (
      <Card padding="lg">
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✕</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--vf-danger)', marginBottom: 8 }}>
            Evidence Generation Failed
          </div>
          <div style={{ fontSize: 13, color: 'var(--vf-text-muted)' }}>
            {evidenceResponse.errorMessage || 'An unknown error occurred'}
          </div>
        </div>
      </Card>
    );
  }

  if (evidenceResponse.status === 'COMPLETED' && evidenceResponse.evidence) {
    const evidence = evidenceResponse.evidence;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Completeness Card */}
        <EvidenceCompletenessCard
          completeness={evidence.evidenceCompleteness || { alarmData: 'unavailable', auditData: 'unavailable', inventoryData: 'unavailable' }}
          privacyVersion={evidence.privacyPolicyVersion || 'N/A'}
          checksum={evidence.checksum || 'N/A'}
          onCopyChecksum={onCopyChecksum}
        />

        {/* Summary View */}
        <EvidenceSummaryView
          alarmTimeline={evidence.alarmTimeline || []}
          auditEvents={evidence.auditEvents || []}
          affectedDevices={evidence.affectedDevices || []}
        />

        {/* Actions */}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onRefresh}>
            Refresh Status
          </Button>
          <Button variant="primary" onClick={onDownload}>
            ⬇ Download Evidence Package
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

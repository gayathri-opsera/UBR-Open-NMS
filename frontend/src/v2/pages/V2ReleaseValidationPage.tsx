/**
 * V2 Release Validation Page — WO-065
 * Generate release acceptance reports and validate release candidates
 */

import React, { useState, useEffect } from 'react';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Badge } from '../components/common/Badge';
import { Input } from '../components/common/Input';
import { LoadingState } from '../components/common/States';
import { useToast } from '../components/common/Toast';
import { ValidationResultTable } from '../components/reports/ValidationResultTable';
import { ReleaseStatusCard } from '../components/reports/ReleaseStatusCard';
import {
  requestReleaseReport,
  getReleaseReportStatus,
  downloadReleaseReport,
  listReleaseReports,
} from '../../api/reports.api';
import { downloadBlob } from '../../utils/download';
import type { ReleaseReportStatus, ValidationResultSummary } from '../../api/reports.types';
import { logger } from '../utils/logger';

type TabType = 'generate' | 'history';

export default function V2ReleaseValidationPage() {
  const [activeTab, setActiveTab] = useState<TabType>('generate');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<ValidationResultSummary[]>([]);
  const { addToast } = useToast();

  // Form state
  const [releaseCandidate, setReleaseCandidate] = useState('');
  const [generating, setGenerating] = useState(false);

  // Report state
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<ReleaseReportStatus | null>(null);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  // Load history when switching to history tab
  useEffect(() => {
    if (activeTab === 'history' && history.length === 0) {
      loadHistory();
    }
  }, [activeTab]);

  // Poll for report status
  useEffect(() => {
    if (activeReportId && reportStatus?.status === 'PENDING') {
      const interval = setInterval(async () => {
        try {
          const status = await getReleaseReportStatus(activeReportId);
          setReportStatus(status);
          if (status.status !== 'PENDING') {
            clearInterval(interval);
            setPollInterval(null);
            if (status.status === 'DONE') {
              addToast('Report generated successfully', 'success');
            } else if (status.status === 'FAILED') {
              addToast(`Report generation failed: ${status.errorMessage}`, 'error');
            }
          }
        } catch (err) {
          logger.error('Failed to poll report status', err);
        }
      }, 2000);
      setPollInterval(interval);
      return () => clearInterval(interval);
    }
  }, [activeReportId, reportStatus?.status]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const reports = await listReleaseReports();
      setHistory(reports);
    } catch (err) {
      logger.error('Failed to load history', err);
      addToast('Failed to load validation history', 'error');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!releaseCandidate.trim()) {
      addToast('Please enter a release candidate version', 'warning');
      return;
    }

    setGenerating(true);
    setReportStatus(null);
    try {
      const reportId = await requestReleaseReport({
        releaseCandidate: releaseCandidate.trim(),
      });
      setActiveReportId(reportId);
      setReportStatus({ reportId, status: 'PENDING' });
      addToast('Report generation started', 'info');
    } catch (err) {
      logger.error('Failed to request report', err);
      addToast('Failed to start report generation', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!activeReportId) return;
    try {
      const blob = await downloadReleaseReport(activeReportId);
      downloadBlob(`release-report-${releaseCandidate}.json`, blob);
      addToast('Report downloaded', 'success');
    } catch (err) {
      logger.error('Failed to download report', err);
      addToast('Failed to download report', 'error');
    }
  };

  const handleViewReport = async (reportId: string) => {
    setLoading(true);
    try {
      const status = await getReleaseReportStatus(reportId);
      setReportStatus(status);
      setActiveReportId(reportId);
      setActiveTab('generate');
    } catch (err) {
      logger.error('Failed to load report', err);
      addToast('Failed to load report', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
          Release Validation
        </h1>
        <p style={{ fontSize: 14, color: 'var(--vf-text-muted)' }}>
          Generate acceptance reports and validate release candidates against test scenarios
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
        <TabButton active={activeTab === 'generate'} onClick={() => setActiveTab('generate')}>
          Generate Report
        </TabButton>
        <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
          Validation History
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === 'generate' ? (
        <GenerateTab
          releaseCandidate={releaseCandidate}
          setReleaseCandidate={setReleaseCandidate}
          generating={generating}
          onGenerate={handleGenerate}
          reportStatus={reportStatus}
          onDownload={handleDownload}
        />
      ) : (
        <HistoryTab loading={historyLoading} history={history} onView={handleViewReport} />
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

// ── Generate Tab ─────────────────────────────────────────────────────────────

function GenerateTab({
  releaseCandidate,
  setReleaseCandidate,
  generating,
  onGenerate,
  reportStatus,
  onDownload,
}: {
  releaseCandidate: string;
  setReleaseCandidate: (val: string) => void;
  generating: boolean;
  onGenerate: () => void;
  reportStatus: ReleaseReportStatus | null;
  onDownload: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Configuration Card */}
      <Card title="Configuration" padding="lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label
              htmlFor="release-candidate"
              style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)', marginBottom: 8 }}
            >
              Release Candidate
            </label>
            <Input
              id="release-candidate"
              value={releaseCandidate}
              onChange={(e) => setReleaseCandidate(e.target.value)}
              placeholder="e.g., v1.0.0-rc1"
              disabled={generating || reportStatus?.status === 'PENDING'}
              style={{ width: '100%', maxWidth: 400 }}
            />
          </div>

          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              loading={generating || reportStatus?.status === 'PENDING'}
              onClick={onGenerate}
              disabled={!releaseCandidate.trim()}
            >
              {reportStatus?.status === 'PENDING' ? 'Generating Report...' : 'Generate Report'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Status/Results */}
      {reportStatus && reportStatus.status === 'PENDING' && (
        <Card padding="lg">
          <LoadingState message="Generating release validation report..." />
        </Card>
      )}

      {reportStatus && reportStatus.status === 'DONE' && reportStatus.data && (
        <>
          <ReleaseStatusCard data={reportStatus.data} />

          <Card title="Validation Results" padding="lg">
            <ValidationResultTable results={reportStatus.data.scenarios} />
          </Card>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={onDownload}>
              ⬇ Download Report (JSON)
            </Button>
          </div>
        </>
      )}

      {reportStatus && reportStatus.status === 'FAILED' && (
        <Card padding="lg">
          <div style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✕</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--vf-danger)', marginBottom: 8 }}>
              Report Generation Failed
            </div>
            <div style={{ fontSize: 13, color: 'var(--vf-text-muted)' }}>
              {reportStatus.errorMessage || 'An unknown error occurred'}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({
  loading,
  history,
  onView,
}: {
  loading: boolean;
  history: ValidationResultSummary[];
  onView: (reportId: string) => void;
}) {
  if (loading) {
    return (
      <Card padding="lg">
        <LoadingState message="Loading validation history..." />
      </Card>
    );
  }

  if (history.length === 0) {
    return (
      <Card padding="lg">
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--vf-text-muted)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No validation history</div>
          <div style={{ fontSize: 13 }}>Generate your first release validation report</div>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {history.map((report) => (
        <Card key={report.reportId} padding="md" elevated>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                  {report.releaseCandidate}
                </span>
                <Badge variant={report.overallStatus === 'PASSED' ? 'success' : report.overallStatus === 'FAILED' ? 'danger' : 'warning'}>
                  {report.overallStatus}
                </Badge>
              </div>
              <div style={{ display: 'flex', gap: 20, fontSize: 12, color: 'var(--vf-text-muted)' }}>
                <span>{new Date(report.generatedAt).toLocaleString()}</span>
                <span>{report.scenarioCount} scenarios</span>
                <span>P0 Pass Rate: {report.p0PassRate}%</span>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onView(report.reportId)}>
              View Report
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

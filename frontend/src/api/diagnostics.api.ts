import { apiClient } from './client';

// ── Log extraction (NMS-AS-04) ─────────────────────────────────────────────
export interface LogRequest {
  deviceId: string;
  lines?: number; // default 500
  level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source?: string;
}

export async function extractDeviceLogs(params: LogRequest): Promise<LogEntry[]> {
  const { deviceId, ...body } = params;
  const res = await apiClient.post<LogEntry[]>(`/diagnostics/${deviceId}/logs`, body);
  return res.data;
}

// ── Speed test (NMS-AS-05) ────────────────────────────────────────────────
export interface SpeedTestResult {
  deviceId: string;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  packetLossPct: number;
  testedAt: string;
  status: 'SUCCESS' | 'FAILED' | 'RUNNING';
}

export async function triggerSpeedTest(deviceId: string): Promise<SpeedTestResult> {
  const res = await apiClient.post<SpeedTestResult>(`/diagnostics/${deviceId}/speed-test`, {});
  return res.data;
}

// ── Spectrum analysis (NMS-AS-08) ─────────────────────────────────────────
export interface SpectrumBucket {
  frequencyMHz: number;
  powerDbm: number;
  channelUtilizationPct?: number;
}

export interface SpectrumResult {
  deviceId: string;
  capturedAt: string;
  buckets: SpectrumBucket[];
  status: 'SUCCESS' | 'FAILED' | 'RUNNING';
}

export async function triggerSpectrumAnalysis(deviceId: string): Promise<SpectrumResult> {
  const res = await apiClient.post<SpectrumResult>(`/diagnostics/${deviceId}/spectrum-analysis`, {});
  return res.data;
}

// ── Missing data report (NMS-AS-06) ───────────────────────────────────────
export interface MissingDataEntry {
  deviceId: string;
  serialNumber: string;
  lastReportedAt: string | null;
  missedCycles: number;
}

export async function fetchMissingDataReport(): Promise<MissingDataEntry[]> {
  const res = await apiClient.get<MissingDataEntry[]>('/diagnostics/missing-data');
  return res.data;
}

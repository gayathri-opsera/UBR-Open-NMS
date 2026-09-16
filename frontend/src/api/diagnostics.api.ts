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

// ── Firmware Upgrade (WO-012) ─────────────────────────────────────────────

export interface FirmwareUpgradeRequest {
  imageRef: string;
  expectedVersion: string;
  checksumAlgorithm: 'SHA256' | 'MD5' | 'SHA1';
  checksumValue: string;
  transferMethod: 'SCP' | 'TFTP' | 'HTTP' | 'CALL_HOME';
  reason?: string;
  confirmation?: boolean;
  idempotencyKey?: string;
  maintenanceWindow?: string;
}

export interface FirmwareUpgradeResponse {
  jobId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  firmwarePhase: string;
  acceptedAt: string;
  precheckState: 'COMPATIBLE' | 'INCOMPATIBLE' | 'POLICY_BLOCKED' | 'PENDING';
  trackingUrl: string;
}

export interface FirmwareJob {
  id: string;
  deviceId: string;
  imageRef: string;
  expectedVersion: string;
  checksumAlgorithm: string;
  transferMethod: string;
  reason?: string;
  actor: string;
  role: string;
  firmwarePhase: string;
  status: string;
  transferProgress?: number;
  checksumVerified?: boolean;
  observedVersion?: string;
  discrepancy?: boolean;
  retryable?: boolean;
  compatibilityDecision?: string;
  failureReason?: string;
  acceptedAt: string;
  completedAt?: string;
  durationMs?: number;
}

/**
 * Submit a firmware upgrade request for a device.
 * @param deviceId Target device ID
 * @param request Firmware upgrade parameters
 * @returns Job tracking response
 * @throws Error on validation failure, compatibility issues, or conflicts
 */
export async function submitFirmwareUpgrade(
  deviceId: string,
  request: FirmwareUpgradeRequest
): Promise<FirmwareUpgradeResponse> {
  const res = await apiClient.post<FirmwareUpgradeResponse>(
    `/operations/devices/${deviceId}/firmware-upgrade`,
    request
  );
  return res.data;
}

/**
 * Get firmware job status by job ID.
 * @param jobId Firmware job ID
 * @returns Current job state with all phases
 */
export async function getFirmwareJobStatus(jobId: string): Promise<FirmwareJob> {
  const res = await apiClient.get<FirmwareJob>(`/operations/firmware-jobs/${jobId}`);
  return res.data;
}

/**
 * Get firmware job history for a device.
 * @param deviceId Device ID
 * @returns List of firmware jobs ordered by acceptance time
 */
export async function getFirmwareJobHistory(deviceId: string): Promise<FirmwareJob[]> {
  const res = await apiClient.get<FirmwareJob[]>(`/operations/devices/${deviceId}/firmware-jobs`);
  return res.data;
}

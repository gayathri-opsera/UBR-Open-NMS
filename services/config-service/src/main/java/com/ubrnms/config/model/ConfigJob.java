package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** Bulk config push job tracking with per-device operation concurrency state (WO-018). */
@Data
@NoArgsConstructor
@Document(collection = "config_jobs")
public class ConfigJob {
    @Id
    private String id;
    private String jobType;         // BULK_CONFIG, BULK_FIRMWARE
    private String templateId;
    private int totalDevices;
    private int successCount;
    private int failureCount;
    private int pendingCount;
    private String status;          // RUNNING, COMPLETED, PARTIAL, FAILED
    private Map<String, String> perDeviceStatus = new HashMap<>(); // deviceId → status
    private Instant startedAt;
    private Instant completedAt;
    private String actor;

    // ── WO-018: Concurrency and retry visibility fields ────────────────────────
    /** Operation class for concurrency guard (e.g. CONFIG_CHANGE, FIRMWARE_UPGRADE). */
    private String operationClass;
    /** Number of retry attempts made for this job. */
    private int retryCount;
    /** Maximum retry attempts before exhaustion. */
    private int maxRetries = 3;
    /** When the next retry attempt is allowed (null when not in retry state). */
    private Instant nextRetryAt;
    /** Whether this job can be retried after a transient failure. */
    private boolean retryable;
    /** Human-readable reason for the last dispatch or execution failure. */
    private String lastFailureReason;
    /** Set when all retries are exhausted; the job is dead-lettered for manual review. */
    private Instant exhaustedAt;
    /** Current concurrency state: RUNNING, BLOCKED, QUEUED, RETRYING, EXHAUSTED */
    private String concurrencyState;
    /** The job ID that is blocking this operation (when concurrencyState=BLOCKED). */
    private String blockedByJobId;

    public int getProgressPercent() {
        if (totalDevices == 0) return 100;
        return (int) (((double)(successCount + failureCount) / totalDevices) * 100);
    }
}

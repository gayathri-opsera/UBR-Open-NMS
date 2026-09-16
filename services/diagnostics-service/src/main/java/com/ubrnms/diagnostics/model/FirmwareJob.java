package com.ubrnms.diagnostics.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/**
 * Firmware upgrade job with multi-phase tracking (WO-012).
 * Phases: ACCEPTED, PRECHECK, TRANSFER, CHECKSUM_VERIFY, INSTALL,
 * REBOOT_WAIT, POSTCHECK, SUCCEEDED, FAILED, DISCREPANCY.
 */
@Data
@NoArgsConstructor
@Document(collection = "firmware_jobs")
public class FirmwareJob {

    @Id
    private String id;

    private String deviceId;
    private String imageRef;
    private String expectedVersion;
    private String checksumAlgorithm;
    private String checksumValue;      // Stored as hash for security
    private String transferMethod;
    private String reason;
    private String actor;
    private String role;

    /** Current phase of the firmware upgrade workflow. */
    private String firmwarePhase;      // ACCEPTED, PRECHECK, TRANSFER, CHECKSUM_VERIFY, INSTALL, REBOOT_WAIT, POSTCHECK, SUCCEEDED, FAILED, DISCREPANCY

    /** Overall job status: PENDING, IN_PROGRESS, COMPLETED, FAILED. */
    private String status;

    /** Transfer progress percentage (0-100). */
    private Integer transferProgress;

    /** Checksum verification result. */
    private Boolean checksumVerified;

    /** Observed firmware version after reboot. */
    private String observedVersion;

    /** Version mismatch detected during postcheck. */
    private Boolean discrepancy;

    /** Whether the job can be retried. */
    private Boolean retryable;

    /** Compatibility decision from precheck. */
    private String compatibilityDecision;  // COMPATIBLE, INCOMPATIBLE, POLICY_BLOCKED

    /** Detailed failure reason if job fails. */
    private String failureReason;

    /** Additional result data from worker callbacks. */
    private Map<String, Object> result;

    private Instant acceptedAt;
    private Instant precheckStartedAt;
    private Instant transferStartedAt;
    private Instant checksumVerifiedAt;
    private Instant installStartedAt;
    private Instant rebootObservedAt;
    private Instant postcheckStartedAt;
    private Instant completedAt;

    private long durationMs;

    /** Idempotency key for duplicate prevention. */
    private String idempotencyKey;
}

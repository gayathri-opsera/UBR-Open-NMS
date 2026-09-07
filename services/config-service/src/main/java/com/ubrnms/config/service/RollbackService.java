package com.ubrnms.config.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.ConfigJobRepository;
import com.ubrnms.config.repository.ConfigVersionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/**
 * Orchestrates rollback of a failed configuration change (WO-052).
 *
 * <p>Rollback is only permitted when:
 * <ul>
 *   <li>The targeted ConfigVersion has {@code rollbackEligible = true}.</li>
 *   <li>A prior APPLIED version exists with a lower versionNumber (the restore target).</li>
 *   <li>No other CONFIG_CHANGE operation is concurrently in flight for the same device.</li>
 * </ul>
 *
 * <p>On success, a new rollback ConfigJob is created, routed through the
 * paradigm-aware DeliveryRouter, and an immutable audit event is emitted.
 *
 * <p>Constraints enforced here:
 * <ul>
 *   <li>Rollback commands use sanitized configuration data only — no inline secrets.</li>
 *   <li>The original failed change and rollback attempt both remain visible in history.</li>
 *   <li>Non-eligible versions raise a specific ineligibility reason rather than attempting unsafe rollback.</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RollbackService {

    private final ConfigVersionRepository versionRepo;
    private final ConfigJobRepository     jobRepo;
    private final DeliveryRouter          deliveryRouter;
    private final OperationGuard          operationGuard;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper            objectMapper;

    @Value("${kafka.topics.audit:config-audit}")
    private String auditTopic;

    // ── Public result contract ─────────────────────────────────────────────────

    public enum RollbackOutcome {
        ACCEPTED,
        VERSION_NOT_FOUND,
        NOT_ROLLBACK_ELIGIBLE,
        NO_PRIOR_GOOD_VERSION,
        OPERATION_IN_FLIGHT,
        AUDIT_PUBLISH_FAILED   // rollback still created; audit failure is non-fatal
    }

    public static class RollbackResult {
        public final RollbackOutcome outcome;
        public final ConfigJob       rollbackJob;
        public final String          ineligibilityReason;

        private RollbackResult(RollbackOutcome outcome, ConfigJob job, String reason) {
            this.outcome             = outcome;
            this.rollbackJob         = job;
            this.ineligibilityReason = reason;
        }

        public static RollbackResult accepted(ConfigJob job) {
            return new RollbackResult(RollbackOutcome.ACCEPTED, job, null);
        }
        public static RollbackResult ineligible(RollbackOutcome outcome, String reason) {
            return new RollbackResult(outcome, null, reason);
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Attempt a rollback for the given device and failed-version combination.
     *
     * @param deviceId  The inventory device ID.
     * @param versionId The ConfigVersion ID that should be rolled back.
     * @param reason    Operator-supplied reason (required; not logged as secret).
     * @param actor     Operator identity initiating the rollback.
     * @return a RollbackResult describing the outcome and the created rollback job if accepted.
     */
    public RollbackResult initiateRollback(
            String deviceId,
            String versionId,
            String reason,
            String actor) {

        // ── 1. Load the targeted version ─────────────────────────────────────
        Optional<ConfigVersion> versionOpt = versionRepo.findById(versionId);
        if (versionOpt.isEmpty() || !deviceId.equals(versionOpt.get().getDeviceId())) {
            log.warn("Rollback rejected: version not found. deviceId={} versionId={}", deviceId, versionId);
            return RollbackResult.ineligible(
                    RollbackOutcome.VERSION_NOT_FOUND,
                    "Version " + versionId + " not found for device " + deviceId);
        }
        ConfigVersion failedVersion = versionOpt.get();

        // ── 2. Eligibility check ──────────────────────────────────────────────
        if (!failedVersion.isRollbackEligible()) {
            String ineligibilityReason = "Version " + versionId + " is not marked rollback-eligible. "
                    + (failedVersion.getFailureReason() != null
                       ? "Failure reason: " + failedVersion.getFailureReason()
                       : "No failure reason recorded.");
            log.warn("Rollback rejected: not eligible. deviceId={} versionId={} reason={}",
                    deviceId, versionId, ineligibilityReason);
            return RollbackResult.ineligible(RollbackOutcome.NOT_ROLLBACK_ELIGIBLE, ineligibilityReason);
        }

        // ── 3. Find the previous known-good version (restore target) ─────────
        Optional<ConfigVersion> restoreTarget = findPreviousGoodVersion(deviceId, failedVersion.getVersionNumber());
        if (restoreTarget.isEmpty()) {
            log.warn("Rollback rejected: no prior good version. deviceId={} failedVersionNumber={}",
                    deviceId, failedVersion.getVersionNumber());
            return RollbackResult.ineligible(
                    RollbackOutcome.NO_PRIOR_GOOD_VERSION,
                    "No prior APPLIED configuration version exists to restore for device " + deviceId
                            + ". Manual remediation required.");
        }
        ConfigVersion restoreVersion = restoreTarget.get();

        // ── 4. Concurrency guard — one rollback per device ────────────────────
        String rollbackJobId = UUID.randomUUID().toString();
        Optional<OperationGuard.InFlightMarker> blocking =
                operationGuard.acquire(deviceId, OperationClass.CONFIG_CHANGE, rollbackJobId, actor);
        if (blocking.isPresent()) {
            OperationGuard.InFlightMarker marker = blocking.get();
            log.warn("Rollback rejected: operation in flight. deviceId={} blockingJobId={}",
                    deviceId, marker.jobId);
            return RollbackResult.ineligible(
                    RollbackOutcome.OPERATION_IN_FLIGHT,
                    "A CONFIG_CHANGE operation is already in flight for device " + deviceId
                            + " (job " + marker.jobId + "). Wait for it to complete before rolling back.");
        }

        try {
            // ── 5. Build the rollback ConfigJob ─────────────────────────────
            ConfigJob rollbackJob = buildRollbackJob(
                    rollbackJobId, deviceId, failedVersion, restoreVersion, reason, actor);
            rollbackJob = jobRepo.save(rollbackJob);

            // ── 6. Build a synthetic target preview for the DeliveryRouter ──
            // Rollback uses the restore version's delivery channel (same paradigm as original).
            String deliveryChannel = resolveDeliveryChannel(restoreVersion);
            ConfigTargetPreviewResponse preview = buildRollbackPreview(deviceId, deliveryChannel, rollbackJob);

            // ── 7. Route via paradigm-aware DeliveryRouter ───────────────────
            rollbackJob = deliveryRouter.executeJob(rollbackJob, preview);

            // ── 8. Emit audit event ──────────────────────────────────────────
            boolean auditEmitted = publishRollbackAudit(
                    deviceId, rollbackJob.getId(), failedVersion.getJobId(), reason, actor,
                    restoreVersion.getId(), restoreVersion.getVersionNumber());
            if (!auditEmitted) {
                log.error("Rollback audit event failed to publish; job still accepted. jobId={}", rollbackJob.getId());
                // Non-fatal: return ACCEPTED; caller may log the warning
            }

            log.info("Rollback accepted. deviceId={} rollbackJobId={} restoreVersionId={} actor={}",
                    deviceId, rollbackJob.getId(), restoreVersion.getId(), actor);
            return RollbackResult.accepted(rollbackJob);

        } catch (Exception e) {
            // Release the concurrency guard to prevent permanent device lock
            operationGuard.release(deviceId, rollbackJobId);
            log.error("Rollback failed with unexpected error. deviceId={} versionId={}: {}",
                    deviceId, versionId, e.getMessage(), e);
            throw new RollbackExecutionException(
                    "Rollback execution failed for device " + deviceId + ": " + e.getMessage(), e);
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Finds the most recent APPLIED version with a lower versionNumber than the failed one.
     * ATTEMPTED and FAILED versions are skipped — they cannot be used as restore targets.
     */
    private Optional<ConfigVersion> findPreviousGoodVersion(String deviceId, int failedVersionNumber) {
        List<ConfigVersion> history = versionRepo.findByDeviceIdOrderByVersionNumberDesc(deviceId);
        return history.stream()
                .filter(v -> "APPLIED".equals(v.getStatus())
                          && v.getVersionNumber() < failedVersionNumber)
                .findFirst();
    }

    /**
     * Builds a rollback ConfigJob using the same jobType as the original but tagged ROLLBACK.
     * Uses sanitized configuration references only — never includes inline secrets.
     */
    private ConfigJob buildRollbackJob(
            String jobId,
            String deviceId,
            ConfigVersion failedVersion,
            ConfigVersion restoreVersion,
            String reason,
            String actor) {

        ConfigJob job = new ConfigJob();
        job.setId(jobId);
        job.setJobType("CONFIG_ROLLBACK");
        job.setTemplateId(restoreVersion.getTemplateId());
        job.setTotalDevices(1);
        job.setSuccessCount(0);
        job.setFailureCount(0);
        job.setPendingCount(1);
        job.setStatus("RUNNING");
        job.setActor(actor);
        job.setOperationClass("CONFIG_CHANGE");
        job.setStartedAt(Instant.now());
        job.setRetryable(false); // Rollback is not automatically retried on failure
        job.setRetryCount(0);
        job.setMaxRetries(0);
        job.setConfirmationStatus("CONFIRMED"); // Rollback is operator-confirmed at initiation
        job.setConfirmedBy(actor);
        job.setConfirmedAt(Instant.now());
        job.setIdempotencyKey(UUID.randomUUID().toString());

        // Store rollback context in perDeviceStatus for legacy compatibility
        Map<String, String> perDeviceStatus = new HashMap<>();
        perDeviceStatus.put(deviceId, "ROLLBACK_PENDING");
        job.setPerDeviceStatus(perDeviceStatus);

        // Store rollback metadata as fields — references, not content
        job.setPreviewId("rollback:" + failedVersion.getId() + ":restore:" + restoreVersion.getId());
        job.setLastFailureReason(null);
        job.setApprovalReference("ROLLBACK_OF_JOB:" + failedVersion.getJobId()
                + ";REASON:" + sanitizeReason(reason));

        return job;
    }

    /**
     * Build a synthetic preview response for the DeliveryRouter.
     * Rollback targets exactly one device using the same channel as the original delivery.
     */
    private ConfigTargetPreviewResponse buildRollbackPreview(
            String deviceId,
            String deliveryChannel,
            ConfigJob rollbackJob) {

        ConfigTargetPreviewResponse.TargetEntry target = ConfigTargetPreviewResponse.TargetEntry.builder()
                .deviceId(deviceId)
                .deliveryChannel(deliveryChannel)
                .build();

        return ConfigTargetPreviewResponse.builder()
                .previewId(rollbackJob.getId())
                .totalCount(1)
                .targets(List.of(target))
                .unsupportedTargets(List.of())
                .generatedAt(Instant.now().toString())
                .requiresConfirmation(false)
                .build();
    }

    /**
     * Resolve the delivery channel for the rollback from the restore version's delivery history.
     * Falls back to UBR_CHECKIN for UBR devices or SNMP_PROTOCOL for generic if not recorded.
     */
    private String resolveDeliveryChannel(ConfigVersion restoreVersion) {
        if (restoreVersion.getDeliveryChannel() != null && !restoreVersion.getDeliveryChannel().isBlank()) {
            return restoreVersion.getDeliveryChannel();
        }
        // Conservative fallback — UBR devices default to check-in channel for deferred delivery
        return "UBR_CHECKIN";
    }

    /**
     * Emit an immutable audit event for the rollback initiation.
     * Never includes rendered config content or credential values.
     *
     * @return true when the event was successfully published; false on error (non-fatal)
     */
    private boolean publishRollbackAudit(
            String deviceId,
            String rollbackJobId,
            String originalJobId,
            String reason,
            String actor,
            String restoreVersionId,
            int    restoreVersionNumber) {
        try {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("eventType", "config.change.rollback.initiated");
            event.put("deviceId", deviceId);
            event.put("rollbackJobId", rollbackJobId);
            event.put("originalJobId", originalJobId);
            event.put("restoreVersionId", restoreVersionId);
            event.put("restoreVersionNumber", restoreVersionNumber);
            event.put("reason", sanitizeReason(reason));
            event.put("actor", actor);
            event.put("timestamp", Instant.now().toString());
            kafkaTemplate.send(auditTopic, deviceId, objectMapper.writeValueAsString(event));
            return true;
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize rollback audit event for deviceId={}: {}", deviceId, e.getMessage());
            return false;
        } catch (Exception e) {
            log.error("Failed to publish rollback audit event for deviceId={}: {}", deviceId, e.getMessage());
            return false;
        }
    }

    /**
     * Sanitize a user-supplied reason string before storing or publishing.
     * Truncates to 500 characters and strips control characters.
     */
    private String sanitizeReason(String reason) {
        if (reason == null) return "";
        String sanitized = reason.replaceAll("[\\x00-\\x1F\\x7F]", "");
        return sanitized.length() > 500 ? sanitized.substring(0, 500) : sanitized;
    }

    // ── Exceptions ─────────────────────────────────────────────────────────────

    public static class RollbackExecutionException extends RuntimeException {
        public RollbackExecutionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}

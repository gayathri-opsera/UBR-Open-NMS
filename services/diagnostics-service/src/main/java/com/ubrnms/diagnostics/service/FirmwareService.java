package com.ubrnms.diagnostics.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.diagnostics.model.FirmwareJob;
import com.ubrnms.diagnostics.model.FirmwareUpgradeRequest;
import com.ubrnms.diagnostics.model.FirmwareUpgradeResponse;
import com.ubrnms.diagnostics.repository.FirmwareJobRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ClassPathResource;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/**
 * Firmware upgrade workflow service (WO-012).
 * Handles multi-phase firmware upgrades with compatibility checks,
 * checksum verification, and post-reboot discrepancy detection.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FirmwareService {

    private final FirmwareJobRepository jobRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final DeviceStatusChecker deviceStatusChecker;
    private final ObjectMapper objectMapper;

    private static final String FIRMWARE_COMMANDS_TOPIC = "firmware-commands";
    private static final String AUDIT_EVENTS_TOPIC = "audit-events";

    /**
     * Submit a firmware upgrade request (Step 2-4).
     * Performs precheck, compatibility validation, and creates a tracked job.
     */
    public FirmwareUpgradeResponse submitFirmwareUpgrade(
            String deviceId,
            FirmwareUpgradeRequest request,
            String actor,
            String role) throws Exception {

        // Idempotency check
        if (request.getIdempotencyKey() != null) {
            Optional<FirmwareJob> existing = jobRepo.findByIdempotencyKey(request.getIdempotencyKey());
            if (existing.isPresent()) {
                log.info("Idempotent firmware request for device {} with key {}", deviceId, request.getIdempotencyKey());
                return FirmwareUpgradeResponse.fromJob(existing.get());
            }
        }

        // Check for conflicting in-flight operations
        List<FirmwareJob> inFlight = jobRepo.findByDeviceIdAndStatusIn(deviceId, Arrays.asList("PENDING", "IN_PROGRESS"));
        if (!inFlight.isEmpty()) {
            throw new IllegalStateException("Device " + deviceId + " has an in-flight firmware operation (job " + inFlight.get(0).getId() + ")");
        }

        // Verify device is online
        if (!deviceStatusChecker.isOnline(deviceId)) {
            throw new IllegalStateException("Device " + deviceId + " is offline — firmware upgrades require an active connection");
        }

        // Require explicit confirmation for destructive firmware operations (RTM REQ-008)
        if (!Boolean.TRUE.equals(request.getConfirmation())) {
            throw new IllegalArgumentException("Firmware upgrade requires explicit confirmation — set confirmation=true to proceed");
        }

        // Create firmware job
        FirmwareJob job = new FirmwareJob();
        job.setDeviceId(deviceId);
        job.setImageRef(request.getImageRef());
        job.setExpectedVersion(request.getExpectedVersion());
        job.setChecksumAlgorithm(request.getChecksumAlgorithm());
        job.setChecksumValue(hashChecksum(request.getChecksumValue())); // Hash for security
        job.setTransferMethod(request.getTransferMethod());
        job.setReason(request.getReason());
        job.setActor(actor);
        job.setRole(role);
        job.setIdempotencyKey(request.getIdempotencyKey());
        job.setFirmwarePhase("ACCEPTED");
        job.setStatus("PENDING");
        job.setAcceptedAt(Instant.now());
        job.setRetryable(true);

        job = jobRepo.save(job);

        // Emit audit event for submission
        publishAuditEvent(job, "FIRMWARE_UPGRADE_SUBMITTED", Map.of(
                "expectedVersion", request.getExpectedVersion(),
                "imageRef", request.getImageRef()
        ));

        // Start precheck phase asynchronously
        startPrecheck(job);

        return FirmwareUpgradeResponse.fromJob(job);
    }

    /**
     * Phase 1: Precheck - Compatibility and safety validation (Step 3).
     */
    private void startPrecheck(FirmwareJob job) {
        job.setFirmwarePhase("PRECHECK");
        job.setPrecheckStartedAt(Instant.now());
        job = jobRepo.save(job);

        try {
            // Load compatibility matrix
            Map<String, Object> compatibility = loadCompatibilityMatrix();
            String deviceModel = getDeviceModel(job.getDeviceId());
            String currentVersion = getCurrentFirmwareVersion(job.getDeviceId());

            // Validate compatibility
            String decision = validateCompatibility(deviceModel, currentVersion, job.getExpectedVersion(), compatibility);
            job.setCompatibilityDecision(decision);

            if ("INCOMPATIBLE".equals(decision) || "POLICY_BLOCKED".equals(decision)) {
                job.setStatus("FAILED");
                job.setFirmwarePhase("FAILED");
                job.setFailureReason("Firmware upgrade blocked: " + decision + " (current: " + currentVersion + ", target: " + job.getExpectedVersion() + ")");
                job.setRetryable(false);
                job.setCompletedAt(Instant.now());
                jobRepo.save(job);

                publishAuditEvent(job, "FIRMWARE_PRECHECK_FAILED", Map.of(
                        "decision", decision,
                        "reason", job.getFailureReason()
                ));
                return;
            }

            // Precheck passed - proceed to transfer
            job.setCompatibilityDecision("COMPATIBLE");
            jobRepo.save(job);

            publishAuditEvent(job, "FIRMWARE_PRECHECK_PASSED", Map.of(
                    "currentVersion", currentVersion,
                    "targetVersion", job.getExpectedVersion()
            ));

            // Publish firmware command to Kafka for worker execution
            publishFirmwareCommand(job);

        } catch (Exception e) {
            log.error("Precheck failed for job {}", job.getId(), e);
            job.setStatus("FAILED");
            job.setFirmwarePhase("FAILED");
            job.setFailureReason("Precheck error: " + e.getMessage());
            job.setCompletedAt(Instant.now());
            jobRepo.save(job);
        }
    }

    /**
     * Publish firmware upgrade command to Kafka (Step 5).
     */
    private void publishFirmwareCommand(FirmwareJob job) throws Exception {
        Map<String, Object> cmd = new LinkedHashMap<>();
        cmd.put("jobId", job.getId());
        cmd.put("deviceId", job.getDeviceId());
        cmd.put("commandType", "FIRMWARE_UPGRADE");
        cmd.put("imageRef", job.getImageRef());
        cmd.put("expectedVersion", job.getExpectedVersion());
        cmd.put("checksumAlgorithm", job.getChecksumAlgorithm());
        cmd.put("checksumValue", job.getChecksumValue());
        cmd.put("transferMethod", job.getTransferMethod());
        cmd.put("actor", job.getActor());

        kafkaTemplate.send(FIRMWARE_COMMANDS_TOPIC, job.getDeviceId(), objectMapper.writeValueAsString(cmd));
        log.info("Published firmware command for job {}", job.getId());

        job.setStatus("IN_PROGRESS");
        job.setFirmwarePhase("TRANSFER");
        job.setTransferStartedAt(Instant.now());
        jobRepo.save(job);
    }

    /**
     * Handle worker callbacks for firmware phases (Step 6).
     */
    public FirmwareJob handlePhaseCallback(String jobId, String phase, Map<String, Object> data) {
        return jobRepo.findById(jobId).map(job -> {
            log.info("Firmware job {} phase callback: {}", jobId, phase);

            switch (phase) {
                case "TRANSFER_PROGRESS":
                    job.setTransferProgress((Integer) data.get("progress"));
                    break;

                case "TRANSFER_COMPLETE":
                    job.setFirmwarePhase("CHECKSUM_VERIFY");
                    job.setTransferProgress(100);
                    break;

                case "CHECKSUM_SUCCESS":
                    job.setChecksumVerified(true);
                    job.setChecksumVerifiedAt(Instant.now());
                    job.setFirmwarePhase("INSTALL");
                    job.setInstallStartedAt(Instant.now());
                    publishAuditEvent(job, "FIRMWARE_CHECKSUM_VERIFIED", data);
                    break;

                case "CHECKSUM_FAILURE":
                    job.setChecksumVerified(false);
                    job.setStatus("FAILED");
                    job.setFirmwarePhase("FAILED");
                    job.setFailureReason("Checksum verification failed: " + data.get("reason"));
                    job.setCompletedAt(Instant.now());
                    job.setRetryable(true);
                    publishAuditEvent(job, "FIRMWARE_CHECKSUM_FAILED", data);
                    break;

                case "INSTALL_COMPLETE":
                    job.setFirmwarePhase("REBOOT_WAIT");
                    break;

                case "REBOOT_OBSERVED":
                    job.setRebootObservedAt(Instant.now());
                    job.setFirmwarePhase("POSTCHECK");
                    job.setPostcheckStartedAt(Instant.now());
                    break;

                case "POSTCHECK_COMPLETE":
                    String observedVersion = (String) data.get("observedVersion");
                    job.setObservedVersion(observedVersion);

                    // Check for version mismatch (discrepancy)
                    boolean versionMatch = job.getExpectedVersion().equals(observedVersion);
                    job.setDiscrepancy(!versionMatch);

                    if (versionMatch) {
                        job.setStatus("COMPLETED");
                        job.setFirmwarePhase("SUCCEEDED");
                    } else {
                        job.setStatus("COMPLETED");
                        job.setFirmwarePhase("DISCREPANCY");
                        job.setFailureReason("Version mismatch: expected " + job.getExpectedVersion() + ", observed " + observedVersion);
                    }
                    job.setCompletedAt(Instant.now());
                    job.setDurationMs(job.getCompletedAt().toEpochMilli() - job.getAcceptedAt().toEpochMilli());

                    publishAuditEvent(job, "FIRMWARE_POSTCHECK_COMPLETE", Map.of(
                            "expectedVersion", job.getExpectedVersion(),
                            "observedVersion", observedVersion,
                            "discrepancy", job.getDiscrepancy()
                    ));
                    break;

                case "FAILURE":
                    job.setStatus("FAILED");
                    job.setFirmwarePhase("FAILED");
                    job.setFailureReason((String) data.get("reason"));
                    job.setCompletedAt(Instant.now());
                    job.setRetryable(Boolean.TRUE.equals(data.get("retryable")));
                    publishAuditEvent(job, "FIRMWARE_UPGRADE_FAILED", data);
                    break;
            }

            job.setResult(data);
            return jobRepo.save(job);
        }).orElse(null);
    }

    /**
     * Get firmware job by ID.
     */
    public Optional<FirmwareJob> getJob(String jobId) {
        return jobRepo.findById(jobId);
    }

    /**
     * Get firmware job history for a device.
     */
    public List<FirmwareJob> getJobHistory(String deviceId) {
        return jobRepo.findByDeviceIdOrderByAcceptedAtDesc(deviceId);
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private Map<String, Object> loadCompatibilityMatrix() throws IOException {
        ClassPathResource resource = new ClassPathResource("firmware-compatibility-matrix.json");
        return objectMapper.readValue(resource.getInputStream(), Map.class);
    }

    private String validateCompatibility(String deviceModel, String currentVersion, String targetVersion, Map<String, Object> matrix) {
        // Simplified compatibility logic - real implementation would parse semver and check rules
        List<Map<String, Object>> rules = (List<Map<String, Object>>) matrix.get("compatibilityRules");
        Map<String, Object> policyRules = (Map<String, Object>) matrix.get("policyRules");

        // Check for downgrade
        if (Boolean.TRUE.equals(policyRules.get("blockDowngrades"))) {
            if (compareVersions(targetVersion, currentVersion) < 0) {
                return "POLICY_BLOCKED";
            }
        }

        // Find matching rule
        for (Map<String, Object> rule : rules) {
            if (rule.get("deviceModel").equals(deviceModel) || rule.get("deviceModel").equals("GENERIC")) {
                String minVersion = (String) rule.get("targetVersionMin");
                String maxVersion = (String) rule.get("targetVersionMax");

                if (compareVersions(targetVersion, minVersion) >= 0 && compareVersions(targetVersion, maxVersion) <= 0) {
                    return "COMPATIBLE";
                }
            }
        }

        return "INCOMPATIBLE";
    }

    private int compareVersions(String v1, String v2) {
        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");
        int length = Math.max(parts1.length, parts2.length);

        for (int i = 0; i < length; i++) {
            int num1 = i < parts1.length ? Integer.parseInt(parts1[i].replaceAll("[^0-9]", "")) : 0;
            int num2 = i < parts2.length ? Integer.parseInt(parts2[i].replaceAll("[^0-9]", "")) : 0;
            if (num1 != num2) {
                return Integer.compare(num1, num2);
            }
        }
        return 0;
    }

    private String hashChecksum(String checksum) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(checksum.getBytes());
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return checksum; // Fallback
        }
    }

    private void publishAuditEvent(FirmwareJob job, String eventType, Map<String, Object> additionalData) {
        try {
            Map<String, Object> audit = new LinkedHashMap<>();
            audit.put("eventType", eventType);
            audit.put("actor", job.getActor());
            audit.put("deviceId", job.getDeviceId());
            audit.put("jobId", job.getId());
            audit.put("firmwarePhase", job.getFirmwarePhase());
            audit.put("timestamp", Instant.now().toString());
            audit.putAll(additionalData);

            kafkaTemplate.send(AUDIT_EVENTS_TOPIC, job.getDeviceId(), objectMapper.writeValueAsString(audit));
        } catch (Exception e) {
            log.error("Failed to publish audit event", e);
        }
    }

    private String getDeviceModel(String deviceId) {
        // Simplified - real implementation would query device inventory
        if (deviceId.contains("bts")) return "UBR-BTS-A60";
        if (deviceId.contains("cpe")) return "UBR-CPE-A61";
        if (deviceId.contains("idu")) return "UBR-IDU-I22";
        return "GENERIC";
    }

    private String getCurrentFirmwareVersion(String deviceId) {
        // Simplified - real implementation would query device inventory
        return "3.4.1";
    }
}

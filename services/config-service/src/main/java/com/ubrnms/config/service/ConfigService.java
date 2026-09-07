package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.Optional;

@Slf4j
@Service
@RequiredArgsConstructor
public class ConfigService {

    private final ConfigTemplateRepository templateRepo;
    private final PendingCommandRepository pendingRepo;
    private final ConfigVersionRepository versionRepo;
    private final ConfigJobRepository jobRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;

    // External device status check — injected via DeviceStatusChecker
    private final DeviceStatusChecker deviceStatusChecker;

    // WO-033: onboarding assignment gate eligibility check
    private final DeviceEligibilityChecker deviceEligibilityChecker;

    // WO-018: per-device operation concurrency guard
    private final OperationGuard operationGuard;

    @Value("${kafka.topics.config-push:config-push}")
    private String configPushTopic;

    @Value("${config.pending-command.ttl-hours:72}")
    private int ttlHours;

    // ── Template CRUD ──────────────────────────────────────────────

    public ConfigTemplate createTemplate(ConfigTemplate template) {
        template.setCreatedAt(Instant.now());
        return templateRepo.save(template);
    }

    public List<ConfigTemplate> listTemplates() {
        return templateRepo.findAll();
    }

    public ConfigTemplate getTemplate(String id) {
        return templateRepo.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Template not found: " + id));
    }

    public ConfigTemplate updateTemplate(String id, ConfigTemplate patch) {
        ConfigTemplate existing = getTemplate(id);
        if (patch.getName() != null)       existing.setName(patch.getName());
        if (patch.getDescription() != null) existing.setDescription(patch.getDescription());
        if (patch.getDeviceType() != null)  existing.setDeviceType(patch.getDeviceType());
        if (patch.getSsid24() != null)      existing.setSsid24(patch.getSsid24());
        if (patch.getFirmwareVersion() != null) existing.setFirmwareVersion(patch.getFirmwareVersion());
        return templateRepo.save(existing);
    }

    public void deleteTemplate(String id) {
        templateRepo.deleteById(id);
    }

    public ConfigTemplate setDefault(String id) {
        templateRepo.findByIsDefaultTrue().ifPresent(prev -> {
            prev.setDefault(false);
            templateRepo.save(prev);
        });
        ConfigTemplate template = getTemplate(id);
        template.setDefault(true);
        return templateRepo.save(template);
    }

    // ── Config Push ────────────────────────────────────────────────

    /**
     * Push config to a single device.
     * - If the device is in PENDING_ASSIGNMENT or CONFIG_WITHHELD state (WO-033) → return DELIVERY_WITHHELD.
     * - If a conflicting exclusive operation is in flight (WO-018) → return 409.
     * - If device is offline AND it's a firmware/bulk command → queue it.
     * - If device is offline AND it's an individual config command → reject with 503.
     * - If device is online → publish to Kafka.
     */
    public PushResult pushConfig(String deviceId, String templateId, String actor,
                                  boolean isFirmwareOrBulk) {
        // WO-033: check onboarding gate eligibility before any other operation.
        // PENDING_ASSIGNMENT and CONFIG_WITHHELD devices must never receive config pushes.
        DeviceEligibilityChecker.IneligibilityReason ineligible =
                deviceEligibilityChecker.checkEligibility(deviceId);
        if (ineligible != null) {
            log.info("Config push withheld for device={} reason={}", deviceId, ineligible);
            return PushResult.deliveryWithheld(ineligible.name());
        }

        // WO-018: acquire the per-device operation lock before any state change
        OperationClass opClass = isFirmwareOrBulk ? OperationClass.FIRMWARE_UPGRADE : OperationClass.CONFIG_CHANGE;
        String tempJobId = UUID.randomUUID().toString();
        Optional<OperationGuard.InFlightMarker> conflict = operationGuard.acquire(deviceId, opClass, tempJobId, actor);
        if (conflict.isPresent()) {
            OperationGuard.InFlightMarker blocker = conflict.get();
            log.warn("Config push blocked: device={} blocked by class={} job={}",
                    deviceId, blocker.operationClass, blocker.jobId);
            return PushResult.operationInFlight(blocker.jobId, blocker.operationClass.name());
        }

        try {
            boolean online = deviceStatusChecker.isOnline(deviceId);

            if (!online) {
                if (isFirmwareOrBulk) {
                    PendingCommand cmd = queueCommand(deviceId, templateId, "CONFIG_PUSH", null, actor);
                    return PushResult.queued(cmd.getId());
                } else {
                    return PushResult.deviceOffline();
                }
            }

            publishConfigPush(deviceId, templateId, null, actor);
            recordVersion(deviceId, templateId, actor);
            return PushResult.published();
        } finally {
            operationGuard.release(deviceId, tempJobId);
        }
    }

    /**
     * Bulk push to a list of device IDs.
     * WO-018: checks per-device operation guard for each device before dispatch.
     */
    public ConfigJob bulkPush(List<String> deviceIds, String templateId, String actor) {
        ConfigJob job = new ConfigJob();
        job.setId(UUID.randomUUID().toString());
        job.setJobType("BULK_CONFIG");
        job.setTemplateId(templateId);
        job.setOperationClass(OperationClass.CONFIG_CHANGE.name());
        job.setTotalDevices(deviceIds.size());
        job.setPendingCount(deviceIds.size());
        job.setStatus("RUNNING");
        job.setRetryable(true);
        job.setMaxRetries(3);
        job.setStartedAt(Instant.now());
        job.setActor(actor);
        job = jobRepo.save(job);

        for (String deviceId : deviceIds) {
            // WO-018: guard check per device
            Optional<OperationGuard.InFlightMarker> conflict =
                    operationGuard.acquire(deviceId, OperationClass.CONFIG_CHANGE, job.getId(), actor);
            if (conflict.isPresent()) {
                OperationGuard.InFlightMarker blocker = conflict.get();
                job.getPerDeviceStatus().put(deviceId, "BLOCKED");
                job.setConcurrencyState("BLOCKED");
                job.setBlockedByJobId(blocker.jobId);
                job.setFailureCount(job.getFailureCount() + 1);
                log.warn("Bulk push blocked for device={} by job={}", deviceId, blocker.jobId);
                continue;
            }

            try {
                // WO-033: skip devices in PENDING_ASSIGNMENT or CONFIG_WITHHELD state.
                DeviceEligibilityChecker.IneligibilityReason ineligible =
                        deviceEligibilityChecker.checkEligibility(deviceId);
                if (ineligible != null) {
                    job.getPerDeviceStatus().put(deviceId, "WITHHELD:" + ineligible.name());
                    log.info("Bulk push withheld for device={} reason={}", deviceId, ineligible);
                    continue;
                }

                boolean online = deviceStatusChecker.isOnline(deviceId);
                if (online) {
                    publishConfigPush(deviceId, templateId, job.getId(), actor);
                    job.getPerDeviceStatus().put(deviceId, "PUBLISHED");
                    job.setSuccessCount(job.getSuccessCount() + 1);
                } else {
                    queueCommand(deviceId, templateId, "BULK_CONFIG", job.getId(), actor);
                    job.getPerDeviceStatus().put(deviceId, "QUEUED");
                }
            } finally {
                operationGuard.release(deviceId, job.getId());
            }
            job.setPendingCount(job.getTotalDevices() - job.getSuccessCount() - job.getFailureCount());
        }

        job.setStatus(job.getSuccessCount() == deviceIds.size() ? "COMPLETED" : "PARTIAL");
        job.setCompletedAt(Instant.now());
        return jobRepo.save(job);
    }

    public ConfigJob getJobStatus(String jobId) {
        return jobRepo.findById(jobId)
                .orElseThrow(() -> new NoSuchElementException("Job not found: " + jobId));
    }

    // ── Pending commands ───────────────────────────────────────────

    public List<PendingCommand> getPendingCommands(String deviceId) {
        return pendingRepo.findByDeviceIdAndStatusOrderByCreatedAtAsc(deviceId, "PENDING");
    }

    public long getPendingCommandCount(String deviceId) {
        return pendingRepo.countByDeviceIdAndStatus(deviceId, "PENDING");
    }

    /** Called when device reconnects — delivers queued FIFO commands. */
    public void deliverPendingCommands(String deviceId) {
        List<PendingCommand> pending =
                pendingRepo.findByDeviceIdAndStatusOrderByCreatedAtAsc(deviceId, "PENDING");
        for (PendingCommand cmd : pending) {
            publishConfigPush(deviceId, cmd.getTemplateId(), cmd.getJobId(), cmd.getActor());
            cmd.setStatus("DELIVERED");
            cmd.setDeliveredAt(Instant.now());
            pendingRepo.save(cmd);
        }
    }

    // ── Version history ────────────────────────────────────────────

    public List<ConfigVersion> getVersionHistory(String deviceId) {
        return versionRepo.findByDeviceIdOrderByVersionNumberDesc(deviceId);
    }

    // ── Scheduled TTL expiry ───────────────────────────────────────

    @Scheduled(fixedDelayString = "${config.ttl-check-interval-ms:300000}")
    public void expireStaleCommands() {
        List<PendingCommand> stale =
                pendingRepo.findByStatusAndExpiresAtBefore("PENDING", Instant.now());
        for (PendingCommand cmd : stale) {
            cmd.setStatus("EXPIRED");
            pendingRepo.save(cmd);
        }
        if (!stale.isEmpty()) {
            log.info("Expired {} stale pending commands", stale.size());
        }
    }

    // ── Private helpers ────────────────────────────────────────────

    private PendingCommand queueCommand(String deviceId, String templateId,
                                         String type, String jobId, String actor) {
        PendingCommand cmd = new PendingCommand();
        cmd.setDeviceId(deviceId);
        cmd.setTemplateId(templateId);
        cmd.setCommandType(type);
        cmd.setJobId(jobId);
        cmd.setStatus("PENDING");
        cmd.setActor(actor);
        cmd.setCreatedAt(Instant.now());
        cmd.setExpiresAt(Instant.now().plus(ttlHours, ChronoUnit.HOURS));
        return pendingRepo.save(cmd);
    }

    private void publishConfigPush(String deviceId, String templateId, String jobId, String actor) {
        try {
            Map<String, Object> msg = new LinkedHashMap<>();
            msg.put("deviceId", deviceId);
            msg.put("templateId", templateId);
            msg.put("jobId", jobId);
            msg.put("actor", actor);
            msg.put("timestamp", Instant.now().toString());
            kafkaTemplate.send(configPushTopic, deviceId, objectMapper.writeValueAsString(msg));
        } catch (Exception e) {
            log.error("Failed to publish config push event", e);
        }
    }

    private void recordVersion(String deviceId, String templateId, String actor) {
        int next = versionRepo.countByDeviceId(deviceId) + 1;
        ConfigVersion cv = new ConfigVersion();
        cv.setDeviceId(deviceId);
        cv.setTemplateId(templateId);
        cv.setVersionNumber(next);
        cv.setActor(actor);
        cv.setAppliedAt(Instant.now());
        cv.setStatus("APPLIED");
        versionRepo.save(cv);
    }

    // ── Result type ────────────────────────────────────────────────

    public static class PushResult {
        public enum Type { PUBLISHED, QUEUED, DEVICE_OFFLINE, OPERATION_IN_FLIGHT, DELIVERY_WITHHELD }
        public final Type type;
        public final String queuedCommandId;
        /** Set when type=OPERATION_IN_FLIGHT: the job ID already holding the lock. */
        public final String existingOperationJobId;
        /** Set when type=OPERATION_IN_FLIGHT: the operation class already in flight. */
        public final String existingOperationClass;
        /** Set when type=DELIVERY_WITHHELD: the reason config delivery is blocked (WO-033). */
        public final String withheldReason;

        private PushResult(Type type, String id, String existingJobId, String existingClass, String withheldReason) {
            this.type = type;
            this.queuedCommandId = id;
            this.existingOperationJobId = existingJobId;
            this.existingOperationClass = existingClass;
            this.withheldReason = withheldReason;
        }

        static PushResult published()     { return new PushResult(Type.PUBLISHED, null, null, null, null); }
        static PushResult queued(String id) { return new PushResult(Type.QUEUED, id, null, null, null); }
        static PushResult deviceOffline() { return new PushResult(Type.DEVICE_OFFLINE, null, null, null, null); }

        /** WO-018: returned when a conflicting exclusive operation is already in flight. */
        static PushResult operationInFlight(String existingJobId, String existingClass) {
            return new PushResult(Type.OPERATION_IN_FLIGHT, null, existingJobId, existingClass, null);
        }

        /**
         * WO-033: returned when the device is in PENDING_ASSIGNMENT or CONFIG_WITHHELD state.
         * Config delivery is explicitly skipped with an auditable reason.
         */
        static PushResult deliveryWithheld(String reason) {
            return new PushResult(Type.DELIVERY_WITHHELD, null, null, null, reason);
        }
    }
}

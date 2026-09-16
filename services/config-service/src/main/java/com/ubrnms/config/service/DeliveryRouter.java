package com.ubrnms.config.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.ConfigJobRepository;
import com.ubrnms.config.repository.PendingCommandRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

/**
 * Routes each confirmed job target to the correct delivery channel (WO-049).
 *
 * <p>Routing rules:
 * <ul>
 *   <li>UBR_REALTIME — persist a pending command AND attempt a realtime check-in nudge
 *       via a Kafka force-check-in event. If the nudge fails, the command remains queued.</li>
 *   <li>UBR_CHECKIN — persist a pending command for retrieval by the Check-In Service.</li>
 *   <li>SNMP_PROTOCOL / CLI_PROTOCOL — publish a routed Kafka message to the config-push
 *       topic with the protocol order hint for the config-push-worker to follow.</li>
 *   <li>UNSUPPORTED — mark the device failed immediately without queuing any command.</li>
 * </ul>
 *
 * <p>Cross-paradigm fallback is explicitly blocked: a UBR call-home device must not be
 * treated as a generic SNMP target unless its deliveryChannel says so.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DeliveryRouter {

    private final PendingCommandRepository pendingRepo;
    private final ConfigJobRepository jobRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final DeviceStatusChecker deviceStatusChecker;

    @Value("${kafka.topics.config-push:config-push}")
    private String configPushTopic;

    @Value("${kafka.topics.force-checkin:force-checkin}")
    private String forceCheckinTopic;

    @Value("${config.pending-command.ttl-hours:72}")
    private int ttlHours;

    // ── Supported channels ─────────────────────────────────────────────────────

    private static final Set<String> UBR_CHANNELS = Set.of("UBR_REALTIME", "UBR_CHECKIN");
    private static final Set<String> GENERIC_CHANNELS = Set.of("SNMP_PROTOCOL", "CLI_PROTOCOL");

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Execute all targets in a confirmed job by routing each to the correct channel.
     * Updates the job's perDeviceDelivery list and persists counts.
     *
     * @param job     the accepted job (must have targets in perDeviceStatus or perDeviceDelivery)
     * @param preview the preview that was confirmed (provides deliveryChannel per device)
     * @return the updated job
     */
    public ConfigJob executeJob(ConfigJob job, ConfigTargetPreviewResponse preview) {
        List<PerDeviceDeliveryRecord> deliveryRecords = new ArrayList<>();
        int queuedCount = 0;

        for (ConfigTargetPreviewResponse.TargetEntry target : preview.getTargets()) {
            PerDeviceDeliveryRecord record = routeTarget(job, target);
            deliveryRecords.add(record);

            if ("QUEUED".equals(record.getCurrentState())) {
                queuedCount++;
            } else if ("PUBLISHED".equals(record.getCurrentState())) {
                job.setSuccessCount(job.getSuccessCount() + 1);
            } else if ("FAILED".equals(record.getCurrentState()) || "UNSUPPORTED".equals(record.getCurrentState())) {
                job.setFailureCount(job.getFailureCount() + 1);
            }

            // Keep legacy perDeviceStatus map in sync for backward compatibility
            job.getPerDeviceStatus().put(target.getDeviceId(), record.getCurrentState());
        }

        job.setPerDeviceDelivery(deliveryRecords);
        job.setQueuedCount(queuedCount);
        job.setPendingCount(job.getTotalDevices() - job.getSuccessCount() - job.getFailureCount() - queuedCount);

        boolean allDone = job.getSuccessCount() + job.getFailureCount() == job.getTotalDevices();
        boolean anyFailed = job.getFailureCount() > 0;
        boolean anyQueued = queuedCount > 0;

        if (allDone && !anyFailed) {
            job.setStatus("COMPLETED");
        } else if (allDone) {
            job.setStatus("PARTIAL");
        } else if (anyQueued) {
            job.setStatus("RUNNING_QUEUED");
        } else {
            job.setStatus("RUNNING");
        }

        job.setCompletedAt(allDone ? Instant.now() : null);
        return jobRepo.save(job);
    }

    // ── Private routing logic ──────────────────────────────────────────────────

    private PerDeviceDeliveryRecord routeTarget(ConfigJob job, ConfigTargetPreviewResponse.TargetEntry target) {
        String deviceId = target.getDeviceId();
        String channel  = target.getDeliveryChannel();
        String idemKey  = UUID.randomUUID().toString();

        if ("UNSUPPORTED".equals(channel)) {
            return unsupportedRecord(deviceId, channel, "No supported delivery protocol for this device");
        }

        if (UBR_CHANNELS.contains(channel)) {
            return routeUbrTarget(job, target, idemKey);
        }

        if (GENERIC_CHANNELS.contains(channel)) {
            return routeGenericTarget(job, target, idemKey);
        }

        // Unknown channel — fail fast without cross-paradigm fallback
        return unsupportedRecord(deviceId, channel, "Unknown delivery channel: " + channel);
    }

    /**
     * UBR call-home routing.
     * Always persists a pending command. If the device is online, attempts a realtime nudge.
     */
    private PerDeviceDeliveryRecord routeUbrTarget(
            ConfigJob job,
            ConfigTargetPreviewResponse.TargetEntry target,
            String idemKey) {

        String deviceId = target.getDeviceId();
        String channel  = target.getDeliveryChannel();
        Instant now     = Instant.now();

        PerDeviceDeliveryRecord.PerDeviceDeliveryRecordBuilder rb = PerDeviceDeliveryRecord.builder()
                .deviceId(deviceId)
                .deliveryChannel(channel)
                .queueEligible(true)
                .idempotencyKey(idemKey)
                .lastUpdatedAt(now);

        // Persist pending command unconditionally — ensures deferred delivery on reconnect
        PendingCommand cmd = new PendingCommand();
        cmd.setDeviceId(deviceId);
        cmd.setCommandType("CONFIG_PUSH");
        cmd.setTemplateId(job.getTemplateId());
        cmd.setJobId(job.getId());
        cmd.setStatus("PENDING");
        cmd.setActor(job.getConfirmedBy());
        cmd.setCreatedAt(now);
        cmd.setExpiresAt(now.plus(ttlHours, ChronoUnit.HOURS));
        cmd.setDeliveryChannel(channel);
        cmd.setIdempotencyKey(idemKey);
        cmd = pendingRepo.save(cmd);

        rb.pendingCommandId(cmd.getId());

        // Attempt realtime nudge if UBR_REALTIME and device is online
        boolean nudgeSent = false;
        if ("UBR_REALTIME".equals(channel)) {
            boolean online = deviceStatusChecker.isOnline(deviceId);
            if (online) {
                nudgeSent = publishForceCheckin(deviceId, job.getId(), idemKey);
            }
        }

        rb.currentState("QUEUED");
        rb.retryable(true);

        List<PerDeviceDeliveryRecord.ProtocolAttempt> attempts = new ArrayList<>();
        if ("UBR_REALTIME".equals(channel)) {
            attempts.add(PerDeviceDeliveryRecord.ProtocolAttempt.builder()
                    .protocol("UBR_REALTIME")
                    .status(nudgeSent ? "SUCCESS" : "QUEUED")
                    .startedAt(now)
                    .completedAt(Instant.now())
                    .failureReason(nudgeSent ? null : "Realtime nudge not sent; command queued for check-in")
                    .build());
        }
        rb.protocolAttempts(attempts);

        log.info("UBR queued: deviceId={} channel={} pendingCmdId={} nudgeSent={}",
                deviceId, channel, cmd.getId(), nudgeSent);
        return rb.build();
    }

    /**
     * Generic protocol routing (SNMP/CLI/NETCONF).
     * Publishes a routed Kafka message with the protocol preference order.
     * Does NOT queue offline devices — generic devices without queue eligibility fail fast.
     */
    private PerDeviceDeliveryRecord routeGenericTarget(
            ConfigJob job,
            ConfigTargetPreviewResponse.TargetEntry target,
            String idemKey) {

        String deviceId = target.getDeviceId();
        String channel  = target.getDeliveryChannel();
        Instant now     = Instant.now();

        // Protocol preference order based on channel classification
        List<String> protocolOrder = channel.equals("SNMP_PROTOCOL")
                ? List.of("SNMP", "CLI")
                : List.of("CLI", "NETCONF");

        boolean published = publishRoutedConfigPush(deviceId, job, target, idemKey, protocolOrder);

        PerDeviceDeliveryRecord.ProtocolAttempt attempt = PerDeviceDeliveryRecord.ProtocolAttempt.builder()
                .protocol(protocolOrder.get(0))
                .status(published ? "SUCCESS" : "FAILURE")
                .startedAt(now)
                .completedAt(Instant.now())
                .failureReason(published ? null : "Kafka publish failed; check broker connectivity")
                .build();

        String state = published ? "PUBLISHED" : "FAILED";
        log.info("Generic routed: deviceId={} channel={} state={} idemKey={}", deviceId, channel, state, idemKey);

        return PerDeviceDeliveryRecord.builder()
                .deviceId(deviceId)
                .deliveryChannel(channel)
                .currentState(state)
                .queueEligible(false) // generic devices without UBR call-home do not queue
                .idempotencyKey(idemKey)
                .retryable(!published)
                .lastUpdatedAt(Instant.now())
                .protocolAttempts(List.of(attempt))
                .failureReason(published ? null : "Kafka publish failed")
                .build();
    }

    private PerDeviceDeliveryRecord unsupportedRecord(String deviceId, String channel, String reason) {
        log.warn("Unsupported delivery: deviceId={} channel={} reason={}", deviceId, channel, reason);
        return PerDeviceDeliveryRecord.builder()
                .deviceId(deviceId)
                .deliveryChannel(channel)
                .currentState("UNSUPPORTED")
                .queueEligible(false)
                .retryable(false)
                .failureReason(reason)
                .lastUpdatedAt(Instant.now())
                .protocolAttempts(List.of())
                .build();
    }

    // ── Kafka helpers ──────────────────────────────────────────────────────────

    private boolean publishRoutedConfigPush(
            String deviceId,
            ConfigJob job,
            ConfigTargetPreviewResponse.TargetEntry target,
            String idemKey,
            List<String> protocolOrder) {
        try {
            Map<String, Object> msg = new LinkedHashMap<>();
            msg.put("deviceId", deviceId);
            msg.put("jobId", job.getId());
            msg.put("templateId", job.getTemplateId());
            msg.put("deliveryChannel", target.getDeliveryChannel());
            msg.put("protocolOrder", protocolOrder);
            msg.put("credentialRef", "vault://config/" + deviceId); // credential reference only
            msg.put("idempotencyKey", idemKey);
            msg.put("jobCorrelationId", job.getId());
            msg.put("actor", job.getConfirmedBy());
            msg.put("timestamp", Instant.now().toString());
            kafkaTemplate.send(configPushTopic, deviceId, objectMapper.writeValueAsString(msg));
            return true;
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize config push message for deviceId={}: {}", deviceId, e.getMessage());
            return false;
        } catch (Exception e) {
            log.error("Failed to publish config push for deviceId={}: {}", deviceId, e.getMessage());
            return false;
        }
    }

    private boolean publishForceCheckin(String deviceId, String jobId, String idemKey) {
        try {
            Map<String, Object> msg = new LinkedHashMap<>();
            msg.put("deviceId", deviceId);
            msg.put("jobId", jobId);
            msg.put("reason", "CONFIG_DELIVERY");
            msg.put("idempotencyKey", idemKey);
            msg.put("timestamp", Instant.now().toString());
            kafkaTemplate.send(forceCheckinTopic, deviceId, objectMapper.writeValueAsString(msg));
            return true;
        } catch (Exception e) {
            // Nudge failure is non-fatal — pending command still queued
            log.warn("Realtime force-check-in nudge failed for deviceId={}: {}", deviceId, e.getMessage());
            return false;
        }
    }
}

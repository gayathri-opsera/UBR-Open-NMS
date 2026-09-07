package com.ubrnms.config.controller;

import com.ubrnms.config.model.ConfigJob;
import com.ubrnms.config.model.ConfigVersion;
import com.ubrnms.config.model.PendingCommand;
import com.ubrnms.config.model.PerDeviceDeliveryRecord;
import com.ubrnms.config.service.ConfigService;
import com.ubrnms.config.service.DeviceEligibilityChecker;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/devices")
@RequiredArgsConstructor
public class DeviceConfigController {

    private final ConfigService configService;
    private final DeviceEligibilityChecker deviceEligibilityChecker;

    @GetMapping("/{id}/pending-commands")
    public ResponseEntity<Map<String, Object>> getPendingCommands(@PathVariable String id) {
        List<PendingCommand> commands = configService.getPendingCommands(id);
        return ResponseEntity.ok(Map.of(
                "count", commands.size(),
                "commands", commands
        ));
    }

    @GetMapping("/{id}/config-history")
    public ResponseEntity<List<ConfigVersion>> getConfigHistory(@PathVariable String id) {
        return ResponseEntity.ok(configService.getVersionHistory(id));
    }

    /**
     * Returns full job status with per-device delivery records (WO-049).
     *
     * <p>Response shape per api_contracts:
     * { jobId, status, targetCount, completedCount, failedCount, queuedCount, perDeviceStatus[] }
     * Each per-device entry: { deviceId, deliveryChannel, currentState, queueEligible,
     *   protocolAttempts[], pendingCommandId, failureReason, lastUpdatedAt, retryable }
     */
    @GetMapping("/config/jobs/{jobId}")
    @RequestMapping(value = "/api/v1/config/jobs/{jobId}", method = RequestMethod.GET)
    public ResponseEntity<Map<String, Object>> getJobStatus(@PathVariable String jobId) {
        ConfigJob job;
        try {
            job = configService.getJobStatus(jobId);
        } catch (NoSuchElementException e) {
            return ResponseEntity.notFound().build();
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", job.getId());
        body.put("status", job.getStatus());
        body.put("targetCount", job.getTotalDevices());
        body.put("completedCount", job.getSuccessCount());
        body.put("failedCount", job.getFailureCount());
        body.put("queuedCount", job.getQueuedCount());
        body.put("progressPercent", job.getProgressPercent());
        body.put("previewId", job.getPreviewId());
        body.put("confirmedBy", job.getConfirmedBy());
        body.put("confirmedAt", job.getConfirmedAt() != null ? job.getConfirmedAt().toString() : null);

        // Prefer rich delivery records; fall back to legacy perDeviceStatus map
        if (job.getPerDeviceDelivery() != null && !job.getPerDeviceDelivery().isEmpty()) {
            List<Map<String, Object>> perDevice = job.getPerDeviceDelivery().stream()
                    .map(DeviceConfigController::serializeDeliveryRecord)
                    .collect(Collectors.toList());
            body.put("perDeviceStatus", perDevice);
        } else {
            // Legacy format: convert flat status map to minimal delivery record shape
            List<Map<String, Object>> perDevice = job.getPerDeviceStatus().entrySet().stream()
                    .map(e -> Map.of("deviceId", e.getKey(), "currentState", e.getValue()))
                    .collect(Collectors.toList());
            body.put("perDeviceStatus", perDevice);
        }

        return ResponseEntity.ok(body);
    }

    private static Map<String, Object> serializeDeliveryRecord(PerDeviceDeliveryRecord r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("deviceId", r.getDeviceId());
        m.put("deliveryChannel", r.getDeliveryChannel());
        m.put("currentState", r.getCurrentState());
        m.put("queueEligible", r.isQueueEligible());
        m.put("pendingCommandId", r.getPendingCommandId());
        m.put("failureReason", r.getFailureReason());
        m.put("lastUpdatedAt", r.getLastUpdatedAt() != null ? r.getLastUpdatedAt().toString() : null);
        m.put("retryable", r.isRetryable());
        m.put("idempotencyKey", r.getIdempotencyKey());

        List<Map<String, Object>> attempts = new ArrayList<>();
        if (r.getProtocolAttempts() != null) {
            for (PerDeviceDeliveryRecord.ProtocolAttempt a : r.getProtocolAttempts()) {
                Map<String, Object> am = new LinkedHashMap<>();
                am.put("protocol", a.getProtocol());
                am.put("status", a.getStatus());
                am.put("startedAt", a.getStartedAt() != null ? a.getStartedAt().toString() : null);
                am.put("completedAt", a.getCompletedAt() != null ? a.getCompletedAt().toString() : null);
                am.put("failureReason", a.getFailureReason());
                am.put("errorCode", a.getErrorCode());
                attempts.add(am);
            }
        }
        m.put("protocolAttempts", attempts);
        return m;
    }

    /**
     * Returns the config delivery eligibility state for a device (WO-033).
     * Operators and NOC can use this endpoint to determine whether a device is
     * eligible for config push, or whether delivery is withheld and why.
     */
    @GetMapping("/{id}/onboarding-gate")
    public ResponseEntity<Map<String, Object>> getOnboardingGateState(@PathVariable String id) {
        DeviceEligibilityChecker.IneligibilityReason ineligible =
                deviceEligibilityChecker.checkEligibility(id);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("deviceId", id);
        body.put("eligible", ineligible == null);
        body.put("withheldReason", ineligible != null ? ineligible.name() : null);
        return ResponseEntity.ok(body);
    }
}

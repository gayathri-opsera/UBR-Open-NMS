package com.ubrnms.config.controller;

import com.ubrnms.config.model.ConfigJob;
import com.ubrnms.config.model.ConfigVersion;
import com.ubrnms.config.model.PendingCommand;
import com.ubrnms.config.model.PerDeviceDeliveryRecord;
import com.ubrnms.config.service.ConfigService;
import com.ubrnms.config.service.DeviceEligibilityChecker;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
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

    /**
     * Paginated configuration history endpoint (WO-050).
     *
     * <p>Conforms to api_contracts:
     * GET /api/v1/config/history/{deviceId}?limit=50&cursor=<page>
     * Returns { deviceId, items[], nextCursor, totalKnown }
     *
     * Accepts both ?cursor= (page index) and ?limit= query params.
     * Responds with empty items and no nextCursor for devices with no history.
     */
    @GetMapping("/config/history/{deviceId}")
    public ResponseEntity<Map<String, Object>> getConfigHistoryPaged(
            @PathVariable String deviceId,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int cursor) {

        if (limit < 1 || limit > 200) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "limit must be between 1 and 200",
                    "code", "INVALID_PARAM"
            ));
        }
        if (cursor < 0) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "cursor must be >= 0",
                    "code", "INVALID_PARAM"
            ));
        }

        Page<ConfigVersion> page = configService.getVersionHistoryPaged(deviceId, cursor, limit);

        List<Map<String, Object>> items = page.getContent().stream()
                .map(DeviceConfigController::serializeVersion)
                .collect(Collectors.toList());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("deviceId", deviceId);
        body.put("items", items);
        body.put("nextCursor", page.hasNext() ? cursor + 1 : null);
        body.put("totalKnown", (int) page.getTotalElements());
        body.put("page", cursor);
        body.put("limit", limit);

        return ResponseEntity.ok(body);
    }

    /** Legacy non-paginated config history (backward-compatible, kept for existing callers). */
    @GetMapping("/{id}/config-history")
    public ResponseEntity<List<ConfigVersion>> getConfigHistory(@PathVariable String id) {
        return ResponseEntity.ok(configService.getVersionHistory(id));
    }

    private static Map<String, Object> serializeVersion(ConfigVersion v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("versionId", v.getId());
        m.put("versionNumber", v.getVersionNumber());
        m.put("status", v.getStatus());
        m.put("jobId", v.getJobId());
        m.put("templateId", v.getTemplateId());
        m.put("actor", v.getActor());
        m.put("approvalReference", v.getApprovalReference());
        m.put("deliveryChannel", v.getDeliveryChannel());
        m.put("appliedAt", v.getAppliedAt() != null ? v.getAppliedAt().toString() : null);
        m.put("attemptedAt", v.getAttemptedAt() != null ? v.getAttemptedAt().toString() : null);
        m.put("diffSummary", v.getDiffSummary());
        m.put("sanitizedDiff", v.getSanitizedDiff());
        m.put("rollbackEligible", v.isRollbackEligible());
        m.put("failureReason", v.getFailureReason());
        m.put("renderedHash", v.getRenderedHash());
        return m;
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
                    .map(e -> {
                        Map<String, Object> entry = new java.util.LinkedHashMap<>();
                        entry.put("deviceId", e.getKey());
                        entry.put("currentState", e.getValue());
                        return entry;
                    })
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

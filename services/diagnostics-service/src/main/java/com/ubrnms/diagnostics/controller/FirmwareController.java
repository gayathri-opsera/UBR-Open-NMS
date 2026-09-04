package com.ubrnms.diagnostics.controller;

import com.ubrnms.diagnostics.model.FirmwareJob;
import com.ubrnms.diagnostics.model.FirmwareUpgradeRequest;
import com.ubrnms.diagnostics.model.FirmwareUpgradeResponse;
import com.ubrnms.diagnostics.service.FirmwareService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.validation.Valid;
import java.util.List;
import java.util.Map;

/**
 * Controller for firmware upgrade operations (WO-012).
 * Provides endpoints for submitting firmware upgrades, tracking job status,
 * and handling compatibility checks.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/operations")
@RequiredArgsConstructor
public class FirmwareController {

    private final FirmwareService firmwareService;

    /**
     * Submit a firmware upgrade request (Step 2, 4).
     * POST /api/v1/operations/devices/{deviceId}/firmware-upgrade
     */
    @PostMapping("/devices/{deviceId}/firmware-upgrade")
    public ResponseEntity<?> submitFirmwareUpgrade(
            @PathVariable String deviceId,
            @Valid @RequestBody FirmwareUpgradeRequest request,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Operator") String role) {

        if (!isAuthorized(role)) {
            return forbidden();
        }

        try {
            FirmwareUpgradeResponse response = firmwareService.submitFirmwareUpgrade(deviceId, request, actor, role);
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(response);
        } catch (IllegalStateException e) {
            // Conflicting operation or device offline
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "OPERATION_CONFLICT",
                            "message", e.getMessage()
                    )
            ));
        } catch (IllegalArgumentException e) {
            // Incompatible firmware or validation error
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "INCOMPATIBLE_FIRMWARE",
                            "message", e.getMessage()
                    )
            ));
        } catch (Exception e) {
            log.error("Failed to submit firmware upgrade for device {}", deviceId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "INTERNAL_ERROR",
                            "message", "Failed to process firmware upgrade request"
                    )
            ));
        }
    }

    /**
     * Get firmware job status.
     * GET /api/v1/operations/firmware-jobs/{jobId}
     */
    @GetMapping("/firmware-jobs/{jobId}")
    public ResponseEntity<?> getFirmwareJobStatus(@PathVariable String jobId) {
        return firmwareService.getJob(jobId)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    /**
     * Get firmware job history for a device.
     * GET /api/v1/operations/devices/{deviceId}/firmware-jobs
     */
    @GetMapping("/devices/{deviceId}/firmware-jobs")
    public ResponseEntity<List<FirmwareJob>> getFirmwareJobHistory(@PathVariable String deviceId) {
        return ResponseEntity.ok(firmwareService.getJobHistory(deviceId));
    }

    /**
     * Worker callback endpoint for firmware phase updates (Step 6).
     * POST /api/v1/operations/firmware-jobs/{jobId}/callback
     */
    @PostMapping("/firmware-jobs/{jobId}/callback")
    public ResponseEntity<?> handlePhaseCallback(
            @PathVariable String jobId,
            @RequestBody Map<String, Object> callback) {

        String phase = (String) callback.get("phase");
        Map<String, Object> data = (Map<String, Object>) callback.getOrDefault("data", Map.of());

        FirmwareJob updated = firmwareService.handlePhaseCallback(jobId, phase, data);
        if (updated == null) {
            return ResponseEntity.notFound().build();
        }

        return ResponseEntity.ok(updated);
    }

    // ── helpers ───────────────────────────────────────────────────

    private boolean isAuthorized(String role) {
        return "Operator".equalsIgnoreCase(role) || "Admin".equalsIgnoreCase(role) || "network_engineer".equalsIgnoreCase(role);
    }

    private ResponseEntity<?> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "Insufficient permissions — Operator, Admin, or network_engineer role required"));
    }
}

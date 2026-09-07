package com.ubrnms.config.controller;

import com.ubrnms.config.model.*;
import com.ubrnms.config.service.ConfigService;
import com.ubrnms.config.service.ConfigService.ConfirmationResult;
import com.ubrnms.config.service.InventorySearchClient;
import com.ubrnms.config.service.TargetResolverService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/config")
@RequiredArgsConstructor
public class ConfigController {

    private final ConfigService configService;
    private final TargetResolverService targetResolverService;

    // ── Templates ──────────────────────────────────────────────────

    @PostMapping("/templates")
    public ResponseEntity<ConfigTemplate> createTemplate(@RequestBody ConfigTemplate template) {
        return ResponseEntity.status(HttpStatus.CREATED).body(configService.createTemplate(template));
    }

    @GetMapping("/templates")
    public ResponseEntity<List<ConfigTemplate>> listTemplates() {
        return ResponseEntity.ok(configService.listTemplates());
    }

    @GetMapping("/templates/{id}")
    public ResponseEntity<ConfigTemplate> getTemplate(@PathVariable String id) {
        return ResponseEntity.ok(configService.getTemplate(id));
    }

    @PutMapping("/templates/{id}")
    public ResponseEntity<ConfigTemplate> updateTemplate(
            @PathVariable String id, @RequestBody ConfigTemplate patch) {
        return ResponseEntity.ok(configService.updateTemplate(id, patch));
    }

    @DeleteMapping("/templates/{id}")
    public ResponseEntity<Void> deleteTemplate(@PathVariable String id) {
        configService.deleteTemplate(id);
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/templates/{id}/set-default")
    public ResponseEntity<ConfigTemplate> setDefault(@PathVariable String id) {
        return ResponseEntity.ok(configService.setDefault(id));
    }

    // ── Config push ────────────────────────────────────────────────

    @PostMapping("/push/{deviceId}")
    public ResponseEntity<?> pushConfig(
            @PathVariable String deviceId,
            @RequestParam String templateId,
            @RequestParam(required = false, defaultValue = "") String actor,
            @RequestParam(required = false, defaultValue = "false") boolean firmware) {

        ConfigService.PushResult result = configService.pushConfig(deviceId, templateId, actor, firmware);

        return switch (result.type) {
            case PUBLISHED -> ResponseEntity.ok(Map.of("status", "published"));
            case QUEUED    -> ResponseEntity.accepted().body(Map.of(
                    "status", "queued", "commandId", result.queuedCommandId));
            case DEVICE_OFFLINE -> ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "DEVICE_OFFLINE",
                            "message", "Device offline — command not queued. Individual configuration commands require an active device connection.")));
            case OPERATION_IN_FLIGHT -> ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "OPERATION_IN_FLIGHT",
                            "existingJobId", result.existingOperationJobId,
                            "existingOperationClass", result.existingOperationClass,
                            "message", "A conflicting operation is already in progress for this device.")));
            case DELIVERY_WITHHELD -> ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "DELIVERY_WITHHELD",
                            "reason", result.withheldReason,
                            "message", "Configuration delivery withheld — device is not yet approved for config delivery.")));
        };
    }

    @PostMapping("/bulk-push")
    public ResponseEntity<ConfigJob> bulkPush(
            @RequestParam List<String> deviceIds,
            @RequestParam String templateId,
            @RequestParam(required = false, defaultValue = "") String actor) {
        return ResponseEntity.accepted().body(configService.bulkPush(deviceIds, templateId, actor));
    }

    // ── Target preview (WO-039) ────────────────────────────────────────────────

    /**
     * Non-mutating target resolution endpoint.
     *
     * <p>Accepts structured filters and returns the resolved device set with
     * delivery channel classification, before any configuration is executed.
     * No device state is modified; no commands are enqueued.
     *
     * POST /api/v1/config/targets/preview
     */
    @PostMapping("/targets/preview")
    public ResponseEntity<?> previewTargets(
            @Valid @RequestBody ConfigTargetPreviewRequest request,
            @RequestHeader(name = "X-Actor-Role", required = false, defaultValue = "operator") String actorRole) {
        try {
            targetResolverService.validateRequest(request);
            ConfigTargetPreviewResponse preview = targetResolverService.resolveTargets(request, actorRole);
            return ResponseEntity.ok(preview);
        } catch (TargetResolverService.ValidationException ex) {
            return ResponseEntity.badRequest().body(Map.of(
                "status", "error",
                "error", Map.of(
                    "code", "INVALID_FILTERS",
                    "field", ex.field,
                    "message", ex.getMessage()
                )
            ));
        } catch (InventorySearchClient.InventoryServiceException ex) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                "status", "error",
                "error", Map.of(
                    "code", "INVENTORY_UNAVAILABLE",
                    "message", "Cannot reach inventory service — retry shortly",
                    "retryAfterSeconds", 30
                )
            ));
        } catch (Exception ex) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                "status", "error",
                "error", Map.of(
                    "code", "RESOLVER_FAILURE",
                    "message", "Target resolution failed — contact support if issue persists"
                )
            ));
        }
    }

    // ── Confirm execution (WO-045) ─────────────────────────────────────────────

    /**
     * Explicit confirmation gate for configuration execution.
     *
     * <p>Validates a previously generated target preview and creates an accepted
     * async job only when:
     * <ul>
     *   <li>The actor has network_engineer or admin role</li>
     *   <li>The preview exists and has not expired</li>
     *   <li>The expected target count matches the current preview</li>
     * </ul>
     *
     * POST /api/v1/config/actions/confirm
     */
    @PostMapping("/actions/confirm")
    public ResponseEntity<?> confirmExecution(
            @Valid @RequestBody ConfirmExecutionRequest request,
            @RequestHeader(name = "X-Actor-Role", required = false, defaultValue = "") String actorRole,
            @RequestHeader(name = "X-Actor", required = false, defaultValue = "unknown") String actor) {

        ConfirmationResult result = configService.confirmExecution(request, actorRole, actor);

        return switch (result.outcome) {
            case ACCEPTED -> ResponseEntity.accepted().body(Map.of(
                "jobId",         result.job.getId(),
                "status",        result.job.getStatus(),
                "acceptedAt",    result.job.getConfirmedAt().toString(),
                "acceptedBy",    result.job.getConfirmedBy(),
                "targetCount",   result.job.getTotalDevices(),
                "previewId",     result.job.getPreviewId(),
                "trackingUrl",   "/api/v1/config/jobs/" + result.job.getId() + "/status"
            ));
            case DUPLICATE_IDEMPOTENCY_KEY -> ResponseEntity.ok().body(Map.of(
                "jobId",         result.job.getId(),
                "status",        result.job.getStatus(),
                "acceptedAt",    result.job.getConfirmedAt().toString(),
                "acceptedBy",    result.job.getConfirmedBy(),
                "targetCount",   result.job.getTotalDevices(),
                "previewId",     result.job.getPreviewId(),
                "trackingUrl",   "/api/v1/config/jobs/" + result.job.getId() + "/status",
                "note",          "Idempotent: returning existing accepted job"
            ));
            case PREVIEW_NOT_FOUND -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                "status", "error",
                "error",  Map.of(
                    "code",    "PREVIEW_NOT_FOUND",
                    "message", result.conflictDetail
                )
            ));
            case PREVIEW_EXPIRED -> ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                "status", "error",
                "error",  Map.of(
                    "code",    "PREVIEW_EXPIRED",
                    "message", result.conflictDetail
                )
            ));
            case TARGET_COUNT_MISMATCH -> ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                "status", "error",
                "error",  Map.of(
                    "code",    "TARGET_COUNT_MISMATCH",
                    "message", result.conflictDetail
                )
            ));
            case UNAUTHORIZED -> ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                "status", "error",
                "error",  Map.of(
                    "code",    "FORBIDDEN",
                    "message", result.conflictDetail
                )
            ));
        };
    }

    @GetMapping("/jobs/{jobId}/status")
    public ResponseEntity<Map<String, Object>> getJobStatus(@PathVariable String jobId) {
        ConfigJob job = configService.getJobStatus(jobId);
        return ResponseEntity.ok(Map.of(
                "jobId", job.getId(),
                "status", job.getStatus(),
                "progressPercent", job.getProgressPercent(),
                "successCount", job.getSuccessCount(),
                "failureCount", job.getFailureCount(),
                "pendingCount", job.getPendingCount(),
                "totalDevices", job.getTotalDevices(),
                "perDeviceStatus", job.getPerDeviceStatus()
        ));
    }
}

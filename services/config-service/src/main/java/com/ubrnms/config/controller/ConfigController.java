package com.ubrnms.config.controller;

import com.ubrnms.config.model.*;
import com.ubrnms.config.service.ConfigService;
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
        };
    }

    @PostMapping("/bulk-push")
    public ResponseEntity<ConfigJob> bulkPush(
            @RequestParam List<String> deviceIds,
            @RequestParam String templateId,
            @RequestParam(required = false, defaultValue = "") String actor) {
        return ResponseEntity.accepted().body(configService.bulkPush(deviceIds, templateId, actor));
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

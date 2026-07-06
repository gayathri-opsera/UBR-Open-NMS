package com.ubrnms.diagnostics.controller;

import com.ubrnms.diagnostics.model.DiagnosticResult;
import com.ubrnms.diagnostics.service.DiagnosticsService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/diagnostics")
@RequiredArgsConstructor
public class DiagnosticsController {

    private final DiagnosticsService diagnosticsService;

    @PostMapping("/{deviceId}/logs")
    public ResponseEntity<?> getLogs(
            @PathVariable String deviceId,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Operator") String role) {
        if (!isAuthorized(role)) return forbidden();
        DiagnosticResult result = diagnosticsService.executeLogs(deviceId, actor, role);
        return respond(result);
    }

    @PostMapping("/{deviceId}/speed-test")
    public ResponseEntity<?> speedTest(
            @PathVariable String deviceId,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Operator") String role) {
        if (!isAuthorized(role)) return forbidden();
        DiagnosticResult result = diagnosticsService.executeSpeedTest(deviceId, actor, role);
        return respond(result);
    }

    @PostMapping("/{deviceId}/spectrum-analysis")
    public ResponseEntity<?> spectrumAnalysis(
            @PathVariable String deviceId,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Operator") String role) {
        if (!isAuthorized(role)) return forbidden();
        DiagnosticResult result = diagnosticsService.executeSpectrumAnalysis(deviceId, actor, role);
        return respond(result);
    }

    @PostMapping("/{deviceId}/reboot")
    public ResponseEntity<?> reboot(
            @PathVariable String deviceId,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Admin") String role) {
        if (!isAuthorized(role)) return forbidden();
        DiagnosticResult result = diagnosticsService.executeReboot(deviceId, actor, role);
        return respond(result);
    }

    @GetMapping("/{deviceId}/stats")
    public ResponseEntity<?> getStats(
            @PathVariable String deviceId,
            @RequestHeader(value = "X-Actor", defaultValue = "system") String actor,
            @RequestHeader(value = "X-Role", defaultValue = "Operator") String role) {
        if (!isAuthorized(role)) return forbidden();
        DiagnosticResult result = diagnosticsService.getStats(deviceId, actor, role);
        return respond(result);
    }

    @GetMapping("/{deviceId}/history")
    public ResponseEntity<List<DiagnosticResult>> getHistory(@PathVariable String deviceId) {
        return ResponseEntity.ok(diagnosticsService.getHistory(deviceId));
    }

    @GetMapping("/results/{id}")
    public ResponseEntity<DiagnosticResult> getResult(@PathVariable String id) {
        return diagnosticsService.getResult(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // ── helpers ───────────────────────────────────────────────────

    private boolean isAuthorized(String role) {
        return "Operator".equalsIgnoreCase(role) || "Admin".equalsIgnoreCase(role);
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<?> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "Insufficient permissions — Operator or Admin role required"));
    }

    private ResponseEntity<?> respond(DiagnosticResult result) {
        if ("DEVICE_OFFLINE".equals(result.getStatus())) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "status", "error",
                    "error", Map.of(
                            "code", "DEVICE_OFFLINE",
                            "message", result.getErrorMessage())));
        }
        return ResponseEntity.accepted().body(result);
    }
}

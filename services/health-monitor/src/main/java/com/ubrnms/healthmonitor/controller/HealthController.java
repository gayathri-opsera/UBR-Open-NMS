package com.ubrnms.healthmonitor.controller;

import com.ubrnms.healthmonitor.model.HealthThreshold;
import com.ubrnms.healthmonitor.model.SystemHealthStatus;
import com.ubrnms.healthmonitor.service.HealthMonitorService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/system/health")
@RequiredArgsConstructor
public class HealthController {

    private final HealthMonitorService healthMonitorService;

    /** GET /api/v1/system/health — aggregated health status */
    @GetMapping
    public ResponseEntity<SystemHealthStatus> getHealth() {
        SystemHealthStatus status = healthMonitorService.getLatestSnapshot();
        if (status == null) {
            return ResponseEntity.accepted().build(); // first check not yet run
        }
        return ResponseEntity.ok(status);
    }

    /** GET /api/v1/system/health/thresholds */
    @GetMapping("/thresholds")
    public ResponseEntity<HealthThreshold> getThresholds() {
        return ResponseEntity.ok(healthMonitorService.getThresholds());
    }

    /** PUT /api/v1/system/health/thresholds */
    @PutMapping("/thresholds")
    public ResponseEntity<HealthThreshold> updateThresholds(@RequestBody HealthThreshold updated) {
        healthMonitorService.updateThresholds(updated);
        return ResponseEntity.ok(updated);
    }
}

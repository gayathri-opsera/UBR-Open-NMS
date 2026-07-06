package com.ubrnms.healthmonitor.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Aggregated system health snapshot returned by the REST API.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SystemHealthStatus {

    public enum OverallStatus { HEALTHY, DEGRADED, CRITICAL }

    private OverallStatus overall;
    private Instant checkedAt;
    private List<ServiceStatus> services;
    private Map<String, Boolean> infrastructure; // component → reachable

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ServiceStatus {
        private String name;
        private boolean up;
        private double cpuPercent;
        private double memoryFreePercent;
        private double storagePercent;
        private String status; // "UP" | "DOWN" | "DEGRADED"
    }
}

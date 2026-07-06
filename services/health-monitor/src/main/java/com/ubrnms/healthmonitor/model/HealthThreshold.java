package com.ubrnms.healthmonitor.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Configurable thresholds for self-health evaluation.
 * Persisted in MongoDB so operators can adjust via REST without restart.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class HealthThreshold {
    private double cpuPercent;
    private double memoryFreePercent;
    private double storagePercent;
    private int loginFailWindowMinutes;
    private int loginFailMax;
    private double temperatureCelsius; // 0 = disabled
}

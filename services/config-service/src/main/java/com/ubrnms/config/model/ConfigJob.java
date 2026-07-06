package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** Bulk config push job tracking. */
@Data
@NoArgsConstructor
@Document(collection = "config_jobs")
public class ConfigJob {
    @Id
    private String id;
    private String jobType;         // BULK_CONFIG, BULK_FIRMWARE
    private String templateId;
    private int totalDevices;
    private int successCount;
    private int failureCount;
    private int pendingCount;
    private String status;          // RUNNING, COMPLETED, PARTIAL, FAILED
    private Map<String, String> perDeviceStatus = new HashMap<>(); // deviceId → status
    private Instant startedAt;
    private Instant completedAt;
    private String actor;

    public int getProgressPercent() {
        if (totalDevices == 0) return 100;
        return (int) (((double)(successCount + failureCount) / totalDevices) * 100);
    }
}

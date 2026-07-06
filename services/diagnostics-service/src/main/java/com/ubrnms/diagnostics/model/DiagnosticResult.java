package com.ubrnms.diagnostics.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/** Persisted record of a diagnostic command execution. */
@Data
@NoArgsConstructor
@Document(collection = "diagnostic_results")
public class DiagnosticResult {
    @Id
    private String id;
    private String deviceId;
    private String commandType;    // LOGS, SPEED_TEST, SPECTRUM, REBOOT, STATS
    private String status;         // PENDING, SUCCESS, FAILURE, TIMEOUT, DEVICE_OFFLINE
    private String actor;
    private String role;
    private Map<String, Object> result;
    private String errorMessage;
    private Instant requestedAt;
    private Instant completedAt;
    private long durationMs;
}

package com.ubrnms.healthmonitor.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * A self-health alarm event published to the 'raw-alarms' Kafka topic.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SelfHealthAlarm {

    public enum Category {
        CPU_HIGH,
        MEMORY_LOW,
        SERVICE_DOWN,
        INTERFACE_DOWN,
        STORAGE_HIGH,
        LOGIN_ATTEMPTS,
        TEMPERATURE_HIGH,
        FAILOVER
    }

    private String alarmId;
    private String alarmName;
    private String severity; // CRITICAL | MAJOR | MINOR | WARNING
    private String description;
    private String state;   // ACTIVE | CLEAR
    private Instant timestamp;
    private String source;  // always "NMS-SELF-HEALTH"
    private String serviceName;
    private Category category;
    private double measuredValue;
    private double threshold;
}

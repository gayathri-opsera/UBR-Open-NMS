package com.ubrnms.alarm.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/** Configurable threshold rule for a device/parameter combination. */
@Data
@NoArgsConstructor
@Document(collection = "alarm_thresholds")
public class AlarmThreshold {
    @Id
    private String id;
    private String deviceId;         // null = applies to all devices of the type
    private String deviceType;
    private String parameter;        // RSSI, SNR, THROUGHPUT, CPU, TEMPERATURE, etc.
    private double raiseThreshold;
    private double clearThreshold;
    private String severity;
    private String alarmType;
    private boolean enabled = true;
}

package com.ubrnms.alarm.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** Canonical alarm record stored in MongoDB. */
@Data
@NoArgsConstructor
@Document(collection = "alarms")
@CompoundIndex(name = "dedup_idx", def = "{'deviceId': 1, 'alarmType': 1, 'state': 1}")
public class Alarm {
    @Id
    private String id;

    private String alarmId;      // shared across raise/clear lifecycle
    private String deviceId;
    private String deviceType;   // BTS, CPE, IDU, NMS
    private String alarmType;
    private String alarmName;
    private String severity;     // CRITICAL, MAJOR, MINOR, WARNING, INFO
    private String state;        // ACTIVE, ACKNOWLEDGED, CLEARED
    private String description;
    private double metricValue;  // for threshold alarms
    private double threshold;    // threshold that was breached

    // Correlation
    private String rootCauseAlarmId;
    private boolean isRootCause;
    private int correlatedChildCount;

    // Deduplication
    private int dedupCount;
    private Instant dedupWindowStart;

    // Acknowledgement
    private String acknowledgedBy;
    private Instant acknowledgedAt;

    // Source info
    private String networkId;
    private String organizationId;
    private double latitude;
    private double longitude;
    private String source;       // SNMP, SYSLOG, THRESHOLD, SELF_HEALTH

    private Instant raisedAt;
    private Instant clearedAt;

    @Indexed(expireAfterSeconds = 604800) // 7-day TTL
    private Instant ttlExpiry;

    @LastModifiedDate
    private Instant updatedAt;

    private Map<String, Object> rawData = new HashMap<>();
}

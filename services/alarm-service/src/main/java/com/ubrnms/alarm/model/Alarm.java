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

    // ── WO-051: Unified classification and evidence metadata ─────────────────────

    /**
     * Alarm category for consistent NOC triage.
     * Values: FAULT, THRESHOLD, SECURITY, DISCOVERY, CONFIG, LIFECYCLE.
     */
    private String category;

    /**
     * Source system that generated the raw event.
     * Examples: SNMP_POLLER, SYSLOG_COLLECTOR, THRESHOLD_ENGINE,
     * SELF_HEALTH_MONITOR, DISCOVERY_SERVICE.
     */
    private String sourceSystem;

    /**
     * Payload schema version. Set to "2.0" on all WO-051+ records.
     * Absent (null) on legacy records that pre-date this classification model.
     */
    private String schemaVersion;

    /**
     * Caller-supplied event identifier for idempotency tracking.
     * Falls back to alarmId when absent from the raw event.
     */
    private String eventId;

    /**
     * Stable composite idempotency key: {@code deviceId:alarmType:sourceSystem}.
     * Supports cross-session deduplication without relying on database state.
     */
    private String idempotencyKey;

    /**
     * End-to-end correlation identifier propagated from raw events and Kafka payloads.
     * Used to trace a single alarm event across services in structured logs.
     */
    private String correlationId;

    /**
     * Human-readable explanation of the assigned category.
     * Set to "FALLBACK_DEFAULT" when source data was absent or unrecognised.
     * Never contains credentials, signatures, or authentication material.
     */
    private String classificationReason;

    /**
     * Non-sensitive diagnostic context for evidence capture.
     * Must never contain certificates, HMAC signatures, nonces, or raw secrets.
     */
    private Map<String, Object> evidenceContext;
}

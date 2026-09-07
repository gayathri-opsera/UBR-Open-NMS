package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.Map;

/**
 * Shared alarm record model extended with classification and evidence metadata (WO-051).
 * All new fields are additive and nullable to preserve backward compatibility with
 * existing frontends, exporters, and northbound forwarders.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AlarmRecord {

    public enum Severity { CRITICAL, MAJOR, MINOR, WARNING, INDETERMINATE, CLEARED }
    public enum State    { RAISED, ACKNOWLEDGED, CLEARED }

    @JsonProperty("alarmId")          private String alarmId;
    @JsonProperty("deviceId")         private String deviceId;
    @JsonProperty("deviceType")       private String deviceType;
    @JsonProperty("alarmName")        private String alarmName;
    @JsonProperty("alarmDescription") private String alarmDescription;
    @JsonProperty("severity")         private Severity severity;
    @JsonProperty("state")            private State state;
    @JsonProperty("correlationGroup") private String correlationGroup;
    @JsonProperty("rootCause")        private String rootCause;
    @JsonProperty("acknowledged")     private boolean acknowledged;
    @JsonProperty("acknowledgedBy")   private String acknowledgedBy;
    @JsonProperty("raisedAt")         private Instant raisedAt;
    @JsonProperty("clearedAt")        private Instant clearedAt;
    @JsonProperty("ttlExpiry")        private Instant ttlExpiry;

    /**
     * Retention class for evidence lifecycle management (WO-008).
     * Maps this alarm record to its applicable retention policy.
     * Valid values: audit, security, onboarding, alarm_incident, config_history, evidence_export, legacy.
     */
    @JsonProperty("retentionClass")   private String retentionClass;

    // ── WO-051: Unified classification and evidence metadata ─────────────────

    /** Alarm category: FAULT, THRESHOLD, SECURITY, DISCOVERY, CONFIG, LIFECYCLE. */
    @JsonProperty("category")              private String category;

    /** Source system identifier (e.g. SNMP_POLLER, THRESHOLD_ENGINE, DISCOVERY_SERVICE). */
    @JsonProperty("sourceSystem")          private String sourceSystem;

    /** Payload schema version. "2.0" for WO-051+ records; absent for legacy records. */
    @JsonProperty("schemaVersion")         private String schemaVersion;

    /** Caller-supplied event identifier for idempotency; falls back to alarmId. */
    @JsonProperty("eventId")              private String eventId;

    /** Stable composite idempotency key: deviceId:alarmType:sourceSystem. */
    @JsonProperty("idempotencyKey")        private String idempotencyKey;

    /** End-to-end correlation identifier for structured log tracing. */
    @JsonProperty("correlationId")         private String correlationId;

    /** Human-readable rationale for the assigned category. */
    @JsonProperty("classificationReason")  private String classificationReason;

    /**
     * Non-sensitive diagnostic context for evidence capture.
     * Must never contain certificates, HMAC signatures, nonces, or secrets.
     */
    @JsonProperty("evidenceContext")       private Map<String, Object> evidenceContext;

    public AlarmRecord() {}

    public String getAlarmId() { return alarmId; }
    public void setAlarmId(String alarmId) { this.alarmId = alarmId; }
    public String getDeviceId() { return deviceId; }
    public void setDeviceId(String deviceId) { this.deviceId = deviceId; }
    public String getDeviceType() { return deviceType; }
    public void setDeviceType(String deviceType) { this.deviceType = deviceType; }
    public String getAlarmName() { return alarmName; }
    public void setAlarmName(String alarmName) { this.alarmName = alarmName; }
    public String getAlarmDescription() { return alarmDescription; }
    public void setAlarmDescription(String alarmDescription) { this.alarmDescription = alarmDescription; }
    public Severity getSeverity() { return severity; }
    public void setSeverity(Severity severity) { this.severity = severity; }
    public State getState() { return state; }
    public void setState(State state) { this.state = state; }
    public String getCorrelationGroup() { return correlationGroup; }
    public void setCorrelationGroup(String correlationGroup) { this.correlationGroup = correlationGroup; }
    public String getRootCause() { return rootCause; }
    public void setRootCause(String rootCause) { this.rootCause = rootCause; }
    public boolean isAcknowledged() { return acknowledged; }
    public void setAcknowledged(boolean acknowledged) { this.acknowledged = acknowledged; }
    public String getAcknowledgedBy() { return acknowledgedBy; }
    public void setAcknowledgedBy(String acknowledgedBy) { this.acknowledgedBy = acknowledgedBy; }
    public Instant getRaisedAt() { return raisedAt; }
    public void setRaisedAt(Instant raisedAt) { this.raisedAt = raisedAt; }
    public Instant getClearedAt() { return clearedAt; }
    public void setClearedAt(Instant clearedAt) { this.clearedAt = clearedAt; }
    public Instant getTtlExpiry() { return ttlExpiry; }
    public void setTtlExpiry(Instant ttlExpiry) { this.ttlExpiry = ttlExpiry; }
    public String getRetentionClass() { return retentionClass; }
    public void setRetentionClass(String retentionClass) { this.retentionClass = retentionClass; }

    // WO-051 getters/setters
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getSourceSystem() { return sourceSystem; }
    public void setSourceSystem(String sourceSystem) { this.sourceSystem = sourceSystem; }
    public String getSchemaVersion() { return schemaVersion; }
    public void setSchemaVersion(String schemaVersion) { this.schemaVersion = schemaVersion; }
    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getCorrelationId() { return correlationId; }
    public void setCorrelationId(String correlationId) { this.correlationId = correlationId; }
    public String getClassificationReason() { return classificationReason; }
    public void setClassificationReason(String classificationReason) { this.classificationReason = classificationReason; }
    public Map<String, Object> getEvidenceContext() { return evidenceContext; }
    public void setEvidenceContext(Map<String, Object> evidenceContext) { this.evidenceContext = evidenceContext; }
}

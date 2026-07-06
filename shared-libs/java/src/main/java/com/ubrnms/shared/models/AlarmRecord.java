package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;

import java.time.Instant;

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
}

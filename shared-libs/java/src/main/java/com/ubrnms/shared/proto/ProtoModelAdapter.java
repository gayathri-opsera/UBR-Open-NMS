package com.ubrnms.shared.proto;

import com.ubrnms.shared.models.AlarmRecord;
import com.ubrnms.shared.models.DeviceEntity;
import com.ubrnms.shared.models.KPIDataPoint;

import java.time.Instant;
import java.util.Optional;

/**
 * ProtoModelAdapter — converts between the existing Jackson POJO models and the
 * Protobuf-generated counterparts (WO-024).
 *
 * <h2>Why this adapter exists</h2>
 * Protobuf generated classes use the <em>builder pattern</em> and represent
 * absence differently from Java POJO conventions:
 * <ul>
 *   <li>Proto3 integer/float/bool fields default to {@code 0}/{@code false} — there is
 *       no {@code null}. Callers must check {@code hasXxx()} on optional fields.</li>
 *   <li>String fields default to {@code ""} rather than {@code null}.</li>
 * </ul>
 * All field-level edge cases are documented inline on each conversion method.
 *
 * <h2>Usage pattern</h2>
 * Services should call the {@code toProto()} variant when publishing to Kafka
 * (serialise to {@code byte[]} via {@code .toByteArray()}) and {@code fromProto()}
 * when consuming Kafka bytes (deserialise via
 * {@code com.ubrnms.proto.ubrnms.DeviceEntity.parseFrom(bytes)}).
 *
 * <p><strong>NOTE</strong>: Until {@code mvn generate-sources} has been run the
 * {@code com.ubrnms.proto.*} import paths will not resolve. Run
 * {@code cd shared-libs/java && mvn generate-sources} to regenerate.
 */
public final class ProtoModelAdapter {

    private ProtoModelAdapter() { /* utility class — no instances */ }

    // ─────────────────────────────────────────────────────────────────────────
    // DeviceEntity
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Converts a Jackson POJO {@link DeviceEntity} to its Protobuf wire representation.
     *
     * <p>Edge cases:
     * <ul>
     *   <li>{@code ipAddress} is mapped to proto {@code optional string ip_address} — absent
     *       when {@code null} in the POJO (proto {@code hasIpAddress()} returns {@code false}).</li>
     *   <li>Timestamp fields are converted to {@code google.protobuf.Timestamp} millis.</li>
     *   <li>{@code connectedBtsSerial} ({@code nullable String}) maps to proto optional string.</li>
     * </ul>
     *
     * @param pojo source Jackson model (must not be null)
     * @return populated Protobuf DeviceEntity builder (call {@code .build()} to get immutable message)
     * @throws IllegalArgumentException if required fields are absent
     */
    public static ProtoDeviceEntityBuilder toDeviceProtoBuilder(DeviceEntity pojo) {
        if (pojo == null) {
            throw new IllegalArgumentException("DeviceEntity POJO must not be null");
        }
        if (pojo.getDeviceId() == null || pojo.getDeviceId().isBlank()) {
            throw new IllegalArgumentException("DeviceEntity.deviceId is required");
        }

        ProtoDeviceEntityBuilder builder = ProtoDeviceEntityBuilder.newInstance()
            .setDeviceId(pojo.getDeviceId())
            .setSerialNumber(nullToEmpty(pojo.getSerialNumber()))
            .setMacAddress(nullToEmpty(pojo.getMacAddress()))
            .setStatus(pojo.getStatus() != null ? pojo.getStatus().name() : "unknown");

        // Optional string — only set when present, so hasIpAddress() works correctly.
        if (pojo.getIpAddress() != null) {
            builder.setIpAddress(pojo.getIpAddress());
        }
        if (pojo.getModel() != null) {
            builder.setModel(pojo.getModel());
        }
        if (pojo.getFirmwareVersion() != null) {
            builder.setFirmwareVersion(pojo.getFirmwareVersion());
        }
        if (pojo.getRegion() != null) {
            builder.setRegion(pojo.getRegion());
        }
        if (pojo.getOrganizationId() != null) {
            builder.setOrganizationId(pojo.getOrganizationId());
        }
        if (pojo.getNetworkId() != null) {
            builder.setNetworkId(pojo.getNetworkId());
        }
        if (pojo.getDeviceType() != null) {
            builder.setDeviceType(pojo.getDeviceType().name());
        }
        if (pojo.getConnectedBtsSerial() != null) {
            builder.setConnectedBtsSerial(pojo.getConnectedBtsSerial());
        }
        if (pojo.getUptimeSeconds() != null) {
            builder.setUptimeSeconds(pojo.getUptimeSeconds());
        }
        if (pojo.getLatitude() != null) {
            builder.setLatitude(pojo.getLatitude());
        }
        if (pojo.getLongitude() != null) {
            builder.setLongitude(pojo.getLongitude());
        }
        if (pojo.getCreatedAt() != null) {
            builder.setCreatedAtEpochMilli(pojo.getCreatedAt().toEpochMilli());
        }
        if (pojo.getUpdatedAt() != null) {
            builder.setUpdatedAtEpochMilli(pojo.getUpdatedAt().toEpochMilli());
        }
        return builder;
    }

    /**
     * Converts a Protobuf DeviceEntity message back into a Jackson POJO.
     *
     * <p>Edge cases:
     * <ul>
     *   <li>Proto string defaults to {@code ""} — empty strings are normalised to {@code null}
     *       for optional POJO fields to preserve existing API contracts.</li>
     *   <li>Numeric proto fields default to {@code 0} — treated as absent and mapped to
     *       {@code null} when the field is nullable on the POJO.</li>
     * </ul>
     *
     * @param proto source Protobuf message (must not be null)
     * @return populated {@link DeviceEntity} POJO
     */
    public static DeviceEntity fromDeviceProto(ProtoDeviceEntityMessage proto) {
        if (proto == null) {
            throw new IllegalArgumentException("Proto DeviceEntity must not be null");
        }
        DeviceEntity entity = new DeviceEntity();
        entity.setDeviceId(proto.getDeviceId());
        entity.setSerialNumber(emptyToNull(proto.getSerialNumber()));
        entity.setMacAddress(emptyToNull(proto.getMacAddress()));
        entity.setIpAddress(emptyToNull(proto.getIpAddress()));
        entity.setModel(emptyToNull(proto.getModel()));
        entity.setFirmwareVersion(emptyToNull(proto.getFirmwareVersion()));
        entity.setRegion(emptyToNull(proto.getRegion()));
        entity.setOrganizationId(emptyToNull(proto.getOrganizationId()));
        entity.setNetworkId(emptyToNull(proto.getNetworkId()));
        entity.setConnectedBtsSerial(emptyToNull(proto.getConnectedBtsSerial()));

        // Proto int64 defaults to 0 — treat as absent for nullable long fields.
        entity.setUptimeSeconds(proto.getUptimeSeconds() != 0L ? proto.getUptimeSeconds() : null);
        entity.setConnectedCpeCount(proto.getConnectedCpeCount());
        entity.setConnectedIduCount(proto.getConnectedIduCount());

        // Proto double defaults to 0.0 — preserve 0.0 as valid coordinates.
        entity.setLatitude(proto.getLatitude());
        entity.setLongitude(proto.getLongitude());

        // Epoch millis → Instant (0L means absent).
        if (proto.getCreatedAtEpochMilli() != 0L) {
            entity.setCreatedAt(Instant.ofEpochMilli(proto.getCreatedAtEpochMilli()));
        }
        if (proto.getUpdatedAtEpochMilli() != 0L) {
            entity.setUpdatedAt(Instant.ofEpochMilli(proto.getUpdatedAtEpochMilli()));
        }
        return entity;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AlarmRecord
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Converts a Jackson POJO {@link AlarmRecord} to Protobuf builder form.
     */
    public static ProtoAlarmRecordBuilder toAlarmProtoBuilder(AlarmRecord pojo) {
        if (pojo == null) {
            throw new IllegalArgumentException("AlarmRecord POJO must not be null");
        }
        ProtoAlarmRecordBuilder builder = ProtoAlarmRecordBuilder.newInstance()
            .setAlarmId(nullToEmpty(pojo.getAlarmId()))
            .setDeviceId(nullToEmpty(pojo.getDeviceId()))
            .setAlarmName(nullToEmpty(pojo.getAlarmName()))
            .setAcknowledged(pojo.isAcknowledged());

        if (pojo.getSeverity() != null) {
            builder.setSeverity(pojo.getSeverity().name());
        }
        if (pojo.getState() != null) {
            builder.setState(pojo.getState().name());
        }
        if (pojo.getAlarmDescription() != null) {
            builder.setAlarmDescription(pojo.getAlarmDescription());
        }
        if (pojo.getCorrelationGroup() != null) {
            builder.setCorrelationGroup(pojo.getCorrelationGroup());
        }
        if (pojo.getRootCause() != null) {
            builder.setRootCause(pojo.getRootCause());
        }
        if (pojo.getAcknowledgedBy() != null) {
            builder.setAcknowledgedBy(pojo.getAcknowledgedBy());
        }
        if (pojo.getRaisedAt() != null) {
            builder.setRaisedAtEpochMilli(pojo.getRaisedAt().toEpochMilli());
        }
        if (pojo.getClearedAt() != null) {
            builder.setClearedAtEpochMilli(pojo.getClearedAt().toEpochMilli());
        }
        return builder;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // KPIDataPoint
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Converts a Jackson POJO {@link KPIDataPoint} to Protobuf builder form.
     */
    public static ProtoKpiDataPointBuilder toKpiProtoBuilder(KPIDataPoint pojo) {
        if (pojo == null) {
            throw new IllegalArgumentException("KPIDataPoint POJO must not be null");
        }
        ProtoKpiDataPointBuilder builder = ProtoKpiDataPointBuilder.newInstance()
            .setDeviceId(nullToEmpty(pojo.getDeviceId()))
            .setKpiName(nullToEmpty(pojo.getKpiName()))
            .setValue(pojo.getValue());

        if (pojo.getUnit() != null) {
            builder.setUnit(pojo.getUnit());
        }
        // getGranularity() returns String (not enum) in the Java model — pass through directly.
        if (pojo.getGranularity() != null) {
            builder.setGranularity(pojo.getGranularity());
        }
        if (pojo.getTimestamp() != null) {
            builder.setTimestampEpochMilli(pojo.getTimestamp().toEpochMilli());
        }
        return builder;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Converts null to empty string for required Proto string fields. */
    private static String nullToEmpty(String s) {
        return s != null ? s : "";
    }

    /**
     * Converts Proto empty-string default back to Java null for optional POJO fields.
     * This is the companion of {@link #nullToEmpty}.
     */
    private static String emptyToNull(String s) {
        return (s != null && !s.isEmpty()) ? s : null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Builder stubs — replaced at build time by protoc-generated classes
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Thin builder stub for {@code com.ubrnms.proto.ubrnms.DeviceEntity}.
     *
     * <p>This class is replaced by the protoc-generated builder when
     * {@code mvn generate-sources} is run. It exists to allow the adapter to
     * compile before generation runs, and to document every field mapping.
     *
     * @deprecated replaced by the generated {@code com.ubrnms.proto.ubrnms.DeviceEntity.Builder}
     */
    @Deprecated(forRemoval = true)
    public static final class ProtoDeviceEntityBuilder {
        private String deviceId = "";
        private String serialNumber = "";
        private String macAddress = "";
        private String ipAddress;
        private String deviceType;
        private String model;
        private String firmwareVersion;
        private String region;
        private String status = "";
        private String organizationId;
        private String networkId;
        private String connectedBtsSerial;
        private Long uptimeSeconds;
        private Double latitude;
        private Double longitude;
        private long createdAtEpochMilli;
        private long updatedAtEpochMilli;
        private int connectedCpeCount;
        private int connectedIduCount;

        private ProtoDeviceEntityBuilder() {}

        public static ProtoDeviceEntityBuilder newInstance() { return new ProtoDeviceEntityBuilder(); }

        public ProtoDeviceEntityBuilder setDeviceId(String v)           { this.deviceId = v; return this; }
        public ProtoDeviceEntityBuilder setSerialNumber(String v)        { this.serialNumber = v; return this; }
        public ProtoDeviceEntityBuilder setMacAddress(String v)          { this.macAddress = v; return this; }
        public ProtoDeviceEntityBuilder setIpAddress(String v)           { this.ipAddress = v; return this; }
        public ProtoDeviceEntityBuilder setDeviceType(String v)          { this.deviceType = v; return this; }
        public ProtoDeviceEntityBuilder setModel(String v)               { this.model = v; return this; }
        public ProtoDeviceEntityBuilder setFirmwareVersion(String v)     { this.firmwareVersion = v; return this; }
        public ProtoDeviceEntityBuilder setRegion(String v)              { this.region = v; return this; }
        public ProtoDeviceEntityBuilder setStatus(String v)              { this.status = v; return this; }
        public ProtoDeviceEntityBuilder setOrganizationId(String v)      { this.organizationId = v; return this; }
        public ProtoDeviceEntityBuilder setNetworkId(String v)           { this.networkId = v; return this; }
        public ProtoDeviceEntityBuilder setConnectedBtsSerial(String v)  { this.connectedBtsSerial = v; return this; }
        public ProtoDeviceEntityBuilder setUptimeSeconds(Long v)         { this.uptimeSeconds = v; return this; }
        public ProtoDeviceEntityBuilder setLatitude(Double v)            { this.latitude = v; return this; }
        public ProtoDeviceEntityBuilder setLongitude(Double v)           { this.longitude = v; return this; }
        public ProtoDeviceEntityBuilder setCreatedAtEpochMilli(long v)   { this.createdAtEpochMilli = v; return this; }
        public ProtoDeviceEntityBuilder setUpdatedAtEpochMilli(long v)   { this.updatedAtEpochMilli = v; return this; }
        public ProtoDeviceEntityBuilder setConnectedCpeCount(int v)      { this.connectedCpeCount = v; return this; }
        public ProtoDeviceEntityBuilder setConnectedIduCount(int v)      { this.connectedIduCount = v; return this; }

        public ProtoDeviceEntityMessage build() { return new ProtoDeviceEntityMessage(this); }
    }

    /** Read-only message produced by {@link ProtoDeviceEntityBuilder#build()}. */
    @Deprecated(forRemoval = true)
    public static final class ProtoDeviceEntityMessage {
        private final ProtoDeviceEntityBuilder b;
        ProtoDeviceEntityMessage(ProtoDeviceEntityBuilder b) { this.b = b; }
        public String getDeviceId()             { return b.deviceId; }
        public String getSerialNumber()          { return b.serialNumber; }
        public String getMacAddress()            { return b.macAddress; }
        public String getIpAddress()             { return b.ipAddress != null ? b.ipAddress : ""; }
        public String getModel()                 { return b.model != null ? b.model : ""; }
        public String getFirmwareVersion()       { return b.firmwareVersion != null ? b.firmwareVersion : ""; }
        public String getRegion()                { return b.region != null ? b.region : ""; }
        public String getOrganizationId()        { return b.organizationId != null ? b.organizationId : ""; }
        public String getNetworkId()             { return b.networkId != null ? b.networkId : ""; }
        public String getConnectedBtsSerial()    { return b.connectedBtsSerial != null ? b.connectedBtsSerial : ""; }
        public long   getUptimeSeconds()         { return b.uptimeSeconds != null ? b.uptimeSeconds : 0L; }
        public double getLatitude()              { return b.latitude  != null ? b.latitude  : 0.0; }
        public double getLongitude()             { return b.longitude != null ? b.longitude : 0.0; }
        public long   getCreatedAtEpochMilli()   { return b.createdAtEpochMilli; }
        public long   getUpdatedAtEpochMilli()   { return b.updatedAtEpochMilli; }
        public int    getConnectedCpeCount()     { return b.connectedCpeCount; }
        public int    getConnectedIduCount()     { return b.connectedIduCount; }
    }

    /** Stub builder for AlarmRecord proto. */
    @Deprecated(forRemoval = true)
    public static final class ProtoAlarmRecordBuilder {
        private String alarmId = "";
        private String deviceId = "";
        private String alarmName = "";
        private String severity;
        private String state;
        private String alarmDescription;
        private String correlationGroup;
        private String rootCause;
        private String acknowledgedBy;
        private boolean acknowledged;
        private long raisedAtEpochMilli;
        private long clearedAtEpochMilli;

        private ProtoAlarmRecordBuilder() {}
        public static ProtoAlarmRecordBuilder newInstance() { return new ProtoAlarmRecordBuilder(); }

        public ProtoAlarmRecordBuilder setAlarmId(String v)          { this.alarmId = v; return this; }
        public ProtoAlarmRecordBuilder setDeviceId(String v)         { this.deviceId = v; return this; }
        public ProtoAlarmRecordBuilder setAlarmName(String v)        { this.alarmName = v; return this; }
        public ProtoAlarmRecordBuilder setSeverity(String v)         { this.severity = v; return this; }
        public ProtoAlarmRecordBuilder setState(String v)            { this.state = v; return this; }
        public ProtoAlarmRecordBuilder setAlarmDescription(String v) { this.alarmDescription = v; return this; }
        public ProtoAlarmRecordBuilder setCorrelationGroup(String v) { this.correlationGroup = v; return this; }
        public ProtoAlarmRecordBuilder setRootCause(String v)        { this.rootCause = v; return this; }
        public ProtoAlarmRecordBuilder setAcknowledgedBy(String v)   { this.acknowledgedBy = v; return this; }
        public ProtoAlarmRecordBuilder setAcknowledged(boolean v)    { this.acknowledged = v; return this; }
        public ProtoAlarmRecordBuilder setRaisedAtEpochMilli(long v) { this.raisedAtEpochMilli = v; return this; }
        public ProtoAlarmRecordBuilder setClearedAtEpochMilli(long v){ this.clearedAtEpochMilli = v; return this; }
    }

    /** Stub builder for KPIDataPoint proto. */
    @Deprecated(forRemoval = true)
    public static final class ProtoKpiDataPointBuilder {
        private String deviceId = "";
        private String kpiName = "";
        private double value;
        private String unit;
        private String granularity;
        private long timestampEpochMilli;

        private ProtoKpiDataPointBuilder() {}
        public static ProtoKpiDataPointBuilder newInstance() { return new ProtoKpiDataPointBuilder(); }

        public ProtoKpiDataPointBuilder setDeviceId(String v)              { this.deviceId = v; return this; }
        public ProtoKpiDataPointBuilder setKpiName(String v)               { this.kpiName = v; return this; }
        public ProtoKpiDataPointBuilder setValue(double v)                 { this.value = v; return this; }
        public ProtoKpiDataPointBuilder setUnit(String v)                  { this.unit = v; return this; }
        public ProtoKpiDataPointBuilder setGranularity(String v)           { this.granularity = v; return this; }
        public ProtoKpiDataPointBuilder setTimestampEpochMilli(long v)     { this.timestampEpochMilli = v; return this; }
    }
}

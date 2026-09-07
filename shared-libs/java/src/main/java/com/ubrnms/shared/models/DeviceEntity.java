package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.List;

/**
 * Shared DeviceEntity model extended with authority, bootstrap, capability,
 * and credential reference fields (WO-002) and sysObjectID (WO-004).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class DeviceEntity {

    public enum DeviceType { BTS, CPE, IDU }
    public enum DeviceStatus { online, offline, provisioning, decommissioned }

    /** How the device was discovered. */
    public enum DiscoveryParadigm { UBR_CALL_HOME, GENERIC_SNMP, GENERIC_CLI, UNKNOWN }

    /** Authoritative system for device identity / online-state fields. */
    public enum IdentityAuthority { UBR, GENERIC, UNKNOWN }

    /** UBR bootstrap handshake state. */
    public enum BootstrapState {
        PENDING, AUTHENTICATED, CHECK_IN_RECEIVED, REALTIME_ESTABLISHED, FAILED, UNKNOWN
    }

    @JsonProperty("deviceId")    private String deviceId;
    @JsonProperty("serialNumber") private String serialNumber;
    @JsonProperty("macAddress")   private String macAddress;
    @JsonProperty("ipAddress")    private String ipAddress;
    @JsonProperty("deviceType")   private DeviceType deviceType;
    @JsonProperty("model")        private String model;
    @JsonProperty("firmwareVersion") private String firmwareVersion;
    @JsonProperty("region")       private String region;
    @JsonProperty("latitude")     private Double latitude;
    @JsonProperty("longitude")    private Double longitude;
    @JsonProperty("status")       private DeviceStatus status;
    @JsonProperty("uptimeSeconds") private Long uptimeSeconds;
    @JsonProperty("connectedBtsSerial") private String connectedBtsSerial;
    @JsonProperty("connectedCpeCount") private Integer connectedCpeCount;
    @JsonProperty("connectedIduCount") private Integer connectedIduCount;
    @JsonProperty("tags")         private List<DeviceTag> tags;
    @JsonProperty("organizationId") private String organizationId;
    @JsonProperty("networkId")    private String networkId;
    @JsonProperty("createdAt")    private Instant createdAt;
    @JsonProperty("updatedAt")    private Instant updatedAt;

    // ── WO-002 authority fields ───────────────────────────────────────────────

    @JsonProperty("schemaVersion")        private String schemaVersion;
    @JsonProperty("discoveryParadigm")    private String discoveryParadigm;
    @JsonProperty("identityAuthority")    private String identityAuthority;
    @JsonProperty("onlineStateAuthority") private String onlineStateAuthority;
    @JsonProperty("bootstrapState")       private String bootstrapState;
    @JsonProperty("lastCheckInAt")        private Instant lastCheckInAt;
    @JsonProperty("lastRealtimeAt")       private Instant lastRealtimeAt;
    @JsonProperty("capabilityProfileId")  private String capabilityProfileId;
    /** Opaque reference only — never the credential value. */
    @JsonProperty("credentialRef")        private String credentialRef;
    @JsonProperty("configVersion")        private String configVersion;

    // ── WO-004 sysObjectID / sysDescr ────────────────────────────────────────

    @JsonProperty("sysObjectID")          private String sysObjectID;
    @JsonProperty("sysDescr")             private String sysDescr;

    // ── WO-026 onboarding state progress ─────────────────────────────────────

    @JsonProperty("lastSuccessfulBootstrapState") private String lastSuccessfulBootstrapState;
    @JsonProperty("onboardingFailureReason")       private String onboardingFailureReason;
    @JsonProperty("retryAfterSeconds")             private Integer retryAfterSeconds;
    @JsonProperty("retryJitterMaxSeconds")         private Integer retryJitterMaxSeconds;
    @JsonProperty("assignmentRequired")            private Boolean assignmentRequired;
    @JsonProperty("commissioningPendingFields")    private String commissioningPendingFields;

    // ── WO-028 realtime connection tracking ──────────────────────────────────

    @JsonProperty("realtimeConnectionId")  private String realtimeConnectionId;
    @JsonProperty("realtimeStatusReason")  private String realtimeStatusReason;

    // ── WO-030 generic discovery classification results ───────────────────────

    /** Vendor name assigned by SNMP fingerprint classification. */
    @JsonProperty("vendor")                    private String vendor;

    /** Generic device type (ROUTER, SWITCH, FIREWALL, SERVER). Not the same as UBR deviceType. */
    @JsonProperty("genericDeviceType")         private String genericDeviceType;

    /** Driver identifier assigned by classification (e.g. drv-cisco-snmp-v1). */
    @JsonProperty("driverId")                  private String driverId;

    /** Outcome of SNMP fingerprint classification (RECOGNISED, DEFERRED_UNSUPPORTED, CLASSIFICATION_ERROR). */
    @JsonProperty("classificationStatus")      private String classificationStatus;

    /** Operator-visible reason when classification is deferred or errored. */
    @JsonProperty("classificationDeferReason") private String classificationDeferReason;

    /** Correlation ID linking back to the fingerprinting run. */
    @JsonProperty("classificationCorrelationId") private String classificationCorrelationId;

    public DeviceEntity() {}

    // ── Getters / setters ─────────────────────────────────────────────────────

    public String getDeviceId() { return deviceId; }
    public void setDeviceId(String deviceId) { this.deviceId = deviceId; }
    public String getSerialNumber() { return serialNumber; }
    public void setSerialNumber(String serialNumber) { this.serialNumber = serialNumber; }
    public String getMacAddress() { return macAddress; }
    public void setMacAddress(String macAddress) { this.macAddress = macAddress; }
    public String getIpAddress() { return ipAddress; }
    public void setIpAddress(String ipAddress) { this.ipAddress = ipAddress; }
    public DeviceType getDeviceType() { return deviceType; }
    public void setDeviceType(DeviceType deviceType) { this.deviceType = deviceType; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getFirmwareVersion() { return firmwareVersion; }
    public void setFirmwareVersion(String firmwareVersion) { this.firmwareVersion = firmwareVersion; }
    public String getRegion() { return region; }
    public void setRegion(String region) { this.region = region; }
    public Double getLatitude() { return latitude; }
    public void setLatitude(Double latitude) { this.latitude = latitude; }
    public Double getLongitude() { return longitude; }
    public void setLongitude(Double longitude) { this.longitude = longitude; }
    public DeviceStatus getStatus() { return status; }
    public void setStatus(DeviceStatus status) { this.status = status; }
    public Long getUptimeSeconds() { return uptimeSeconds; }
    public void setUptimeSeconds(Long uptimeSeconds) { this.uptimeSeconds = uptimeSeconds; }
    public String getConnectedBtsSerial() { return connectedBtsSerial; }
    public void setConnectedBtsSerial(String s) { this.connectedBtsSerial = s; }
    public Integer getConnectedCpeCount() { return connectedCpeCount; }
    public void setConnectedCpeCount(Integer n) { this.connectedCpeCount = n; }
    public Integer getConnectedIduCount() { return connectedIduCount; }
    public void setConnectedIduCount(Integer n) { this.connectedIduCount = n; }
    public List<DeviceTag> getTags() { return tags; }
    public void setTags(List<DeviceTag> tags) { this.tags = tags; }
    public String getOrganizationId() { return organizationId; }
    public void setOrganizationId(String organizationId) { this.organizationId = organizationId; }
    public String getNetworkId() { return networkId; }
    public void setNetworkId(String networkId) { this.networkId = networkId; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }

    public String getSchemaVersion() { return schemaVersion; }
    public void setSchemaVersion(String schemaVersion) { this.schemaVersion = schemaVersion; }
    public String getDiscoveryParadigm() { return discoveryParadigm; }
    public void setDiscoveryParadigm(String discoveryParadigm) { this.discoveryParadigm = discoveryParadigm; }
    public String getIdentityAuthority() { return identityAuthority; }
    public void setIdentityAuthority(String identityAuthority) { this.identityAuthority = identityAuthority; }
    public String getOnlineStateAuthority() { return onlineStateAuthority; }
    public void setOnlineStateAuthority(String onlineStateAuthority) { this.onlineStateAuthority = onlineStateAuthority; }
    public String getBootstrapState() { return bootstrapState; }
    public void setBootstrapState(String bootstrapState) { this.bootstrapState = bootstrapState; }
    public Instant getLastCheckInAt() { return lastCheckInAt; }
    public void setLastCheckInAt(Instant lastCheckInAt) { this.lastCheckInAt = lastCheckInAt; }
    public Instant getLastRealtimeAt() { return lastRealtimeAt; }
    public void setLastRealtimeAt(Instant lastRealtimeAt) { this.lastRealtimeAt = lastRealtimeAt; }
    public String getCapabilityProfileId() { return capabilityProfileId; }
    public void setCapabilityProfileId(String capabilityProfileId) { this.capabilityProfileId = capabilityProfileId; }
    public String getCredentialRef() { return credentialRef; }
    public void setCredentialRef(String credentialRef) { this.credentialRef = credentialRef; }
    public String getConfigVersion() { return configVersion; }
    public void setConfigVersion(String configVersion) { this.configVersion = configVersion; }
    public String getSysObjectID() { return sysObjectID; }
    public void setSysObjectID(String sysObjectID) { this.sysObjectID = sysObjectID; }
    public String getSysDescr() { return sysDescr; }
    public void setSysDescr(String sysDescr) { this.sysDescr = sysDescr; }

    public String getLastSuccessfulBootstrapState() { return lastSuccessfulBootstrapState; }
    public void setLastSuccessfulBootstrapState(String v) { this.lastSuccessfulBootstrapState = v; }
    public String getOnboardingFailureReason() { return onboardingFailureReason; }
    public void setOnboardingFailureReason(String v) { this.onboardingFailureReason = v; }
    public Integer getRetryAfterSeconds() { return retryAfterSeconds; }
    public void setRetryAfterSeconds(Integer v) { this.retryAfterSeconds = v; }
    public Integer getRetryJitterMaxSeconds() { return retryJitterMaxSeconds; }
    public void setRetryJitterMaxSeconds(Integer v) { this.retryJitterMaxSeconds = v; }
    public Boolean getAssignmentRequired() { return assignmentRequired; }
    public void setAssignmentRequired(Boolean v) { this.assignmentRequired = v; }
    public String getCommissioningPendingFields() { return commissioningPendingFields; }
    public void setCommissioningPendingFields(String v) { this.commissioningPendingFields = v; }
    public String getRealtimeConnectionId() { return realtimeConnectionId; }
    public void setRealtimeConnectionId(String v) { this.realtimeConnectionId = v; }
    public String getRealtimeStatusReason() { return realtimeStatusReason; }
    public void setRealtimeStatusReason(String v) { this.realtimeStatusReason = v; }

    public String getVendor() { return vendor; }
    public void setVendor(String vendor) { this.vendor = vendor; }
    public String getGenericDeviceType() { return genericDeviceType; }
    public void setGenericDeviceType(String genericDeviceType) { this.genericDeviceType = genericDeviceType; }
    public String getDriverId() { return driverId; }
    public void setDriverId(String driverId) { this.driverId = driverId; }
    public String getClassificationStatus() { return classificationStatus; }
    public void setClassificationStatus(String classificationStatus) { this.classificationStatus = classificationStatus; }
    public String getClassificationDeferReason() { return classificationDeferReason; }
    public void setClassificationDeferReason(String classificationDeferReason) { this.classificationDeferReason = classificationDeferReason; }
    public String getClassificationCorrelationId() { return classificationCorrelationId; }
    public void setClassificationCorrelationId(String classificationCorrelationId) { this.classificationCorrelationId = classificationCorrelationId; }
}

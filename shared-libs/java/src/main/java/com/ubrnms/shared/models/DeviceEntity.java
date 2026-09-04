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

    // ── WO-004 sysObjectID ───────────────────────────────────────────────────

    @JsonProperty("sysObjectID")          private String sysObjectID;

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
}

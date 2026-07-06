package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class DeviceEntity {

    public enum DeviceType { BTS, CPE, IDU }
    public enum DeviceStatus { online, offline, provisioning, decommissioned }

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

    public DeviceEntity() {}

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
}

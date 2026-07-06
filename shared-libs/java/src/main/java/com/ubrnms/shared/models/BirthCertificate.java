package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class BirthCertificate {

    @JsonProperty("serialNumber")   private String serialNumber;
    @JsonProperty("macAddress")     private String macAddress;
    @JsonProperty("model")          private String model;
    @JsonProperty("deviceType")     private String deviceType;
    @JsonProperty("firmware")       private String firmware;
    @JsonProperty("systemName")     private String systemName;
    @JsonProperty("ipAddress")      private String ipAddress;
    @JsonProperty("publicKey")      private String publicKey;
    @JsonProperty("hmacSignature")  private String hmacSignature;
    @JsonProperty("organizationId") private String organizationId;
    @JsonProperty("networkId")      private String networkId;
    @JsonProperty("registeredAt")   private Instant registeredAt;

    public BirthCertificate() {}

    public String getSerialNumber() { return serialNumber; }
    public void setSerialNumber(String s) { this.serialNumber = s; }
    public String getMacAddress() { return macAddress; }
    public void setMacAddress(String s) { this.macAddress = s; }
    public String getModel() { return model; }
    public void setModel(String s) { this.model = s; }
    public String getDeviceType() { return deviceType; }
    public void setDeviceType(String s) { this.deviceType = s; }
    public String getFirmware() { return firmware; }
    public void setFirmware(String s) { this.firmware = s; }
    public String getSystemName() { return systemName; }
    public void setSystemName(String s) { this.systemName = s; }
    public String getIpAddress() { return ipAddress; }
    public void setIpAddress(String s) { this.ipAddress = s; }
    public String getPublicKey() { return publicKey; }
    public void setPublicKey(String s) { this.publicKey = s; }
    public String getHmacSignature() { return hmacSignature; }
    public void setHmacSignature(String s) { this.hmacSignature = s; }
    public String getOrganizationId() { return organizationId; }
    public void setOrganizationId(String s) { this.organizationId = s; }
    public String getNetworkId() { return networkId; }
    public void setNetworkId(String s) { this.networkId = s; }
    public Instant getRegisteredAt() { return registeredAt; }
    public void setRegisteredAt(Instant t) { this.registeredAt = t; }
}

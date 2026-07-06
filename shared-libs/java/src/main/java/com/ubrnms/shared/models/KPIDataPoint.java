package com.ubrnms.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class KPIDataPoint {

    @JsonProperty("deviceId")     private String deviceId;
    @JsonProperty("serialNumber") private String serialNumber;
    @JsonProperty("deviceType")   private String deviceType;
    @JsonProperty("kpiName")      private String kpiName;
    @JsonProperty("value")        private double value;
    @JsonProperty("unit")         private String unit;
    @JsonProperty("pollInterval") private Integer pollInterval;
    @JsonProperty("timestamp")    private Instant timestamp;
    @JsonProperty("granularity")  private String granularity;

    public KPIDataPoint() {}

    public String getDeviceId() { return deviceId; }
    public void setDeviceId(String deviceId) { this.deviceId = deviceId; }
    public String getSerialNumber() { return serialNumber; }
    public void setSerialNumber(String serialNumber) { this.serialNumber = serialNumber; }
    public String getDeviceType() { return deviceType; }
    public void setDeviceType(String deviceType) { this.deviceType = deviceType; }
    public String getKpiName() { return kpiName; }
    public void setKpiName(String kpiName) { this.kpiName = kpiName; }
    public double getValue() { return value; }
    public void setValue(double value) { this.value = value; }
    public String getUnit() { return unit; }
    public void setUnit(String unit) { this.unit = unit; }
    public Integer getPollInterval() { return pollInterval; }
    public void setPollInterval(Integer pollInterval) { this.pollInterval = pollInterval; }
    public Instant getTimestamp() { return timestamp; }
    public void setTimestamp(Instant timestamp) { this.timestamp = timestamp; }
    public String getGranularity() { return granularity; }
    public void setGranularity(String granularity) { this.granularity = granularity; }
}

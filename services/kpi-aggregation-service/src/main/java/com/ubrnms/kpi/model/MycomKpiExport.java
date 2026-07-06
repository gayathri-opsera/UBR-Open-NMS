package com.ubrnms.kpi.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Mycom KPI export JSON format as required by the PRD. */
@Data
@NoArgsConstructor
public class MycomKpiExport {
    @JsonProperty("serialNumber")    private String serialNumber;
    @JsonProperty("deviceType")      private String deviceType;
    @JsonProperty("modelNo")         private String modelNo;
    @JsonProperty("collectionTime")  private String collectionTime;

    // Wireless 5 GHz radio
    @JsonProperty("wireless5GhzRadio") private WirelessRadio wireless5GhzRadio;

    // Ethernet ports
    @JsonProperty("ethernetPorts") private Map<String, EthernetPort> ethernetPorts;

    // System KPIs
    @JsonProperty("cpuUtilization")  private Double cpuUtilization;
    @JsonProperty("freeMemory")      private Long freeMemory;
    @JsonProperty("rebootCount")     private Long rebootCount;
    @JsonProperty("dyingGaspCount")  private Long dyingGaspCount;

    @Data
    @NoArgsConstructor
    public static class WirelessRadio {
        private Double rssi;
        private Double snr;
        private Integer operatingChannel;
        private Double channelUtilization;
        private Integer bandwidth;
        private Integer mcs;
        private Double txPower;
        private Double throughputUL;
        private Double throughputDL;
        private Double latency;
        private Long packetRetransmit;
        private Long crcErrors;
    }

    @Data
    @NoArgsConstructor
    public static class EthernetPort {
        private Long txBytes;
        private Long rxBytes;
        private Long errors;
        private Integer linkStatus;
    }
}

package com.ubrnms.kpi.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Deserialized raw KPI event from the raw-kpi Kafka topic.
 * Field names match the Go KPI collector's JSON output.
 */
@Data
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class RawKpiEvent {
    private String deviceId;
    private String deviceType;
    private String serialNumber;
    private String networkId;
    private Instant timestamp;
    private long pollCycle;

    // RF metrics
    private Double rssi;
    private Double snr;
    private Integer operatingChannel;
    private Double channelUtilization;
    private Integer bandwidth;
    private Integer mcs;
    private Double txPower;

    // Traffic
    private Double throughputUL;
    private Double throughputDL;
    private Long txPackets;
    private Long rxPackets;
    private Long txBytes;
    private Long rxBytes;
    private Long packetsDropped;
    private Long packetRetransmit;
    private Long crcErrors;
    private Double latency;

    // System
    private Double cpuUtilization;
    private Long freeMemory;
    private Long rebootCount;
    private Long dyingGaspCount;

    // Mycom-specific
    private String modelNo;
    private Map<String, Object> ethernetPorts;
}

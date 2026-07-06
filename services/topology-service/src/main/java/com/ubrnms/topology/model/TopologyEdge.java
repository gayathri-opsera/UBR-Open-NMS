package com.ubrnms.topology.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** A directed edge representing a device connection. */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class TopologyEdge {
    private String sourceDeviceId;
    private String targetDeviceId;
    private String linkType;   // BTS_TO_CPE, BTS_CASCADE, CPE_TO_IDU
    private String health;     // GOOD, DEGRADED, DOWN
}

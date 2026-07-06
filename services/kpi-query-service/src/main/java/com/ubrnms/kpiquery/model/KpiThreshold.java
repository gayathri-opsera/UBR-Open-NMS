package com.ubrnms.kpiquery.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;

/** Configurable KPI threshold. Breaches publish alarms to raw-alarms topic. */
@Data
@NoArgsConstructor
@Document(collection = "kpi_thresholds")
@CompoundIndex(def = "{'deviceId': 1, 'metric': 1}", unique = true)
public class KpiThreshold {
    @Id
    private String id;
    private String deviceId;       // null = global
    private String deviceType;
    private String networkId;
    private String metric;         // rssi, snr, cpuUtilization, etc.
    private double raiseThreshold;
    private double clearThreshold;
    private String severity;       // CRITICAL, MAJOR, MINOR, WARNING
    private boolean enabled = true;
    private String direction;      // ABOVE (default), BELOW
}

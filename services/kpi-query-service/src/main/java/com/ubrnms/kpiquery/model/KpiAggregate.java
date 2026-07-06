package com.ubrnms.kpiquery.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/** KPI aggregate record shared with kpi-aggregation-service (same MongoDB collection). */
@Data
@NoArgsConstructor
@Document(collection = "kpi_warm")
@CompoundIndex(def = "{'deviceId': 1, 'bucketStart': -1, 'granularity': 1}")
public class KpiAggregate {
    @Id
    private String id;
    private String deviceId;
    private String deviceType;
    private String networkId;
    private String organizationId;
    private String hierarchyId;
    private String granularity;   // 15MIN, 1HOUR, DAILY
    private Instant bucketStart;
    private Instant bucketEnd;
    private int sampleCount;
    private Map<String, MetricStats> metrics;

    @Indexed(expireAfterSeconds = 7776000)  // 90-day TTL
    private Instant ttlExpiry;
}

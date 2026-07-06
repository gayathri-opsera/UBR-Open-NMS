package com.ubrnms.kpi.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/**
 * Aggregated KPI bucket stored in MongoDB warm-storage collection.
 * This mirrors what ScyllaDB stores for hot storage but uses MongoDB for
 * the 90-day warm tier.
 */
@Data
@NoArgsConstructor
@Document(collection = "kpi_warm")
@CompoundIndex(def = "{'deviceId': 1, 'bucketStart': -1, 'granularity': 1}")
public class KpiAggregate {
    @Id
    private String id;        // deviceId:bucketStart:granularity

    private String deviceId;
    private String deviceType;
    private String networkId;
    private String granularity;  // 15MIN, 1HOUR, DAILY

    private Instant bucketStart;
    private Instant bucketEnd;
    private int sampleCount;

    // Aggregated metrics (min/max/avg per field)
    private Map<String, MetricStats> metrics;

    @Indexed(expireAfterSeconds = 7776000) // 90-day TTL
    private Instant ttlExpiry;
}

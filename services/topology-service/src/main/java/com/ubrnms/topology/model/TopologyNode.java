package com.ubrnms.topology.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.GeoSpatialIndexed;
import org.springframework.data.mongodb.core.index.GeoSpatialIndexType;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** A topology node representing a device with its relationships. */
@Data
@NoArgsConstructor
@Document(collection = "topology_nodes")
@CompoundIndex(def = "{'deviceId': 1}", unique = true)
public class TopologyNode {
    @Id
    private String id;

    @Indexed(unique = true)
    private String deviceId;

    private String serialNumber;
    private String macAddress;
    private String ipAddress;
    private String type;           // BTS, CPE, IDU
    private String status;         // online, offline, faulty
    private double latitude;
    private double longitude;

    @GeoSpatialIndexed(type = GeoSpatialIndexType.GEO_2DSPHERE)
    private double[] location;     // [lon, lat]

    // Topology relationships
    private String parentDeviceId;          // BTS's cascaded-from BTS, CPE's connected BTS
    private List<String> childDeviceIds = new ArrayList<>(); // BTS's CPEs, cascaded BTSs
    private int cascadeHop;                 // 0=primary BTS, 1=first cascade, 2=second cascade

    // Aggregated health (updated by Alarm Service events)
    private String linkHealth;      // GOOD, DEGRADED, DOWN
    private int openAlarmCount;
    private Instant lastHealthUpdate;

    // Hierarchy context
    private String networkId;
    private String organizationId;

    // ── WO-031: Post-registration topology walk request tracking ─────────────

    /**
     * Timestamp when an initial topology walk was requested for this node (WO-031).
     * Null if no walk has been requested. Used by the topology poller to pick up
     * pending walk requests.
     */
    @Indexed
    private Instant walkRequestedAt;

    /** Protocols to use for the pending walk (e.g. SNMP_NEIGHBOR, LLDP). */
    private List<String> walkSupportedProtocols;

    /** Correlation ID of the initial-walk trigger event. */
    private String walkCorrelationId;

    /**
     * Status of the topology walk request.
     * Values: PENDING, IN_PROGRESS, COMPLETED, FAILED.
     */
    @Indexed
    private String walkStatus;

    @LastModifiedDate
    private Instant updatedAt;
}

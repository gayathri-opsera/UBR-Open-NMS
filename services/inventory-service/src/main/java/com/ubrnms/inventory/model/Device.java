package com.ubrnms.inventory.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
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

/**
 * Unified device document — stores BTS (NMS-IV-02) and CPE (NMS-IV-03) fields.
 */
@Data
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
@Document(collection = "devices")
@CompoundIndex(name = "idx_serial", def = "{'serialNumber': 1}", unique = true)
@CompoundIndex(name = "idx_mac", def = "{'macAddress': 1}")
@CompoundIndex(name = "idx_ip", def = "{'ipAddress': 1}")
public class Device {

    @Id
    private String id;

    /** BTS or CPE */
    @Indexed
    private String deviceType;

    // --- Core fields (both BTS and CPE) ---
    @Indexed(unique = true)
    private String serialNumber;

    private String model;

    @Indexed
    private String macAddress;

    @Indexed
    private String ipAddress;

    private String firmwareVersion;
    private String softwareVersion;
    private String status;         // ACTIVE, INACTIVE, FAULTY, DECOMMISSIONED
    private long   uptimeSeconds;

    // --- Location ---
    private double latitude;
    private double longitude;
    private double elevation;
    private double azimuth;

    /** GeoJSON point for 2dsphere queries: [longitude, latitude] */
    @GeoSpatialIndexed(type = GeoSpatialIndexType.GEO_2DSPHERE)
    private double[] location; // [lon, lat]

    // --- BTS-specific (NMS-IV-02) ---
    private double  tilt;
    private String  channel;
    private String  channelBandwidth;
    private double  txPower;
    private Integer capacityPercentage;
    private List<String> connectedCpeSerials  = new ArrayList<>();
    private List<String> cascadedBtsSerials    = new ArrayList<>();

    // --- CPE-specific (NMS-IV-03) ---
    private String connectedBtsSerial;
    private Integer portOccupancy;
    private Integer capacity;
    private List<String> connectedIduSerials   = new ArrayList<>();

    // --- Organisational ---
    private String region;
    private String organizationId;

    // --- Metadata tags (NMS-IV-06) ---
    private List<DeviceTag> tags = new ArrayList<>();

    // --- Birth certificate reference ---
    private String birthCertificateId;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}

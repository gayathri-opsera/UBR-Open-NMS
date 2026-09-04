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
 * Extended with authority, bootstrap, capability, and credential reference fields (WO-002)
 * to support coexistence of UBR call-home and generic discovery without last-writer-wins corruption.
 */
@Data
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
@Document(collection = "devices")
@CompoundIndex(name = "idx_serial", def = "{'serialNumber': 1}", unique = true)
@CompoundIndex(name = "idx_mac", def = "{'macAddress': 1}")
@CompoundIndex(name = "idx_ip", def = "{'ipAddress': 1}")
public class Device {

    // ── Authority / paradigm enums (WO-002) ──────────────────────────────────

    /** How this device was discovered. */
    public enum DiscoveryParadigm {
        UBR_CALL_HOME, GENERIC_SNMP, GENERIC_CLI, UNKNOWN
    }

    /** Which system is authoritative for identity and online-state fields. */
    public enum IdentityAuthority {
        UBR, GENERIC, UNKNOWN
    }

    /** Bootstrap handshake state for UBR call-home devices. */
    public enum BootstrapState {
        PENDING, AUTHENTICATED, CHECK_IN_RECEIVED, REALTIME_ESTABLISHED, FAILED, UNKNOWN
    }

    // ── Identity ──────────────────────────────────────────────────────────────

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

    // ── WO-002: Authority, bootstrap, capability, credential ref ─────────────

    /** Schema version for migration tracking. Defaults to "1.0". */
    private String schemaVersion = "1.0";

    /** How this device was discovered — determines which authority rules apply. */
    @Indexed
    private String discoveryParadigm;   // DiscoveryParadigm enum value

    /**
     * Which system is authoritative for serialNumber, macAddress, deviceType identity.
     * UBR call-home sets UBR; generic discovery sets GENERIC.
     */
    @Indexed
    private String identityAuthority;   // IdentityAuthority enum value

    /**
     * Which system is authoritative for online/offline state.
     * UBR is authoritative when call-home is active; GENERIC otherwise.
     */
    private String onlineStateAuthority;  // IdentityAuthority enum value

    /** UBR bootstrap handshake state — only meaningful for UBR_CALL_HOME devices. */
    @Indexed
    private String bootstrapState;        // BootstrapState enum value

    /** Timestamp of the most recent UBR check-in message. */
    private Instant lastCheckInAt;

    /** Timestamp of the most recent UBR real-time WebSocket heartbeat. */
    private Instant lastRealtimeAt;

    /**
     * Reference to the CapabilityProfile document for this device.
     * Drives operation gating and protocol selection (WO-003).
     */
    @Indexed
    private String capabilityProfileId;

    /**
     * Opaque reference to the credential store entry for this device.
     * NEVER stores the credential value — only the reference key.
     */
    private String credentialRef;

    /** Config version string from the last successful config push. */
    private String configVersion;

    /** SNMP sysObjectID for generic-discovery devices (WO-004). */
    @Indexed
    private String sysObjectID;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}

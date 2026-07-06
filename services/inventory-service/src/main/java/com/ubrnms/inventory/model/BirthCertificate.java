package com.ubrnms.inventory.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Birth certificate — immutable after creation (NMS-IV-05).
 * Update attempts must return 403.
 */
@Data
@NoArgsConstructor
@Document(collection = "birth_certificates")
public class BirthCertificate {

    @Id
    private String id;

    @Indexed(unique = true)
    private String serialNumber;

    // Location snapshot at time of first check-in
    private double latitude;
    private double longitude;
    private double azimuth;

    // RF snapshot
    private double rssi;
    private double frequency;
    private String channel;
    private String channelBandwidth;
    private double snr;

    // CPE-only: connected BTS at time of first check-in
    private String connectedBtsSerial;

    private Instant capturedAt;
}

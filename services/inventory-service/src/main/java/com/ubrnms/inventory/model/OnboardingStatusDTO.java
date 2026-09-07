package com.ubrnms.inventory.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * Operator-facing DTO for a single device's onboarding status (WO-038).
 *
 * <p>Fields are derived from Device inventory state, bootstrap progress, policy gate
 * state, and failure reason categories. Sensitive authentication material (certificates,
 * HMAC signatures, nonces, credential refs) must never appear in this DTO.
 */
@Data
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class OnboardingStatusDTO {

    /** Inventory device ID (MongoDB document id). */
    private String deviceId;

    /** Device serial number — never null for UBR devices. */
    private String serialNumber;

    /** MAC address. Not always known for generic-discovery devices at early stages. */
    private String macAddress;

    /** Device type: BTS, CPE, IDU, or UNKNOWN. */
    private String deviceType;

    /** Discovery paradigm: UBR_CALL_HOME, GENERIC_SNMP, GENERIC_CLI, UNKNOWN. */
    private String discoveryParadigm;

    /** SNMP sysObjectID — only present for generic-discovery devices. */
    private String sysObjectID;

    /** UBR bootstrap handshake state: PENDING, AUTHENTICATED, CHECK_IN_RECEIVED, REALTIME_ESTABLISHED, FAILED, UNKNOWN. */
    private String bootstrapState;

    /**
     * Operator-visible consolidated onboarding state.
     * Values: MANAGED, PENDING_ASSIGNMENT, CONFIG_WITHHELD, FAILED, RETRYING, REDIRECTED,
     * CHECK_IN_RECEIVED, AUTHENTICATED, PENDING, UNKNOWN.
     */
    private String onboardingState;

    /** Last bootstrap state that completed successfully. Used to distinguish partial failures. */
    private String lastSuccessfulState;

    /**
     * Categorised reason for the most recent onboarding failure or hold.
     * Values from Device.onboardingFailureReason: AUTH_FAILED, SIGNING_INVALID,
     * ASSIGNMENT_PENDING, CHECKIN_FAILED, REALTIME_TIMEOUT, GPS_PENDING, NMS_FAILOVER, UNKNOWN.
     * Never contains credentials or signing material.
     */
    private String reasonCategory;

    /** Seconds to wait before retrying — present when onboardingState is RETRYING. */
    private Integer retryAfterSeconds;

    /** Maximum jitter in seconds to add to retryAfterSeconds. */
    private Integer retryJitterMaxSeconds;

    /** Timestamp of the last successful UBR check-in message. */
    private Instant lastCheckInAt;

    /** Timestamp of the last UBR realtime WebSocket heartbeat. */
    private Instant lastRealtimeAt;

    /**
     * Assignment gate state: MANAGED, PENDING_ASSIGNMENT, CONFIG_WITHHELD.
     * Null for generic-discovery devices where the gate is not applicable.
     */
    private String assignmentState;

    /**
     * Configuration delivery eligibility derived from gate state.
     * Values: ELIGIBLE, WITHHELD, UNKNOWN.
     */
    private String configurationDeliveryState;

    /** Last time this device record was modified. */
    private Instant updatedAt;
}

package com.ubrnms.config.model;

import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Per-device delivery record for a confirmed config job (WO-049).
 *
 * <p>Tracks the delivery channel selected, individual protocol attempts,
 * queue eligibility, and the final observable state for operator visibility.
 * Stored as an embedded list on {@link ConfigJob}.
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PerDeviceDeliveryRecord {

    private String deviceId;

    /**
     * Classified delivery channel from target preview:
     * UBR_REALTIME | UBR_CHECKIN | SNMP_PROTOCOL | CLI_PROTOCOL | UNSUPPORTED
     */
    private String deliveryChannel;

    /**
     * Current per-device state:
     * PENDING | PUBLISHED | QUEUED | FAILED | UNSUPPORTED | RETRYING | TIMEOUT
     */
    private String currentState;

    /** Whether this device is eligible for deferred (offline) command queuing. */
    private boolean queueEligible;

    /** ID of the PendingCommand created for UBR call-home devices (null for generic). */
    private String pendingCommandId;

    /** Protocol attempts in order — each attempt records the tried protocol and outcome. */
    @Builder.Default
    private List<ProtocolAttempt> protocolAttempts = new ArrayList<>();

    /** Human-readable reason for failure; null when delivery succeeded or is pending. */
    private String failureReason;

    /** Whether this device can be retried after a transient failure. */
    private boolean retryable;

    /** Timestamp of the last state change for this record. */
    private Instant lastUpdatedAt;

    /** Kafka idempotency key sent with the push message (used for dedup by the worker). */
    private String idempotencyKey;

    /**
     * A single protocol delivery attempt with its result (WO-049).
     */
    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class ProtocolAttempt {
        /** E.g. NETCONF, CLI, SNMP, TR069, UBR_REALTIME */
        private String protocol;
        /** SUCCESS | FAILURE | TIMEOUT | FALLBACK */
        private String status;
        private Instant startedAt;
        private Instant completedAt;
        private String failureReason;
        private String errorCode;
    }
}

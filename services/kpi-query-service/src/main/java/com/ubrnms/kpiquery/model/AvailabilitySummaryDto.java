package com.ubrnms.kpiquery.model;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.List;

/**
 * Per-device availability summary response DTO (WO-041).
 *
 * <p>Exposes deterministic operational health state derived from KPI aggregates,
 * alarm context, inventory identity, and optional call-home authority hints.
 * State precedence: DOWN > DEGRADED > UNKNOWN > UP.
 */
@Data
@Builder
public class AvailabilitySummaryDto {

    public enum HealthState {
        UP, DOWN, DEGRADED, UNKNOWN;

        /** Higher ordinal = higher precedence when merging states. */
        public boolean overrides(HealthState other) {
            return this.ordinal() > other.ordinal();
        }
    }

    public enum Source {
        CALL_HOME, KPI, ALARM, SNMP, UNKNOWN
    }

    private String deviceId;
    private String serialNumber;
    private String deviceType;

    /** Deterministic operational health state. */
    private HealthState healthState;

    /** Human-readable primary reason for the current state. */
    private String primaryReason;

    /** Additional contributing factors, ordered by precedence. */
    private List<String> secondaryReasons;

    /** ISO timestamp of the most recent observation used to determine state. */
    private Instant lastObservedAt;

    /** Signal source that determined this state. */
    private Source source;

    /** Confidence score in range [0.0, 1.0]. */
    private double confidence;

    /** True when lastObservedAt is older than the configured freshness window. */
    private boolean stale;

    /**
     * Non-null when flap dampening is active. State will not be re-evaluated
     * until this instant passes, preventing oscillation during flapping.
     */
    private Instant dampenedUntil;
}

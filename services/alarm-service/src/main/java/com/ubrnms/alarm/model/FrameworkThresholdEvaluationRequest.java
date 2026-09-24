package com.ubrnms.alarm.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * WO-013: Input contract for framework metadata threshold evaluation.
 *
 * Carries the resolved numeric parameter value and its Product Definition
 * threshold bounds to the alarm service for threshold evaluation.
 *
 * Constraints:
 * - credentialRef fields are NEVER permitted in this DTO — the alarm service
 *   must not receive, log, or store any authentication material.
 * - Only fresh, numeric parameter values are submitted; stale, unmapped,
 *   or non-numeric values are filtered by the caller before submission.
 *
 * Note: @Data + @NoArgsConstructor + @AllArgsConstructor is the Lombok pattern
 * required for Jackson deserialization compatibility.  The previously-used
 * @Value/@Builder combination produced an immutable class with no no-arg
 * constructor, which Jackson cannot instantiate from JSON.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FrameworkThresholdEvaluationRequest {

    /** Inventory device identifier. */
    String deviceId;

    /**
     * Device type string (BTS, CPE, IDU, NMS) — forwarded unchanged to the
     * alarm model for NOC triage and alarm routing.
     */
    String deviceType;

    /** Product Definition identifier. */
    String productDefinitionId;

    /** Active registry version used to resolve this parameter. */
    String registryVersion;

    /** Parameter group identifier. */
    String groupId;

    /** Stable parameter identifier from the Product Definition. */
    String parameterId;

    /**
     * Resolved numeric value of the parameter.
     * The caller guarantees this is non-null and was obtained from a fresh
     * poll cycle; stale values must not be submitted for threshold evaluation.
     */
    double valueNumeric;

    /**
     * ISO-8601 UTC timestamp when the value was collected.
     * Used for temporal ordering in audit and deduplication context.
     */
    Instant collectedAt;

    /**
     * High-value alarm threshold from the Product Definition parameter metadata.
     * Null means no high threshold is configured — evaluation skips the high check.
     */
    Double thresholdHigh;

    /**
     * Low-value alarm threshold from the Product Definition parameter metadata.
     * Null means no low threshold is configured — evaluation skips the low check.
     */
    Double thresholdLow;

    /**
     * End-to-end correlation identifier propagated from the poll cycle.
     * Used to trace threshold evaluations back to their originating poll run.
     * Never contains credential material.
     */
    String correlationId;
}

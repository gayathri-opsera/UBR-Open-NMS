package com.ubrnms.alarm.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Request DTO for the framework config-drift evaluation endpoint.
 *
 * <p>Config drift occurs when a device's polled parameter value falls outside the
 * schema-declared {@code minValue}/{@code maxValue} bounds in the active Product
 * Definition registry — indicating the device is operating outside its validated
 * parameter envelope.
 *
 * <p>This is distinct from {@link FrameworkThresholdEvaluationRequest} which carries
 * user-configured operational thresholds. Drift alarms reflect product definition
 * schema violations rather than operational limit violations.
 *
 * <p>Credential policy: no credential values or secret material in any field.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FrameworkDriftEvaluationRequest {

    private String deviceId;
    private String deviceType;
    private String productDefinitionId;
    private String registryVersion;
    private String groupId;
    private String parameterId;

    /** The numeric value observed by the parameter poller. */
    private double valueNumeric;

    /** ISO-8601 collection timestamp from the poller. */
    private String collectedAt;

    /**
     * Schema-declared minimum value from the Product Definition registry.
     * {@code null} means no lower bound is declared.
     */
    private Double minValue;

    /**
     * Schema-declared maximum value from the Product Definition registry.
     * {@code null} means no upper bound is declared.
     */
    private Double maxValue;

    private String correlationId;
}

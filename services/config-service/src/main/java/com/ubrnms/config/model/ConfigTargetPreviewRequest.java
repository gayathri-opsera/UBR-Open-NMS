package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;

/**
 * Request body for POST /api/v1/config/targets/preview (WO-039).
 *
 * <p>Specifies the action type and filter criteria for cross-paradigm target
 * resolution. The resolver returns a deterministic preview of affected devices
 * without executing any configuration command.
 *
 * <p>At least one non-null filter field is required; an empty filter object
 * returns a 400 response rather than matching all devices.
 */
@Data
@NoArgsConstructor
public class ConfigTargetPreviewRequest {

    /**
     * The intended configuration action type.
     * Values: CONFIG_PUSH, FIRMWARE_UPGRADE, PARAMETER_CHANGE, COMMAND_EXECUTE.
     * Used for capability gating in the resolver — devices that don't support
     * the action are listed in unsupportedTargets rather than targets.
     */
    @NotBlank
    private String actionType;

    /** Maximum number of targets to include in the preview response. Default: 500. */
    @Min(1)
    @Max(2000)
    private int limit = 500;

    /** Optional sort field: deviceType, serialNumber, status, discoveryParadigm. */
    private String sort;

    @Valid
    private TargetFilters filters;

    /**
     * Structured filter fields for target resolution (WO-039).
     * All fields are optional; at least one must be non-null and non-empty.
     */
    @Data
    @NoArgsConstructor
    public static class TargetFilters {

        /** Match by UBR-style serial numbers (partial or exact). */
        @Size(max = 100)
        private List<String> serialNumbers;

        /** Match by MAC address (exact). */
        @Size(max = 100)
        private List<String> macAddresses;

        /** Match by device type: BTS, CPE, IDU, GENERIC. */
        private String deviceType;

        /**
         * Match by SNMP sysObjectID prefix (generic devices only).
         * Pattern: dotted-numeric OID, e.g. 1.3.6.1.4.1.9
         */
        private String sysObjectID;

        /** Match by vendor name (generic devices). */
        private String vendor;

        /** Match by model name (substring match). */
        private String model;

        /** Match by management IP or subnet prefix. */
        private String ipAddress;

        /** Match by region code. */
        private String region;

        /** Match by organizationId. */
        private String organizationId;

        /** Match by hierarchy network ID. */
        private String networkId;

        /**
         * Match by discovery paradigm: UBR_CALL_HOME, GENERIC_SNMP, GENERIC_CLI.
         * Filtering to UBR_CALL_HOME with a sysObjectID filter returns 400
         * since UBR devices don't have sysObjectIDs.
         */
        private String discoveryParadigm;

        /** Match by device status: ACTIVE, INACTIVE, FAULTY, DECOMMISSIONED. */
        private String status;

        /** Match by capability profile ID. */
        private String capabilityProfileId;

        /**
         * Match devices having ALL of the specified tags.
         * Tag format: {"key": "k", "value": "v"}.
         */
        @Size(max = 20)
        private List<Map<String, String>> tags;

        /** Match by onboarding gate state: MANAGED, PENDING_ASSIGNMENT, CONFIG_WITHHELD. */
        private String onboardingGateState;
    }
}

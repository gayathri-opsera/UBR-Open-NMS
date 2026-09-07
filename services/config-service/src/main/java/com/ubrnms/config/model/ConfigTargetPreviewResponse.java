package com.ubrnms.config.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Response body for POST /api/v1/config/targets/preview (WO-039).
 *
 * <p>Contains the deterministic, non-mutating preview of devices that match
 * the submitted filter criteria, together with delivery channel classification
 * and a list of unsupported targets.
 *
 * <p>Secrets, credentials, and southbound connection details are NEVER included.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ConfigTargetPreviewResponse {

    /** Opaque preview identifier — may be used to correlate preview with execution. */
    private String previewId;

    /** Total count of devices that matched the filters (before limit is applied). */
    private int totalCount;

    /** Devices that match filters and support the requested action. */
    private List<TargetEntry> targets;

    /** Devices that matched filters but do NOT support the requested action. */
    private List<UnsupportedTargetEntry> unsupportedTargets;

    /** ISO-8601 timestamp when this preview was generated. */
    private String generatedAt;

    /**
     * Whether execution requires explicit confirmation.
     * True for FIRMWARE_UPGRADE or when totalCount > 50.
     */
    private boolean requiresConfirmation;

    // ── Inner types ───────────────────────────────────────────────────────────

    /**
     * A single matched device with its delivery classification (WO-039).
     * Never contains credential values, HMAC keys, or southbound secrets.
     */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class TargetEntry {
        private String deviceId;
        private String displayName;
        private String serialNumber;
        /** Only included for GENERIC devices; absent (null) for UBR devices. */
        private String macAddress;
        private String deviceType;
        /** Present for generic-discovery devices; null for UBR devices. */
        private String sysObjectID;
        /** UBR_CALL_HOME | GENERIC_SNMP | GENERIC_CLI | UNKNOWN */
        private String discoveryParadigm;
        /** ACTIVE | INACTIVE | FAULTY | DECOMMISSIONED */
        private String status;
        /** List of operation codes the device supports per its capability profile. */
        private List<String> capabilities;
        /** Filter field names that caused this device to be included in the result. */
        private List<String> matchedFilters;
        /**
         * How configuration will be delivered to this device.
         * Values:
         * - UBR_REALTIME      — via active WebSocket connection (UBR online)
         * - UBR_CHECKIN       — via next check-in heartbeat (UBR offline)
         * - SNMP_PROTOCOL     — via SNMP SET (generic SNMP device)
         * - CLI_PROTOCOL      — via SSH/Telnet (generic CLI device)
         * - UNSUPPORTED       — device paradigm is unknown
         */
        private String deliveryChannel;
        /**
         * Non-fatal warnings about this target.
         * E.g. "Device is offline — delivery queued until next check-in".
         * Empty list if none.
         */
        private List<String> warnings;
    }

    /**
     * A device that matched filters but cannot support the requested action.
     * Included in the response for transparency so operators know what was excluded.
     */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class UnsupportedTargetEntry {
        private String deviceId;
        private String serialNumber;
        private String deviceType;
        private String discoveryParadigm;
        /** Human-readable reason why this device does not support the action. */
        private String reason;
        /** The unsupported operation code. */
        private String unsupportedOperation;
    }
}

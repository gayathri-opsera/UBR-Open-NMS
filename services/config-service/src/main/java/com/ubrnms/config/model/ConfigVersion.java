package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A versioned snapshot of a device's configuration (WO-050 extended).
 *
 * <p>Records both successful applied versions and failed attempt evidence.
 * Sanitized diffs are stored with credential-like values redacted before persistence.
 * No inline secrets, rendered credential values, or unredacted payloads are stored.
 */
@Data
@NoArgsConstructor
@Document(collection = "config_versions")
@CompoundIndex(name = "device_version_idx", def = "{'deviceId': 1, 'versionNumber': -1}")
@CompoundIndex(name = "device_applied_idx",  def = "{'deviceId': 1, 'appliedAt': -1}")
public class ConfigVersion {
    @Id
    private String id;
    private String deviceId;
    private int versionNumber;
    private String templateId;
    private String actor;

    /** Raw before/after maps (kept for internal diff computation — never exposed to API). */
    private Map<String, Object> previousValues;
    private Map<String, Object> newValues;

    private Instant appliedAt;

    /** APPLIED | FAILED | ATTEMPTED — ATTEMPTED means delivery was tried but no state change confirmed. */
    private String status;

    // ── WO-050: Configuration history fields ──────────────────────────────────

    /**
     * Job that produced this version record.
     * Links version history back to the confirmed job and its approval metadata.
     */
    private String jobId;

    /**
     * Delivery channel used for this push attempt.
     * UBR_REALTIME | UBR_CHECKIN | SNMP_PROTOCOL | CLI_PROTOCOL
     */
    private String deliveryChannel;

    /**
     * External approval reference forwarded from the confirmed job (change ticket, etc.).
     * Null if no approval reference was provided.
     */
    private String approvalReference;

    /**
     * Human-readable summary of the change (what parameters changed and in which direction).
     * Must never include secret values.
     */
    private String diffSummary;

    /**
     * Sanitized per-field diff: list of { field, from, to } entries.
     * Secret-like field values are replaced with REDACTED_* markers.
     */
    private List<DiffEntry> sanitizedDiff;

    /**
     * SHA-256 hash of the rendered configuration content for integrity verification.
     * The hash is over the sanitized (post-redaction) representation.
     */
    private String renderedHash;

    /**
     * Client-supplied idempotency key from the confirmed job.
     * Prevents duplicate version records for duplicate job result callbacks.
     */
    @Indexed
    private String idempotencyKey;

    /** Whether this version can serve as a rollback target. */
    private boolean rollbackEligible;

    /**
     * Timestamp for failed attempts (when no definitive appliedAt exists).
     * Set instead of appliedAt for FAILED / ATTEMPTED records.
     */
    private Instant attemptedAt;

    /**
     * Failure reason when status is FAILED or ATTEMPTED.
     * Never contains raw credential values or stack traces with sensitive data.
     */
    private String failureReason;

    /**
     * A single sanitized field-level change entry for the sanitizedDiff list.
     */
    @Data
    @NoArgsConstructor
    public static class DiffEntry {
        private String field;
        /** Previous value — REDACTED_* when the field is secret-like. */
        private Object from;
        /** New value — REDACTED_* when the field is secret-like. */
        private Object to;

        public DiffEntry(String field, Object from, Object to) {
            this.field = field;
            this.from  = from;
            this.to    = to;
        }
    }
}

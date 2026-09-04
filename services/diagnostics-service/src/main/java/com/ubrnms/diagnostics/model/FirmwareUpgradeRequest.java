package com.ubrnms.diagnostics.model;

import lombok.Data;
import lombok.NoArgsConstructor;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Pattern;

/**
 * Request DTO for firmware upgrade operations (WO-012).
 * Strict validation ensures compatibility checks and checksum verification
 * occur before any image transfer begins.
 */
@Data
@NoArgsConstructor
public class FirmwareUpgradeRequest {

    /** Image reference or URI (not binary payload). */
    @NotBlank(message = "imageRef is required")
    private String imageRef;

    /** Expected firmware version after upgrade. */
    @NotBlank(message = "expectedVersion is required")
    @Pattern(regexp = "^\\d+\\.\\d+\\.\\d+.*", message = "expectedVersion must follow semver pattern (e.g., 3.5.2.1)")
    private String expectedVersion;

    /** Checksum algorithm: SHA256, MD5, SHA1. */
    @NotNull(message = "checksumAlgorithm is required")
    @Pattern(regexp = "^(SHA256|MD5|SHA1)$", message = "checksumAlgorithm must be SHA256, MD5, or SHA1")
    private String checksumAlgorithm;

    /** Checksum value for verification. */
    @NotBlank(message = "checksumValue is required")
    private String checksumValue;

    /** Transfer method: SCP, TFTP, HTTP, CALL_HOME. */
    @NotNull(message = "transferMethod is required")
    @Pattern(regexp = "^(SCP|TFTP|HTTP|CALL_HOME)$", message = "transferMethod must be SCP, TFTP, HTTP, or CALL_HOME")
    private String transferMethod;

    /** Operator reason for upgrade. */
    private String reason;

    /** Explicit confirmation required for production upgrades. */
    private Boolean confirmation;

    /** Optional idempotency key for duplicate prevention. */
    private String idempotencyKey;

    /** Optional maintenance window start time (ISO 8601). */
    private String maintenanceWindow;
}

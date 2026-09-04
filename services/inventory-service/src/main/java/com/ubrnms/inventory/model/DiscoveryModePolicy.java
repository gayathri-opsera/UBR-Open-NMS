package com.ubrnms.inventory.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Persisted policy record for dual-discovery mode governance (WO-001).
 *
 * <p>Each document controls enablement for one discovery mode (UBR call-home
 * or generic discovery) independently. Changes are audit-trailed and
 * admin-only via the DiscoveryModeController.
 *
 * <p>Stored in the {@code discovery_mode_policies} MongoDB collection.
 */
@Data
@NoArgsConstructor
@Document(collection = "discovery_mode_policies")
public class DiscoveryModePolicy {

    /** Supported discovery mode identifiers. */
    public enum Mode {
        UBR_CALL_HOME,
        GENERIC_DISCOVERY
    }

    /** Rollout level for gradual enablement. */
    public enum RolloutLevel {
        disabled,
        beta,
        production
    }

    @Id
    private String id;

    /** Which discovery mode this policy controls. */
    @Indexed(unique = true)
    private String mode;    // DiscoveryModePolicy.Mode enum value

    /** Whether this discovery mode is currently enabled. */
    private boolean enabled;

    /** Rollout level: disabled / beta / production. */
    private String rolloutLevel;   // RolloutLevel enum value

    /**
     * Reference to the beta sign-off ticket or document.
     * Required when rolloutLevel is "beta".
     */
    private String betaSignoffRef;

    /**
     * Human-readable reason for the last state change.
     * Required when changing the mode.
     */
    private String reason;

    /** User ID of the admin who last updated this policy. */
    private String updatedBy;

    /** Timestamp of the last update. */
    private Instant updatedAt;

    @CreatedDate
    private Instant createdAt;
}

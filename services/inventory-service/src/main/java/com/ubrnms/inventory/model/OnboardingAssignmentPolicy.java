package com.ubrnms.inventory.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Persisted policy for the UBR onboarding assignment gate (WO-033).
 *
 * <p>When {@code enabled} is false (default), valid call-home devices that pass
 * authentication and check-in are immediately moved to MANAGED state and become
 * eligible for configuration delivery.
 *
 * <p>When {@code enabled} is true, devices that have no hierarchy assignment
 * are held in PENDING_ASSIGNMENT state and configuration delivery is withheld
 * until an operator completes the assignment.
 *
 * <p>There is exactly one document per tenant, stored in the
 * {@code onboarding_assignment_policies} MongoDB collection.
 */
@Data
@NoArgsConstructor
@Document(collection = "onboarding_assignment_policies")
public class OnboardingAssignmentPolicy {

    /** Possible onboarding gate states for a device. */
    public enum GateState {
        /** Device has an assignment and/or gate is disabled — config delivery is allowed. */
        MANAGED,
        /** Gate is enabled and device has no hierarchy assignment — config delivery blocked. */
        PENDING_ASSIGNMENT,
        /** Config delivery explicitly withheld by operator action. */
        CONFIG_WITHHELD
    }

    @Id
    private String id;

    /** Document type key — always "ONBOARDING_ASSIGNMENT_GATE". */
    @Indexed(unique = true)
    private String policyKey = "ONBOARDING_ASSIGNMENT_GATE";

    /**
     * Whether the assignment gate is active.
     * Default: false — devices are automatically managed after valid onboarding.
     */
    private boolean enabled = false;

    /**
     * Human-readable description of the current policy state.
     * Populated on creation and updates.
     */
    private String description;

    /** User ID of the admin who last updated this policy. */
    private String updatedBy;

    /** Timestamp of the last update. */
    private Instant updatedAt;

    /** Human-readable reason for the most recent policy change. Immutable audit trail. */
    private String changeReason;
}

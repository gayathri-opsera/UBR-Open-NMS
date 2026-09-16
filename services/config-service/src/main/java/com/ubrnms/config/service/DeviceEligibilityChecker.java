package com.ubrnms.config.service;

/**
 * Interface for checking whether a device is eligible for configuration delivery (WO-033).
 *
 * <p>A device is ineligible when the onboarding assignment gate is enabled and the device
 * has not yet been assigned to a hierarchy (PENDING_ASSIGNMENT state), or when config
 * delivery has been explicitly withheld by an operator (CONFIG_WITHHELD state).
 *
 * <p>In production this queries the Inventory Service or a device-state cache.
 */
public interface DeviceEligibilityChecker {

    /** Reasons a device may be ineligible for config delivery. */
    enum IneligibilityReason {
        PENDING_ASSIGNMENT,
        CONFIG_WITHHELD
    }

    /**
     * Returns {@code null} when the device is eligible for config delivery.
     * Returns an {@link IneligibilityReason} describing why delivery is blocked otherwise.
     */
    IneligibilityReason checkEligibility(String deviceId);
}

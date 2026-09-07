package com.ubrnms.config.model;

import java.util.Set;

/**
 * Defines the operation class taxonomy for per-device concurrency control (WO-018).
 *
 * Exclusive operations cannot run concurrently with each other on the same device.
 * READ_ONLY_DIAGNOSTIC is the only class that is compatible with all others when
 * explicitly allowed by policy.
 */
public enum OperationClass {
    CONFIG_CHANGE,
    REBOOT,
    FACTORY_RESET,
    FIRMWARE_UPGRADE,
    FILE_TRANSFER,
    READ_ONLY_DIAGNOSTIC;

    /**
     * Returns true when this operation class is exclusive (i.e. cannot overlap with
     * any other exclusive operation on the same device).
     */
    public boolean isExclusive() {
        return this != READ_ONLY_DIAGNOSTIC;
    }

    /**
     * Returns true when this and the other operation class are compatible and
     * may run concurrently on the same device.
     *
     * Policy: READ_ONLY_DIAGNOSTIC is compatible with all other classes.
     * All exclusive operation classes are incompatible with each other.
     */
    public boolean isCompatibleWith(OperationClass other) {
        if (this == READ_ONLY_DIAGNOSTIC || other == READ_ONLY_DIAGNOSTIC) {
            return true;
        }
        // Two exclusive operations are never compatible
        return false;
    }

    /**
     * The set of exclusive operation classes used for guard enforcement.
     */
    public static final Set<OperationClass> EXCLUSIVE_CLASSES = Set.of(
            CONFIG_CHANGE, REBOOT, FACTORY_RESET, FIRMWARE_UPGRADE, FILE_TRANSFER
    );
}

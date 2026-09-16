package com.ubrnms.credentialvault.contracts;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * Snapshot of the credential vault runtime health at a point in time (WO-016).
 *
 * <p>Consumed by {@link com.ubrnms.credentialvault.health.VaultHealthIndicator}
 * and exposed via {@code /actuator/health}.
 */
@Getter
@Builder
public class VaultHealthStatus {

    public enum Status { UP, INITIALIZING, DEGRADED, DOWN }

    private final Status status;
    private final EncryptionProvider encryptionProvider;
    private final String environment;
    private final boolean tenantIsolationEnabled;
    private final Instant initializedAt;
    private final String detail;

    /** Returns true only when the vault is fully operational. */
    public boolean isOperational() {
        return status == Status.UP;
    }
}

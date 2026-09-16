package com.ubrnms.credentialvault.health;

import com.ubrnms.credentialvault.contracts.CredentialVaultContract;
import com.ubrnms.credentialvault.contracts.VaultHealthStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Spring Boot Actuator health indicator for the credential vault runtime (WO-016).
 *
 * <p>Exposes vault health at {@code /actuator/health/credentialVault}.
 * Kubernetes readiness and liveness probes should watch this component.
 *
 * <p>Health details included in the response (safe to expose — no key material):
 * <ul>
 *   <li>{@code provider} — encryption provider enum value</li>
 *   <li>{@code environment} — runtime environment (local/test/deployed)</li>
 *   <li>{@code tenantIsolation} — whether tenant-scoped credential paths are enforced</li>
 *   <li>{@code initializedAt} — ISO-8601 timestamp of successful bootstrap</li>
 *   <li>{@code detail} — human-readable status description</li>
 * </ul>
 */
@Component
@RequiredArgsConstructor
public class VaultHealthIndicator implements HealthIndicator {

    private final CredentialVaultContract vault;

    @Override
    public Health health() {
        VaultHealthStatus vaultStatus = vault.getHealthStatus();

        Health.Builder builder = vaultStatus.isOperational() ? Health.up() : Health.down();

        if (vaultStatus.getEncryptionProvider() != null) {
            builder.withDetail("provider", vaultStatus.getEncryptionProvider().name());
        }
        if (vaultStatus.getEnvironment() != null) {
            builder.withDetail("environment", vaultStatus.getEnvironment());
        }
        builder.withDetail("tenantIsolation", vaultStatus.isTenantIsolationEnabled());
        if (vaultStatus.getInitializedAt() != null) {
            builder.withDetail("initializedAt", vaultStatus.getInitializedAt().toString());
        }
        if (vaultStatus.getDetail() != null) {
            builder.withDetail("detail", vaultStatus.getDetail());
        }

        return builder.build();
    }
}

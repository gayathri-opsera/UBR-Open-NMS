package com.ubrnms.credentialvault.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;

/**
 * Typed configuration for the credential vault runtime (WO-016).
 *
 * <p>Three environments are supported:
 * <ul>
 *   <li>{@code local} — uses a deterministic test key; never for production data</li>
 *   <li>{@code test} — uses injected test key material for CI pipelines</li>
 *   <li>{@code deployed} — requires VAULT_MASTER_KEY_B64 env var with a 256-bit AES key</li>
 * </ul>
 *
 * <p>Key material is never logged, serialised, or included in health responses.
 */
@Getter
@Setter
@Validated
@ConfigurationProperties(prefix = "credential-vault")
public class VaultBootstrapConfig {

    /**
     * Runtime environment. Controls key source and tenant isolation defaults.
     * One of: local, test, deployed.
     */
    @NotBlank
    private String environment = "local";

    /**
     * Name of the environment variable holding the Base64-encoded AES-256 master key.
     * The actual key is never stored in this config object — only the env var name is.
     */
    @NotBlank
    private String masterKeyEnvVar = "VAULT_MASTER_KEY_B64";

    /**
     * When true, each tenant's credentials are isolated under a separate key derivation path.
     * Must be true for multi-tenant production deployments.
     */
    private boolean tenantIsolationEnabled = false;

    /**
     * Maximum character length for a vault credential reference path.
     * Paths exceeding this limit are rejected at validation time.
     */
    @Positive
    private int maxCredentialPathLength = 512;

    /**
     * Returns true if the configured environment requires externally-provided key material.
     * For {@code local} and {@code test}, a synthetic key may be used.
     */
    public boolean requiresExternalKeyMaterial() {
        return "deployed".equals(environment);
    }
}

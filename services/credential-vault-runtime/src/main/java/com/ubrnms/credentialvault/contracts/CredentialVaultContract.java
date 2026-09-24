package com.ubrnms.credentialvault.contracts;

/**
 * Contract interface for credential vault operations (WO-016).
 *
 * <p>Dependent services (WO-005 credential protection, WO-020 audit lineage,
 * WO-021 publish validation gates) bind to this interface rather than any
 * concrete vault implementation. This allows the underlying encryption backend
 * to evolve without affecting consumers.
 *
 * <p><strong>Integration contract:</strong> Callers must check {@link #isReady()}
 * before any operation. If not ready, callers must return HTTP 503 with
 * error code {@code VAULT_NOT_READY}.
 */
public interface CredentialVaultContract {

    /**
     * Initialises the vault runtime using the provided bootstrap configuration.
     * Called once during application startup by {@link com.ubrnms.credentialvault.bootstrap.VaultBootstrapper}.
     *
     * @throws VaultInitializationException if key material is missing or invalid
     */
    void initialize(com.ubrnms.credentialvault.config.VaultBootstrapConfig config)
            throws VaultInitializationException;

    /**
     * Returns true when the vault is fully initialised and ready to resolve credentials.
     * Dependent services must poll this before credential operations.
     */
    boolean isReady();

    /**
     * Resolves a vault credential reference to its plaintext value for the given tenant.
     *
     * <p>The {@code vaultRef} must follow the format {@code vault://credentials/{path}}.
     * Inline credentials, passwords, or secret values are never accepted as vaultRef values.
     *
     * @param vaultRef  vault path in format vault://credentials/{path}
     * @param tenantId  tenant scope for isolation; use {@code "default"} in single-tenant mode
     * @return resolved credential value — caller is responsible for zeroing the char array after use
     * @throws CredentialResolutionException if the path is not found or the vault is not ready
     */
    char[] resolveCredential(String vaultRef, String tenantId) throws CredentialResolutionException;

    /**
     * Returns the encryption provider used by this vault instance.
     * Used by dependent services to confirm the expected encryption algorithm is active.
     */
    EncryptionProvider getEncryptionProvider();

    /**
     * Returns the current health status of the vault runtime.
     * Consumed by {@link com.ubrnms.credentialvault.health.VaultHealthIndicator}.
     */
    VaultHealthStatus getHealthStatus();
}

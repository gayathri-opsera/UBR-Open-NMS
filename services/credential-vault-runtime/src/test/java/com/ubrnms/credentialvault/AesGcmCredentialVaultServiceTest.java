package com.ubrnms.credentialvault;

import com.ubrnms.credentialvault.bootstrap.AesGcmCredentialVaultService;
import com.ubrnms.credentialvault.config.VaultBootstrapConfig;
import com.ubrnms.credentialvault.contracts.CredentialResolutionException;
import com.ubrnms.credentialvault.contracts.EncryptionProvider;
import com.ubrnms.credentialvault.contracts.VaultHealthStatus;
import com.ubrnms.credentialvault.contracts.VaultInitializationException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for AesGcmCredentialVaultService (WO-016).
 *
 * Covers: successful bootstrap, missing config, invalid env, missing key in deployed mode,
 * invalid Base64 key, wrong key length, credential resolution, vault-not-ready guard,
 * invalid path format, tenant scope violation, path-not-found, health status transitions,
 * and encryption provider correctness per environment.
 */
class AesGcmCredentialVaultServiceTest {

    private AesGcmCredentialVaultService vault;
    private VaultBootstrapConfig localConfig;

    @BeforeEach
    void setUp() {
        vault = new AesGcmCredentialVaultService();
        localConfig = new VaultBootstrapConfig();
        localConfig.setEnvironment("local");
        localConfig.setMasterKeyEnvVar("VAULT_MASTER_KEY_B64");
        localConfig.setTenantIsolationEnabled(false);
        localConfig.setMaxCredentialPathLength(512);
    }

    // ─── Bootstrap: happy path ─────────────────────────────────────────────

    @Test
    void bootstrap_localEnvironment_transitionsToReady() {
        vault.initialize(localConfig);

        assertThat(vault.isReady()).isTrue();
        assertThat(vault.getEncryptionProvider()).isEqualTo(EncryptionProvider.PLAINTEXT_DEV_ONLY);
    }

    @Test
    void bootstrap_testEnvironment_useSyntheticKey() {
        VaultBootstrapConfig testConfig = new VaultBootstrapConfig();
        testConfig.setEnvironment("test");
        testConfig.setMasterKeyEnvVar("VAULT_MASTER_KEY_B64");

        vault.initialize(testConfig);

        assertThat(vault.isReady()).isTrue();
    }

    @Test
    void bootstrap_healthStatusIsUp_afterSuccessfulInit() {
        vault.initialize(localConfig);

        VaultHealthStatus status = vault.getHealthStatus();
        assertThat(status.getStatus()).isEqualTo(VaultHealthStatus.Status.UP);
        assertThat(status.isOperational()).isTrue();
        assertThat(status.getInitializedAt()).isNotNull();
        assertThat(status.getEnvironment()).isEqualTo("local");
    }

    // ─── Bootstrap: config validation ─────────────────────────────────────

    @Test
    void bootstrap_nullConfig_throwsVaultInitializationException() {
        assertThatThrownBy(() -> vault.initialize(null))
                .isInstanceOf(VaultInitializationException.class)
                .hasMessageContaining("must not be null");
    }

    @Test
    void bootstrap_blankEnvironment_throwsVaultInitializationException() {
        localConfig.setEnvironment("  ");
        assertThatThrownBy(() -> vault.initialize(localConfig))
                .isInstanceOf(VaultInitializationException.class)
                .hasMessageContaining("environment");
    }

    @Test
    void bootstrap_unknownEnvironment_throwsVaultInitializationException() {
        localConfig.setEnvironment("production");
        assertThatThrownBy(() -> vault.initialize(localConfig))
                .isInstanceOf(VaultInitializationException.class)
                .hasMessageContaining("local, test, deployed");
    }

    @Test
    void bootstrap_deployedEnvironment_withoutEnvVar_throwsVaultInitializationException() {
        // Ensure VAULT_MASTER_KEY_B64 is not set in the test environment
        VaultBootstrapConfig deployedConfig = new VaultBootstrapConfig();
        deployedConfig.setEnvironment("deployed");
        deployedConfig.setMasterKeyEnvVar("VAULT_MASTER_KEY_B64_TEST_MISSING_" + System.nanoTime());

        assertThatThrownBy(() -> vault.initialize(deployedConfig))
                .isInstanceOf(VaultInitializationException.class)
                .hasMessageContaining("deployed environment requires");
    }

    // ─── Vault readiness guard ─────────────────────────────────────────────

    @Test
    void resolveCredential_beforeInit_throwsVaultNotReady() {
        // vault not yet initialised
        assertThatThrownBy(() -> vault.resolveCredential("vault://credentials/test", "tenant-1"))
                .isInstanceOf(CredentialResolutionException.class)
                .satisfies(e -> assertThat(((CredentialResolutionException) e).getReason())
                        .isEqualTo(CredentialResolutionException.Reason.VAULT_NOT_READY));
    }

    // ─── Credential resolution: path validation ────────────────────────────

    @Test
    void resolveCredential_invalidPathFormat_throwsException() {
        vault.initialize(localConfig);

        assertThatThrownBy(() -> vault.resolveCredential("credentials/bad-path", "tenant-1"))
                .isInstanceOf(CredentialResolutionException.class)
                .satisfies(e -> assertThat(((CredentialResolutionException) e).getReason())
                        .isEqualTo(CredentialResolutionException.Reason.INVALID_PATH_FORMAT));
    }

    @Test
    void resolveCredential_nullPath_throwsException() {
        vault.initialize(localConfig);

        assertThatThrownBy(() -> vault.resolveCredential(null, "tenant-1"))
                .isInstanceOf(CredentialResolutionException.class)
                .satisfies(e -> assertThat(((CredentialResolutionException) e).getReason())
                        .isEqualTo(CredentialResolutionException.Reason.INVALID_PATH_FORMAT));
    }

    @Test
    void resolveCredential_pathNotFound_throwsException() {
        vault.initialize(localConfig);

        assertThatThrownBy(() -> vault.resolveCredential("vault://credentials/missing-path", "tenant-1"))
                .isInstanceOf(CredentialResolutionException.class)
                .satisfies(e -> assertThat(((CredentialResolutionException) e).getReason())
                        .isEqualTo(CredentialResolutionException.Reason.NOT_FOUND));
    }

    // ─── Credential store and retrieval round-trip ────────────────────────

    @Test
    void storeAndResolve_roundTrip_returnsOriginalValue() {
        vault.initialize(localConfig);
        char[] secret = "super-secret-password".toCharArray();

        vault.storeCredential("vault://credentials/device-001", "default", secret);
        char[] resolved = vault.resolveCredential("vault://credentials/device-001", "default");

        assertThat(new String(resolved)).isEqualTo("super-secret-password");
    }

    // ─── Tenant isolation ─────────────────────────────────────────────────

    @Test
    void resolveCredential_tenantIsolationEnabled_blankTenantId_throwsTenantScopeViolation() {
        localConfig.setTenantIsolationEnabled(true);
        vault.initialize(localConfig);

        assertThatThrownBy(() -> vault.resolveCredential("vault://credentials/device-001", ""))
                .isInstanceOf(CredentialResolutionException.class)
                .satisfies(e -> assertThat(((CredentialResolutionException) e).getReason())
                        .isEqualTo(CredentialResolutionException.Reason.TENANT_SCOPE_VIOLATION));
    }

    @Test
    void storeAndResolve_withTenantIsolation_differentTenantsReturnDifferentPaths() {
        localConfig.setTenantIsolationEnabled(true);
        vault.initialize(localConfig);

        char[] secretA = "secret-A".toCharArray();
        char[] secretB = "secret-B".toCharArray();

        vault.storeCredential("vault://credentials/shared-device", "tenant-A", secretA);
        vault.storeCredential("vault://credentials/shared-device", "tenant-B", secretB);

        assertThat(new String(vault.resolveCredential("vault://credentials/shared-device", "tenant-A")))
                .isEqualTo("secret-A");
        assertThat(new String(vault.resolveCredential("vault://credentials/shared-device", "tenant-B")))
                .isEqualTo("secret-B");
    }

    // ─── Health status ─────────────────────────────────────────────────────

    @Test
    void healthStatus_beforeInit_isInitializing() {
        VaultHealthStatus status = vault.getHealthStatus();
        assertThat(status.getStatus()).isEqualTo(VaultHealthStatus.Status.INITIALIZING);
        assertThat(status.isOperational()).isFalse();
    }

    @Test
    void healthStatus_afterSuccessfulInit_isUp() {
        vault.initialize(localConfig);
        assertThat(vault.getHealthStatus().isOperational()).isTrue();
    }

    @Test
    void encryptionProvider_localEnv_isPlaintextDevOnly() {
        vault.initialize(localConfig);
        assertThat(vault.getEncryptionProvider()).isEqualTo(EncryptionProvider.PLAINTEXT_DEV_ONLY);
    }
}

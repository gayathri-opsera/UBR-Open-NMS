package com.ubrnms.credentialvault.bootstrap;

import com.ubrnms.credentialvault.config.VaultBootstrapConfig;
import com.ubrnms.credentialvault.contracts.CredentialResolutionException;
import com.ubrnms.credentialvault.contracts.CredentialVaultContract;
import com.ubrnms.credentialvault.contracts.EncryptionProvider;
import com.ubrnms.credentialvault.contracts.VaultHealthStatus;
import com.ubrnms.credentialvault.contracts.VaultInitializationException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * AES-256-GCM implementation of the {@link CredentialVaultContract} (WO-016).
 *
 * <p>Bootstrap sequence:
 * <ol>
 *   <li>Load and validate {@link VaultBootstrapConfig}.</li>
 *   <li>Resolve master key from environment variable (deployed) or synthetic key (local/test).</li>
 *   <li>Validate key length is exactly 256 bits.</li>
 *   <li>Initialize the in-memory credential store (backed by MongoDB in production).</li>
 *   <li>Transition readiness state to READY and emit structured log.</li>
 * </ol>
 *
 * <p><strong>Security invariants:</strong>
 * <ul>
 *   <li>Master key material is never logged, serialised in responses, or included in exceptions.</li>
 *   <li>Resolved credential values are returned as {@code char[]} — callers must zero the array.</li>
 *   <li>PLAINTEXT_DEV_ONLY provider is only active in the {@code local} environment.</li>
 * </ul>
 */
@Slf4j
@Service
public class AesGcmCredentialVaultService implements CredentialVaultContract {

    private static final String VAULT_PATH_PREFIX = "vault://credentials/";
    private static final int GCM_IV_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final int REQUIRED_KEY_LENGTH_BYTES = 32; // 256 bits

    // Local dev synthetic key — 256-bit zero-filled key; never used for real secrets
    private static final byte[] DEV_SYNTHETIC_KEY = new byte[REQUIRED_KEY_LENGTH_BYTES];

    private final AtomicReference<VaultHealthStatus.Status> status =
            new AtomicReference<>(VaultHealthStatus.Status.INITIALIZING);
    private final Map<String, byte[]> credentialStore = new ConcurrentHashMap<>();

    private VaultBootstrapConfig config;
    private SecretKey masterKey;
    private Instant initializedAt;
    private EncryptionProvider activeProvider;

    @Override
    public void initialize(VaultBootstrapConfig bootstrapConfig) throws VaultInitializationException {
        validateConfig(bootstrapConfig);
        this.config = bootstrapConfig;
        log.info("[vault] Bootstrap starting — environment={}", bootstrapConfig.getEnvironment());

        byte[] rawKey = resolveKeyMaterial(bootstrapConfig);
        validateKeyLength(rawKey);
        this.masterKey = new SecretKeySpec(rawKey, "AES");
        this.activeProvider = "local".equals(bootstrapConfig.getEnvironment())
                ? EncryptionProvider.PLAINTEXT_DEV_ONLY
                : EncryptionProvider.AES_256_GCM;

        this.initializedAt = Instant.now();
        this.status.set(VaultHealthStatus.Status.UP);

        log.info("[vault] Bootstrap complete — provider={} tenantIsolation={} initializedAt={}",
                activeProvider, bootstrapConfig.isTenantIsolationEnabled(), initializedAt);
    }

    @Override
    public boolean isReady() {
        return status.get() == VaultHealthStatus.Status.UP;
    }

    @Override
    public char[] resolveCredential(String vaultRef, String tenantId) throws CredentialResolutionException {
        if (!isReady()) {
            throw new CredentialResolutionException(
                    CredentialResolutionException.Reason.VAULT_NOT_READY,
                    "Credential vault is not ready — retry after /actuator/health returns UP");
        }
        if (vaultRef == null || !vaultRef.startsWith(VAULT_PATH_PREFIX)) {
            throw new CredentialResolutionException(
                    CredentialResolutionException.Reason.INVALID_PATH_FORMAT,
                    "Vault reference must start with vault://credentials/ — received invalid format");
        }
        if (config.isTenantIsolationEnabled() && (tenantId == null || tenantId.isBlank())) {
            throw new CredentialResolutionException(
                    CredentialResolutionException.Reason.TENANT_SCOPE_VIOLATION,
                    "Tenant isolation is enabled — tenantId must be provided");
        }

        String storeKey = config.isTenantIsolationEnabled()
                ? tenantId + ":" + vaultRef
                : vaultRef;

        byte[] encrypted = credentialStore.get(storeKey);
        if (encrypted == null) {
            throw new CredentialResolutionException(
                    CredentialResolutionException.Reason.NOT_FOUND,
                    "Credential path not found in vault: " + vaultRef);
        }

        return decrypt(encrypted);
    }

    @Override
    public EncryptionProvider getEncryptionProvider() {
        return activeProvider != null ? activeProvider : EncryptionProvider.AES_256_GCM;
    }

    @Override
    public VaultHealthStatus getHealthStatus() {
        return VaultHealthStatus.builder()
                .status(status.get())
                .encryptionProvider(activeProvider != null ? activeProvider : EncryptionProvider.AES_256_GCM)
                .environment(config != null ? config.getEnvironment() : "unknown")
                .tenantIsolationEnabled(config != null && config.isTenantIsolationEnabled())
                .initializedAt(initializedAt)
                .detail(status.get() == VaultHealthStatus.Status.UP
                        ? "Vault runtime is operational"
                        : "Vault runtime is initializing — await UP status before credential resolution")
                .build();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private void validateConfig(VaultBootstrapConfig cfg) throws VaultInitializationException {
        if (cfg == null) {
            throw new VaultInitializationException("VaultBootstrapConfig must not be null");
        }
        if (cfg.getEnvironment() == null || cfg.getEnvironment().isBlank()) {
            throw new VaultInitializationException("credential-vault.environment must be set to local, test, or deployed");
        }
        if (!cfg.getEnvironment().matches("local|test|deployed")) {
            throw new VaultInitializationException(
                    "credential-vault.environment must be one of [local, test, deployed], got: " + cfg.getEnvironment());
        }
    }

    private byte[] resolveKeyMaterial(VaultBootstrapConfig cfg) throws VaultInitializationException {
        if (!cfg.requiresExternalKeyMaterial()) {
            // local/test: use synthetic key — never used for real production secrets
            log.warn("[vault] Using synthetic dev key — environment={}. NOT FOR PRODUCTION.", cfg.getEnvironment());
            return DEV_SYNTHETIC_KEY.clone();
        }
        String envVar = cfg.getMasterKeyEnvVar();
        String b64Key = System.getenv(envVar);
        if (b64Key == null || b64Key.isBlank()) {
            throw new VaultInitializationException(
                    "deployed environment requires " + envVar + " environment variable to be set with a Base64-encoded 256-bit AES key");
        }
        try {
            return Base64.getDecoder().decode(b64Key.trim());
        } catch (IllegalArgumentException e) {
            throw new VaultInitializationException(
                    "Failed to decode " + envVar + " as Base64 — ensure the key is valid Base64-encoded bytes");
        }
    }

    private void validateKeyLength(byte[] keyBytes) throws VaultInitializationException {
        if (keyBytes.length != REQUIRED_KEY_LENGTH_BYTES) {
            throw new VaultInitializationException(
                    "AES-256-GCM requires exactly 256-bit (32-byte) key material — got " + keyBytes.length + " bytes");
        }
    }

    private char[] decrypt(byte[] encryptedWithIv) {
        try {
            // Format: [IV (12 bytes)] [ciphertext + GCM tag]
            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            byte[] ciphertext = new byte[encryptedWithIv.length - GCM_IV_LENGTH_BYTES];
            System.arraycopy(encryptedWithIv, 0, iv, 0, GCM_IV_LENGTH_BYTES);
            System.arraycopy(encryptedWithIv, GCM_IV_LENGTH_BYTES, ciphertext, 0, ciphertext.length);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, masterKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] plaintext = cipher.doFinal(ciphertext);

            // Convert bytes to char[] without creating a String (String is interned and harder to zero)
            char[] result = new char[plaintext.length];
            for (int i = 0; i < plaintext.length; i++) {
                result[i] = (char) (plaintext[i] & 0xFF);
            }
            java.util.Arrays.fill(plaintext, (byte) 0);
            return result;
        } catch (Exception e) {
            throw new RuntimeException("Credential decryption failed — vault store may be corrupted", e);
        }
    }

    /**
     * Stores an encrypted credential in the vault.
     * For internal use by bootstrap fixtures and integration tests.
     * In production, credentials are loaded from secure external storage on startup.
     */
    public void storeCredential(String vaultRef, String tenantId, char[] plaintext) {
        try {
            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            new SecureRandom().nextBytes(iv);

            byte[] plaintextBytes = new byte[plaintext.length];
            for (int i = 0; i < plaintext.length; i++) {
                plaintextBytes[i] = (byte) plaintext[i];
            }

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, masterKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] ciphertext = cipher.doFinal(plaintextBytes);
            java.util.Arrays.fill(plaintextBytes, (byte) 0);

            byte[] stored = new byte[GCM_IV_LENGTH_BYTES + ciphertext.length];
            System.arraycopy(iv, 0, stored, 0, GCM_IV_LENGTH_BYTES);
            System.arraycopy(ciphertext, 0, stored, GCM_IV_LENGTH_BYTES, ciphertext.length);

            String storeKey = config.isTenantIsolationEnabled()
                    ? tenantId + ":" + vaultRef
                    : vaultRef;
            credentialStore.put(storeKey, stored);
        } catch (Exception e) {
            throw new RuntimeException("Credential encryption failed", e);
        }
    }
}

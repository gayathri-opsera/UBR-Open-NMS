package com.ubrnms.credentialvault.contracts;

/**
 * Supported encryption providers for the credential vault runtime (WO-016).
 *
 * <p>The default and required provider for production is {@code AES_256_GCM}.
 * Other providers may exist for migration or legacy compatibility but must not
 * be used for new credential storage.
 */
public enum EncryptionProvider {

    /**
     * AES-256-GCM authenticated encryption. Required for production deployments.
     * Provides both confidentiality and integrity protection for stored credentials.
     */
    AES_256_GCM,

    /**
     * No-op provider used only in local development environments where key material
     * is not available. Must never be enabled in {@code test} or {@code deployed} environments.
     */
    PLAINTEXT_DEV_ONLY
}

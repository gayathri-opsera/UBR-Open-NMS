package com.ubrnms.credentialvault.contracts;

/**
 * Thrown when the credential vault runtime fails to initialise (WO-016).
 *
 * <p>Causes include: missing master key material in {@code deployed} environment,
 * invalid Base64-encoded key, key length not 256 bits, or configuration validation failure.
 *
 * <p>The exception message must never include the actual key material.
 */
public class VaultInitializationException extends RuntimeException {

    public VaultInitializationException(String message) {
        super(message);
    }

    public VaultInitializationException(String message, Throwable cause) {
        super(message, cause);
    }
}

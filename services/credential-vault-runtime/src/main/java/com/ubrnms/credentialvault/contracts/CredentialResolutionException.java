package com.ubrnms.credentialvault.contracts;

/**
 * Thrown when a credential vault reference cannot be resolved (WO-016).
 *
 * <p>Common causes: path not found, tenant scope mismatch, vault not ready,
 * or invalid vault reference format (not starting with {@code vault://}).
 */
public class CredentialResolutionException extends RuntimeException {

    public enum Reason { NOT_FOUND, VAULT_NOT_READY, INVALID_PATH_FORMAT, TENANT_SCOPE_VIOLATION }

    private final Reason reason;

    public CredentialResolutionException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason getReason() {
        return reason;
    }
}

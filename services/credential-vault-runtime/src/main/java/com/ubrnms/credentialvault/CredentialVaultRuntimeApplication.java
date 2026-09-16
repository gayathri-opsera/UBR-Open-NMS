package com.ubrnms.credentialvault;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Framework Credential Vault Runtime — WO-016.
 *
 * <p>Bootstraps the AES-256-GCM credential vault, validates runtime contracts,
 * and exposes readiness and health signals for dependent services. Runs on port 8094.
 *
 * <p>Dependent services (WO-005, WO-020, WO-021) must check
 * {@code CredentialVaultContract.isReady()} before calling any credential operations.
 * If not ready, they must return SERVICE_UNAVAILABLE with error code VAULT_NOT_READY.
 */
@SpringBootApplication
public class CredentialVaultRuntimeApplication {

    public static void main(String[] args) {
        SpringApplication.run(CredentialVaultRuntimeApplication.class, args);
    }
}

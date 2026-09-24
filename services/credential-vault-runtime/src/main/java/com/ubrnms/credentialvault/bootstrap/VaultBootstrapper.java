package com.ubrnms.credentialvault.bootstrap;

import com.ubrnms.credentialvault.config.VaultBootstrapConfig;
import com.ubrnms.credentialvault.contracts.CredentialVaultContract;
import com.ubrnms.credentialvault.contracts.VaultInitializationException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Triggers the credential vault bootstrap sequence after Spring context is ready (WO-016).
 *
 * <p>Bootstrap sequence:
 * <ol>
 *   <li>Configuration loaded and validated by {@link VaultBootstrapConfig}.</li>
 *   <li>{@link CredentialVaultContract#initialize(VaultBootstrapConfig)} called.</li>
 *   <li>Health indicator transitions from INITIALIZING to UP (or DOWN on failure).</li>
 * </ol>
 *
 * <p>On failure, the application logs a FATAL-level message and allows the JVM to start
 * so that the {@code /actuator/health} endpoint can report the failure to orchestrators
 * (Kubernetes readiness probe, load balancer health checks).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class VaultBootstrapper {

    private final CredentialVaultContract vault;
    private final VaultBootstrapConfig config;

    @EventListener(ApplicationReadyEvent.class)
    public void bootstrap() {
        log.info("[vault-bootstrap] Starting credential vault runtime bootstrap — environment={}",
                config.getEnvironment());
        try {
            vault.initialize(config);
            log.info("[vault-bootstrap] Credential vault runtime is UP — provider={} ready={}",
                    vault.getEncryptionProvider(), vault.isReady());
        } catch (VaultInitializationException e) {
            log.error("[vault-bootstrap] FATAL: Credential vault initialization failed — service will report DOWN in health check. Reason: {}",
                    e.getMessage());
            // Do not re-throw: allow actuator health to report DOWN rather than killing the pod.
            // The readiness probe will prevent traffic until the issue is resolved.
        }
    }
}

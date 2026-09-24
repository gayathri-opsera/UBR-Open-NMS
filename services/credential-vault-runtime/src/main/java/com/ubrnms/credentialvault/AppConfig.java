package com.ubrnms.credentialvault;

import com.ubrnms.credentialvault.bootstrap.AesGcmCredentialVaultService;
import com.ubrnms.credentialvault.config.VaultBootstrapConfig;
import com.ubrnms.credentialvault.contracts.CredentialVaultContract;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Spring configuration — wires the vault contract to its AES-256-GCM implementation (WO-016).
 */
@Configuration
@EnableConfigurationProperties(VaultBootstrapConfig.class)
public class AppConfig {

    @Bean
    public CredentialVaultContract credentialVaultContract(AesGcmCredentialVaultService service) {
        return service;
    }
}

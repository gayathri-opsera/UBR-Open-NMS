# Framework Credential Vault Runtime — Bootstrap Sequence (WO-016)

## Overview

The Framework Credential Vault Runtime provides AES-256-GCM encryption for credential
references used by Product Definition protocol adapters. Dependent services bind to the
`CredentialVaultContract` interface and check readiness before every credential operation.

## Service Details

| Property | Value |
|----------|-------|
| Port | 8094 |
| Technology | Java 17, Spring Boot 3.4 |
| Encryption | AES-256-GCM (256-bit key, 12-byte IV, 128-bit tag) |
| Storage | In-memory (dev), MongoDB `credential_store` (production) |
| Health endpoint | `/actuator/health/credentialVault` |

## Bootstrap Sequence

```
1. Spring context initialises — AppConfig wires AesGcmCredentialVaultService as CredentialVaultContract
2. VaultBootstrapConfig loaded from application.yml + environment variables
3. VaultBootstrapper.bootstrap() fires on ApplicationReadyEvent
4. AesGcmCredentialVaultService.initialize(config):
   a. Validates config (environment must be local|test|deployed)
   b. Resolves key material:
      - local/test: synthetic 256-bit zero key (NEVER for production secrets)
      - deployed: reads VAULT_MASTER_KEY_B64 env var, decodes Base64, validates 32 bytes
   c. Initialises SecretKeySpec for AES/GCM/NoPadding
   d. Sets status to UP
   e. Emits structured INFO log: provider, environment, tenantIsolation, initializedAt
5. /actuator/health/credentialVault returns UP — Kubernetes readiness probe passes
6. Dependent services may now call resolveCredential()
```

## Environment Configuration

| Environment | Key Source | Notes |
|-------------|-----------|-------|
| `local` | Synthetic zero-key | Safe for development only. Credentials stored here have no security. |
| `test` | Synthetic zero-key | Used in CI pipelines. Test credentials are ephemeral. |
| `deployed` | `VAULT_MASTER_KEY_B64` env var | **Required.** Must be a 256-bit (32-byte) AES key, Base64-encoded. |

### Generating a Production Key

```bash
# Generate a 256-bit random key and base64-encode it
openssl rand -base64 32
# Output example: 5J+DFh9qHy3G8bXmK2L7nP0Q4rVwYz6...
# Set as: VAULT_MASTER_KEY_B64=<output>
```

**Never commit VAULT_MASTER_KEY_B64 to version control.** Use a secrets manager (Vault,
AWS Secrets Manager, Kubernetes Secrets with encryption at rest).

## Credential Path Format

All credential references use the format: `vault://credentials/{path}`

Examples:
- `vault://credentials/device-001/snmp-community`
- `vault://credentials/tenant-A/cisco-asr-credentials`

The `{path}` component is arbitrary but must:
- Not contain URL fragments (`#`) or query strings (`?`)
- Be within the configured `maxCredentialPathLength` (default: 512 characters)

## Integration for Dependent Services

Dependent services (WO-005 credential protection, WO-020 audit, WO-021 publish gates)
must use the `CredentialVaultContract` interface — never call `AesGcmCredentialVaultService` directly.

```java
@Service
public class MyService {
    private final CredentialVaultContract vault;

    public void doSomethingWithCredential(String vaultRef, String tenantId) {
        if (!vault.isReady()) {
            throw new ServiceUnavailableException("VAULT_NOT_READY",
                "Credential vault is not ready — retry after health check shows UP");
        }
        char[] secret = vault.resolveCredential(vaultRef, tenantId);
        try {
            // use secret
        } finally {
            Arrays.fill(secret, '\0'); // zero the char array immediately after use
        }
    }
}
```

## Health Signals

| State | HTTP Status | Meaning |
|-------|------------|---------|
| `INITIALIZING` | 503 | Bootstrap in progress — readiness probe will fail |
| `UP` | 200 | Vault is fully operational |
| `DEGRADED` | 200 with warnings | Vault is operational but non-critical checks failed |
| `DOWN` | 503 | Vault initialization failed — check logs for root cause |

## Security Invariants

1. **No key material in logs.** The AES master key is never logged, even at DEBUG level.
2. **No credential values in responses.** The health endpoint and all APIs never return raw credentials.
3. **char[] not String for resolved values.** Callers receive `char[]` to enable zeroing after use.
4. **AES_256_GCM required in production.** PLAINTEXT_DEV_ONLY is only active in `local` environment.
5. **Tenant isolation.** When `tenantIsolationEnabled=true`, cross-tenant credential access throws `TENANT_SCOPE_VIOLATION`.

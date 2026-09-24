# Product Definition Control Plane

This document describes the architecture, components, contracts, and integration
guidance for the Product Definition Control Plane in UBR NMS.

## Overview

The Product Definition Control Plane is the authoritative source for vendor product
model definitions. It controls the full lifecycle from upload through validation,
activation, registry rebuild, and rollback. No discovery, inventory, configuration,
or adaptive UI component may assume product model information without reading from
the Control Plane's published registry output.

## Components

| Component | Service | Responsibility |
|-----------|---------|---------------|
| Upload & Validation | `product-definition-service` | Accept XML/XLS/JSON, reject untrusted input, persist validation reports |
| Version Store | `product-definition-service` (MongoDB) | Immutable version records for all uploaded definitions |
| State Machine | `product-definition-service` | Single authority for lifecycle transitions; emits Kafka events |
| Registry Rebuild Worker | `product-definition-service` | Rebuilds fingerprint, parameter, and adaptive UI registries on PUBLISHED transition |
| Credential Vault Runtime | `credential-vault-runtime` | Bootstraps AES-256-GCM vault, validates credential contracts, exposes readiness |
| API Gateway Routes | `api-gateway` | JWT/RBAC enforcement, multipart forwarding, correlation ID propagation |
| Audit Service | `audit-service` | Consumes lifecycle events, stores immutable audit records |
| Kafka Bus | `product-definition.lifecycle` topic | Decoupled event fan-out for all lifecycle transitions |

## Credential Vault Runtime Contract (WO-016)

### Purpose
The Framework Credential Vault Runtime provides the encryption backend used by:
- Product Definition credential reference validation (ensuring no inline secrets)
- Parameter Store credential resolution at poll time
- Configuration push credential binding

### Bootstrap Sequence
```
1. Load environment-specific configuration (local / test / deployed)
2. Validate configuration — fail fast if required fields are missing
3. Initialize vault provider (AES-256-GCM key material loading)
4. Register tenant scope bindings
5. Expose readiness via /actuator/health
6. Begin accepting credential resolution requests
```

### Contract Interface
```java
interface CredentialVaultContract {
    void initialize(VaultBootstrapConfig config) throws VaultInitializationException;
    boolean isReady();
    String resolveCredential(String vaultRef, String tenantId) throws CredentialResolutionException;
    EncryptionProvider getEncryptionProvider();
    VaultHealthStatus getHealthStatus();
}
```

### Product Definition Runtime Requirements
When a Product Definition declares credential references, it must include a
`credentialRuntimeRequirements` section in the control plane contract:

```json
{
  "credentialRuntimeRequirements": {
    "vaultProvider": "AES_256_GCM",
    "tenantScoped": true,
    "requiredSecretPaths": ["vault://credentials/{deviceId}"],
    "encryptionAtRest": true,
    "keyRotationPolicy": "ANNUAL"
  }
}
```

Validation fails with `MISSING_CREDENTIAL_RUNTIME_CONTRACT` if this section is absent
when protocol mappings reference credential vault paths.

### Integration for Dependent Services
Dependent services (WO-005 credential protection, WO-020 audit lineage, WO-021 publish gates)
must **not** assume a vault service exists — they must call `CredentialVaultContract.isReady()`
before any credential operation. If not ready, operations must be deferred or fail with
`SERVICE_UNAVAILABLE` and error code `VAULT_NOT_READY`.

## Expanded Control Plane Schema

The Product Definition control plane schema (added by WO-016) extends the core upload
model with the following top-level sections:

| Section | Required | Description |
|---------|----------|-------------|
| `identity` | Yes | Vendor, model, firmware range |
| `fingerprints` | Yes | OID/CLI/REST fingerprint rules |
| `protocols` | Yes | SNMP/CLI/REST/gRPC protocol mappings |
| `parameters` | Yes | Parameter groups, types, thresholds |
| `credentialRuntimeRequirements` | Conditional | Required when any protocol mapping uses credential vault references |
| `integrationDependencies` | No | External services this definition requires at runtime |
| `tenantIsolation` | No | Tenant-specific scope overrides |
| `lifecycleHooks` | No | Callbacks on PUBLISHED/DEPRECATED/ARCHIVED transitions |
| `validationRules` | No | Custom semantic validation rules beyond the default set |

## Kafka Event Bus Contract

All lifecycle events conform to the schema defined in WO-018.
Topic: `product-definition.lifecycle`
Key: `{definitionId}` (preserves per-definition ordering)
DLQ: `product-definition.lifecycle.dlq`

See [Kafka Schema Reference](../shared-libs/json-schemas/kafka/README.md) for
JSON Schema definitions of each event type.

## Registry Rebuild

On `APPROVED → PUBLISHED` transition, the registry rebuild worker:
1. Reads the validated + approved `NormalizedProductDefinition` from the version store.
2. Writes fingerprint rules to the Fingerprint Registry (MongoDB collection `fingerprint_registry`).
3. Writes parameter definitions to the Parameter Registry (MongoDB collection `parameter_registry`).
4. Writes adaptive UI cache entries to the Adaptive UI Cache (MongoDB collection `adaptive_ui_cache`).
5. Emits `product_definition.published` event to Kafka.

Registry rebuild is **idempotent** — re-running for the same version produces identical output.

## Security Constraints

1. No credential material may appear in Product Definition files, validation reports, audit records, or Kafka events.
2. Credential references use vault paths only: `vault://credentials/{deviceId}`.
3. The product-definition-service does not store or log uploaded file content after parsing.
4. All API access requires a valid JWT with Admin or SuperAdmin role.
5. The credential vault runtime enforces tenant isolation — a tenant may not resolve credentials belonging to another tenant.

## Integration Guidance for Dependent Work Orders

| WO | Integration Point | What to Bind To |
|----|------------------|----------------|
| WO-004 | Gateway Authorization | `frameworkProductDefinitions.js` route middleware |
| WO-005 | Credential Protection | `CredentialVaultContract` interface from WO-016 |
| WO-006 | Parameter Visibility | Parameter Registry output from Product Definition registry rebuild |
| WO-007 | Read-Only Framework APIs | Version store + Parameter Registry produced by WO-002 |
| WO-008 | Discovery Probes | Fingerprint Registry produced after WO-002 activated |
| WO-019 | State Machine | `ProductDefinitionStateMachine` in product-definition-service |
| WO-020 | Audit Lineage | Audit Service Kafka consumer on `product-definition.lifecycle` |
| WO-021 | Publish Gates | `PublishValidationGateService` using WO-016 vault readiness + WO-019 state |
| WO-022 | Idempotency | `idempotencyKey` in lifecycle command payloads |

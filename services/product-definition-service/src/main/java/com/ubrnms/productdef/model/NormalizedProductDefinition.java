package com.ubrnms.productdef.model;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * Canonical in-memory representation of a Product Definition after any of the
 * three supported parsers (XML, XLS, JSON) has read the uploaded file.
 *
 * <p>All three parsers produce this DTO so the semantic validation service and
 * future lifecycle / registry components can work against a single model
 * regardless of the original upload format.
 *
 * <p><b>Credential policy:</b> this DTO must never contain credential values,
 * community strings, private keys, or passphrases.  The parsers are responsible
 * for rejecting any upload that contains such material before constructing this DTO.
 */
@Data
@Builder
public class NormalizedProductDefinition {

    // ── Identity ─────────────────────────────────────────────────────────────

    private String name;
    private String vendor;
    private String model;
    private String firmwareFrom;
    private String firmwareTo;
    private String productFamily;

    // ── Fingerprints ─────────────────────────────────────────────────────────

    private List<FingerprintEntry> fingerprints;

    // ── Protocols ────────────────────────────────────────────────────────────

    /** Supported protocol types: SNMP, CLI, REST, GRPC */
    private List<String> supportedProtocols;

    // ── Parameter groups ─────────────────────────────────────────────────────

    private List<ParameterGroup> parameterGroups;

    // ── Credential runtime requirements (WO-016) ──────────────────────────────

    /**
     * Declares the credential vault runtime contract required by this definition.
     * Mandatory when any protocol mapping uses vault:// credential references.
     * Validated by ProductDefinitionValidationService before SUBMITTED→APPROVED transition.
     */
    private CredentialRuntimeRequirements credentialRuntimeRequirements;

    // ── Integration dependencies (WO-016) ─────────────────────────────────────

    /**
     * External services this definition depends on at runtime (e.g. NTP, RADIUS).
     * Informational — does not block validation but is included in the published registry.
     */
    private List<String> integrationDependencies;

    // ── Tenant isolation (WO-016) ─────────────────────────────────────────────

    /**
     * Tenant-specific scope overrides. When set, this definition is scoped to the
     * listed tenant IDs only. Null means the definition is available to all tenants.
     */
    private List<String> tenantScopeIds;

    // ── Lifecycle hooks (WO-016) ──────────────────────────────────────────────

    /**
     * Optional callback configurations for lifecycle state transitions.
     * Keys are lifecycle state values (PUBLISHED, DEPRECATED, ARCHIVED).
     */
    private java.util.Map<String, String> lifecycleHooks;

    // ── Inner types ───────────────────────────────────────────────────────────

    /**
     * Credential vault runtime contract fields declared within a Product Definition (WO-016).
     * Required when any protocol mapping references vault:// credential paths.
     */
    @Data
    @Builder
    public static class CredentialRuntimeRequirements {
        /** Required vault provider. Must be AES_256_GCM for production. */
        private String vaultProvider;
        /** Whether credentials must be resolved with tenant-scoped vault paths. */
        private boolean tenantScoped;
        /** Vault path templates this definition's adapters will resolve at runtime. */
        private List<String> requiredSecretPaths;
        /** Whether credentials must be encrypted at rest in the vault. */
        private boolean encryptionAtRest;
        /** Key rotation policy — e.g. ANNUAL, QUARTERLY. */
        private String keyRotationPolicy;
    }

    @Data
    @Builder
    public static class FingerprintEntry {
        /** Dotted-numeric OID — mandatory. */
        private String sysObjectId;
        /** Optional regex pattern matched against sysDescr. */
        private String sysDescrPattern;
        /** Optional firmware range lower bound for this fingerprint. */
        private String firmwareFrom;
        /** Optional firmware range upper bound for this fingerprint. */
        private String firmwareTo;
    }

    @Data
    @Builder
    public static class ParameterGroup {
        private String groupName;
        private List<ParameterEntry> parameters;
    }

    @Data
    @Builder
    public static class ParameterEntry {
        /** Stable parameter identifier — alphanumeric, hyphens, underscores. */
        private String id;
        private String displayName;
        /** One of: NUMERIC, STRING, ENUM, BOOLEAN */
        private String dataType;
        private String unit;
        private String defaultValue;
        /** Inclusive lower bound for NUMERIC parameters. */
        private Double minValue;
        /** Inclusive upper bound for NUMERIC parameters. */
        private Double maxValue;
        /** Allowed values for ENUM parameters — must be non-empty and free of duplicates. */
        private List<String> enumValues;

        // Protocol-specific read mappings — only the relevant field is populated

        /** SNMP OID string (dotted-numeric, e.g. 1.3.6.1.4.1.9.2.1.56.0) */
        private String snmpOid;
        /** CLI command template. Must be allow-listed and shell-safe. */
        private String cliCommand;
        /** Regex to extract the parameter value from CLI command output. */
        private String cliParseRegex;
        /** REST API path (e.g. /api/v1/system/cpu). Required for REST mappings. */
        private String apiPath;
        /** gRPC field path. Required for GRPC mappings. */
        private String grpcPath;

        /** Roles that may view this parameter in the adaptive UI. */
        private List<String> uiVisibleTo;
        /** Optional high-threshold string (numeric or percentage). */
        private String thresholdHigh;
        /** Optional low-threshold string. */
        private String thresholdLow;
    }
}

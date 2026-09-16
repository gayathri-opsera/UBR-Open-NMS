package com.ubrnms.productdef;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationReport;
import com.ubrnms.productdef.validation.ProductDefinitionValidationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.*;

class ProductDefinitionValidationServiceTest {

    private ProductDefinitionValidationService service;

    @BeforeEach
    void setUp() {
        service = new ProductDefinitionValidationService();
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void validate_completeDefinition_returnsValid() {
        NormalizedProductDefinition def = buildValid();
        ValidationReport report = service.validate(def, "cisco-asr", "v1", "corr-1");

        assertThat(report.getStatus()).isEqualTo("VALID");
        assertThat(report.getErrors()).isEmpty();
        assertThat(report.getParameterCount()).isEqualTo(1);
        assertThat(report.getFingerprintCount()).isEqualTo(1);
        assertThat(report.getProtocolCount()).isEqualTo(1);
    }

    @Test
    void validate_normalizedSummary_containsVendorAndModel() {
        NormalizedProductDefinition def = buildValid();
        ValidationReport report = service.validate(def, "cisco-asr", "v1", "corr-1");
        assertThat(report.getNormalizedSummary()).contains("Cisco").contains("ASR-1001");
    }

    // ── Identity validation ───────────────────────────────────────────────────

    @Test
    void validate_missingName_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.setName(null);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getStatus()).isEqualTo("INVALID");
        assertThat(report.getErrors()).anyMatch(e -> "REQUIRED_FIELD".equals(e.getCode())
                && e.getField().contains("name"));
    }

    @Test
    void validate_missingVendor_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.setVendor(null);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> e.getField().contains("vendor"));
    }

    @Test
    void validate_missingModel_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.setModel(null);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> e.getField().contains("model"));
    }

    @Test
    void validate_firmwareRangeReversed_producesWarning() {
        NormalizedProductDefinition def = buildValid();
        def.setFirmwareFrom("17.0");
        def.setFirmwareTo("16.0");  // earlier version listed as 'to'
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getWarnings()).anyMatch(e -> "FIRMWARE_RANGE".equals(e.getCode()));
    }

    // ── Fingerprint validation ────────────────────────────────────────────────

    @Test
    void validate_invalidOidInFingerprint_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getFingerprints().get(0).setSysObjectId("not-an-oid");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getStatus()).isEqualTo("INVALID");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_OID".equals(e.getCode()));
    }

    @Test
    void validate_noFingerprints_warningOnly() {
        NormalizedProductDefinition def = buildValid();
        def.setFingerprints(List.of());
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getStatus()).isEqualTo("VALID");
        assertThat(report.getWarnings()).anyMatch(e -> "NO_FINGERPRINTS".equals(e.getCode()));
    }

    // ── Protocol validation ───────────────────────────────────────────────────

    @Test
    void validate_invalidProtocolType_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.setSupportedProtocols(List.of("TELNET"));  // not in allowed list
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_ENUM".equals(e.getCode())
                && e.getField().contains("protocol"));
    }

    // ── Parameter validation ──────────────────────────────────────────────────

    @Test
    void validate_parameterMissingId_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0).setId(null);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "REQUIRED_FIELD".equals(e.getCode())
                && e.getField().contains(".id"));
    }

    @Test
    void validate_invalidDataType_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0).setDataType("INVALID_TYPE");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_ENUM".equals(e.getCode())
                && e.getField().contains("dataType"));
    }

    @Test
    void validate_minGreaterThanMax_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0).setMinValue(100.0);
        def.getParameterGroups().get(0).getParameters().get(0).setMaxValue(0.0);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_RANGE".equals(e.getCode()));
    }

    @Test
    void validate_invalidSnmpOidOnParameter_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0).setSnmpOid("bad-oid");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_OID".equals(e.getCode()));
    }

    @Test
    void validate_enumTypeWithoutValues_producesWarning() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0).setDataType("ENUM");
        def.getParameterGroups().get(0).getParameters().get(0).setEnumValues(null);
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getWarnings()).anyMatch(e -> "MISSING_ENUM_VALUES".equals(e.getCode()));
    }

    // ── Credential scan ───────────────────────────────────────────────────────

    @Test
    void validate_credentialInDefaultValue_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0)
                .setDefaultValue("password=supersecret");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "CREDENTIAL_DETECTED".equals(e.getCode()));
    }

    @Test
    void validate_credentialInName_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.setName("community=public");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "CREDENTIAL_DETECTED".equals(e.getCode()));
    }

    // ── Credential runtime contract validation (WO-016) ──────────────────────

    @Test
    void validate_noVaultRefs_credentialContractOptional() {
        // Standard definition without vault:// references should not require the contract section
        NormalizedProductDefinition def = buildValid();
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getStatus()).isEqualTo("VALID");
        assertThat(report.getErrors()).noneMatch(e -> "MISSING_CREDENTIAL_RUNTIME_CONTRACT".equals(e.getCode()));
    }

    @Test
    void validate_vaultRefWithoutContract_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0)
                .setApiPath("vault://credentials/device-001/snmp");
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "MISSING_CREDENTIAL_RUNTIME_CONTRACT".equals(e.getCode()));
    }

    @Test
    void validate_vaultRefWithContract_isValid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0)
                .setApiPath("vault://credentials/device-001/snmp");
        def.setCredentialRuntimeRequirements(
                NormalizedProductDefinition.CredentialRuntimeRequirements.builder()
                        .vaultProvider("AES_256_GCM")
                        .tenantScoped(false)
                        .requiredSecretPaths(List.of("vault://credentials/device-001/snmp"))
                        .encryptionAtRest(true)
                        .keyRotationPolicy("ANNUAL")
                        .build()
        );
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).noneMatch(e -> "MISSING_CREDENTIAL_RUNTIME_CONTRACT".equals(e.getCode()));
        assertThat(report.getErrors()).noneMatch(e -> "REQUIRED_FIELD".equals(e.getCode())
                && e.getField().startsWith("credentialRuntimeRequirements"));
    }

    @Test
    void validate_vaultRefWithContractMissingProvider_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0)
                .setApiPath("vault://credentials/device-001");
        def.setCredentialRuntimeRequirements(
                NormalizedProductDefinition.CredentialRuntimeRequirements.builder()
                        .vaultProvider(null)
                        .requiredSecretPaths(List.of("vault://credentials/device-001"))
                        .build()
        );
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e ->
                "REQUIRED_FIELD".equals(e.getCode())
                && e.getField().contains("vaultProvider"));
    }

    @Test
    void validate_vaultRefWithInvalidPathInContract_isInvalid() {
        NormalizedProductDefinition def = buildValid();
        def.getParameterGroups().get(0).getParameters().get(0)
                .setCliCommand("vault://credentials/device-001");
        def.setCredentialRuntimeRequirements(
                NormalizedProductDefinition.CredentialRuntimeRequirements.builder()
                        .vaultProvider("AES_256_GCM")
                        .requiredSecretPaths(List.of("http://bad-path/credentials"))
                        .build()
        );
        ValidationReport report = service.validate(def, "d1", "v1", "c1");
        assertThat(report.getErrors()).anyMatch(e -> "INVALID_VAULT_PATH".equals(e.getCode()));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private NormalizedProductDefinition buildValid() {
        NormalizedProductDefinition.FingerprintEntry fp =
                NormalizedProductDefinition.FingerprintEntry.builder()
                        .sysObjectId(".1.3.6.1.4.1.9.1.685")
                        .sysDescrPattern(".*Cisco.*ASR.*")
                        .build();

        NormalizedProductDefinition.ParameterEntry param =
                NormalizedProductDefinition.ParameterEntry.builder()
                        .id("cpu_util")
                        .displayName("CPU Utilization")
                        .dataType("GAUGE")
                        .unit("%")
                        .minValue(0.0)
                        .maxValue(100.0)
                        .snmpOid(".1.3.6.1.4.1.9.9.109.1.1.1.1.8.1")
                        .build();

        NormalizedProductDefinition.ParameterGroup group =
                NormalizedProductDefinition.ParameterGroup.builder()
                        .groupName("cpu")
                        .parameters(List.of(param))
                        .build();

        return NormalizedProductDefinition.builder()
                .name("ASR 1000")
                .vendor("Cisco")
                .model("ASR-1001")
                .firmwareFrom("16.9")
                .firmwareTo("17.6")
                .fingerprints(List.of(fp))
                .supportedProtocols(List.of("SNMP"))
                .parameterGroups(List.of(group))
                .build();
    }
}

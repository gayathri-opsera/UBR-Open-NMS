package com.ubrnms.productdef;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionVersion;
import com.ubrnms.productdef.service.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for every publish validation gate (WO-021 AC-8).
 * Covers each failed gate and the successful path through all gates.
 */
class PublishGatesTest {

    private PublishGateEvaluator evaluator;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private ProductDefinitionVersion validStagedVersion() {
        ProductDefinitionVersion v = new ProductDefinitionVersion();
        v.setVersionId("1.0.0");
        v.setDefinitionId("def-001");
        v.setLifecycleStatus("STAGED");
        v.setValidationStatus("VALID");
        v.setVendor("Nokia");
        v.setModel("7210 SAS");
        v.setSchemaVersion("1.0");
        v.setNormalizedMetadataJson("{\"vendor\":\"Nokia\",\"model\":\"7210 SAS\"}");
        return v;
    }

    private NormalizedProductDefinition.FingerprintEntry validFp() {
        return NormalizedProductDefinition.FingerprintEntry.builder()
                .sysObjectId("1.3.6.1.4.1.6527.1")
                .build();
    }

    private NormalizedProductDefinition validNormalized() {
        return NormalizedProductDefinition.builder()
                .vendor("Nokia")
                .model("7210 SAS")
                .firmwareFrom("3.0")
                .firmwareTo("9.0")
                .fingerprints(List.of(validFp()))
                .build();
    }

    private NormalizedProductDefinition normalizedWith(
            List<NormalizedProductDefinition.FingerprintEntry> fps,
            NormalizedProductDefinition.CredentialRuntimeRequirements creds) {
        return NormalizedProductDefinition.builder()
                .vendor("Nokia")
                .model("7210 SAS")
                .firmwareFrom("3.0")
                .firmwareTo("9.0")
                .fingerprints(fps)
                .credentialRuntimeRequirements(creds)
                .build();
    }

    @BeforeEach
    void setUp() {
        evaluator = new PublishGateEvaluator();
    }

    // ── All gates pass — happy path ───────────────────────────────────────────

    @Test
    @DisplayName("All gates pass for a valid STAGED version with complete metadata")
    void allGates_pass_forValidStagedVersion() {
        assertThatCode(() -> evaluator.evaluate(validStagedVersion(), validNormalized()))
                .doesNotThrowAnyException();
    }

    // ── LIFECYCLE_STATE_GATE ──────────────────────────────────────────────────

    @Test
    @DisplayName("LIFECYCLE_STATE_GATE blocks DRAFT versions")
    void lifecycleStateGate_blocksDraft() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setLifecycleStatus("DRAFT");
        assertThatThrownBy(() -> PublishGates.LIFECYCLE_STATE_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("LIFECYCLE_STATE_GATE"))
                .hasMessageContaining("DRAFT")
                .hasMessageContaining("STAGED");
    }

    @Test
    @DisplayName("LIFECYCLE_STATE_GATE blocks ACTIVE versions from re-activation")
    void lifecycleStateGate_blocksActive() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setLifecycleStatus("ACTIVE");
        assertThatThrownBy(() -> PublishGates.LIFECYCLE_STATE_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class);
    }

    @Test
    @DisplayName("LIFECYCLE_STATE_GATE passes for STAGED version")
    void lifecycleStateGate_passesForStaged() {
        assertThatCode(() -> PublishGates.LIFECYCLE_STATE_GATE.evaluate(validStagedVersion(), validNormalized()))
                .doesNotThrowAnyException();
    }

    // ── SCHEMA_VALIDATION_GATE ────────────────────────────────────────────────

    @Test
    @DisplayName("SCHEMA_VALIDATION_GATE blocks INVALID validation status")
    void schemaValidationGate_blocksInvalid() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setValidationStatus("INVALID");
        assertThatThrownBy(() -> PublishGates.SCHEMA_VALIDATION_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("SCHEMA_VALIDATION_GATE"))
                .hasMessageContaining("INVALID");
    }

    @Test
    @DisplayName("SCHEMA_VALIDATION_GATE blocks PENDING validation status")
    void schemaValidationGate_blocksPending() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setValidationStatus("PENDING");
        assertThatThrownBy(() -> PublishGates.SCHEMA_VALIDATION_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class);
    }

    @Test
    @DisplayName("SCHEMA_VALIDATION_GATE passes for VALID status")
    void schemaValidationGate_passesForValid() {
        assertThatCode(() -> PublishGates.SCHEMA_VALIDATION_GATE.evaluate(validStagedVersion(), validNormalized()))
                .doesNotThrowAnyException();
    }

    // ── METADATA_COMPLETENESS_GATE ────────────────────────────────────────────

    @Test
    @DisplayName("METADATA_COMPLETENESS_GATE blocks blank vendor")
    void metadataGate_blocksBlankVendor() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setVendor("");
        assertThatThrownBy(() -> PublishGates.METADATA_COMPLETENESS_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("METADATA_COMPLETENESS_GATE"))
                .hasMessageContaining("vendor");
    }

    @Test
    @DisplayName("METADATA_COMPLETENESS_GATE blocks null model")
    void metadataGate_blocksNullModel() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setModel(null);
        assertThatThrownBy(() -> PublishGates.METADATA_COMPLETENESS_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .hasMessageContaining("model");
    }

    @Test
    @DisplayName("METADATA_COMPLETENESS_GATE blocks blank schemaVersion")
    void metadataGate_blocksBlankSchemaVersion() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setSchemaVersion("   ");
        assertThatThrownBy(() -> PublishGates.METADATA_COMPLETENESS_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .hasMessageContaining("schemaVersion");
    }

    // ── NORMALIZED_METADATA_GATE ──────────────────────────────────────────────

    @Test
    @DisplayName("NORMALIZED_METADATA_GATE blocks when normalizedMetadataJson is null")
    void normalizedMetadataGate_blocksNullJson() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setNormalizedMetadataJson(null);
        assertThatThrownBy(() -> PublishGates.NORMALIZED_METADATA_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("NORMALIZED_METADATA_GATE"));
    }

    @Test
    @DisplayName("NORMALIZED_METADATA_GATE blocks empty JSON")
    void normalizedMetadataGate_blocksEmptyJson() {
        ProductDefinitionVersion v = validStagedVersion();
        v.setNormalizedMetadataJson("   ");
        assertThatThrownBy(() -> PublishGates.NORMALIZED_METADATA_GATE.evaluate(v, validNormalized()))
                .isInstanceOf(PublishGateViolation.class);
    }

    // ── FINGERPRINT_PRESENCE_GATE ─────────────────────────────────────────────

    @Test
    @DisplayName("FINGERPRINT_PRESENCE_GATE blocks null normalized definition")
    void fingerprintGate_blocksNullNormalized() {
        assertThatThrownBy(() -> PublishGates.FINGERPRINT_PRESENCE_GATE.evaluate(validStagedVersion(), null))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("FINGERPRINT_PRESENCE_GATE"));
    }

    @Test
    @DisplayName("FINGERPRINT_PRESENCE_GATE blocks empty fingerprint list")
    void fingerprintGate_blocksEmptyFingerprints() {
        NormalizedProductDefinition noFp = normalizedWith(List.of(), null);
        assertThatThrownBy(() -> PublishGates.FINGERPRINT_PRESENCE_GATE.evaluate(validStagedVersion(), noFp))
                .isInstanceOf(PublishGateViolation.class)
                .hasMessageContaining("fingerprint");
    }

    @Test
    @DisplayName("FINGERPRINT_PRESENCE_GATE passes when fingerprints are present")
    void fingerprintGate_passesWith1Fingerprint() {
        assertThatCode(() -> PublishGates.FINGERPRINT_PRESENCE_GATE.evaluate(validStagedVersion(), validNormalized()))
                .doesNotThrowAnyException();
    }

    // ── CREDENTIAL_REFERENCE_GATE ─────────────────────────────────────────────

    @Test
    @DisplayName("CREDENTIAL_REFERENCE_GATE passes when no credential section is present")
    void credentialGate_passesWhenNoCredentialSection() {
        NormalizedProductDefinition noCreds = normalizedWith(List.of(validFp()), null);
        assertThatCode(() -> PublishGates.CREDENTIAL_REFERENCE_GATE.evaluate(validStagedVersion(), noCreds))
                .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("CREDENTIAL_REFERENCE_GATE blocks when requiredSecretPaths is empty")
    void credentialGate_blocksEmptySecretPaths() {
        NormalizedProductDefinition.CredentialRuntimeRequirements creds =
                NormalizedProductDefinition.CredentialRuntimeRequirements.builder()
                        .requiredSecretPaths(List.of())
                        .build();
        NormalizedProductDefinition withCreds = normalizedWith(List.of(validFp()), creds);
        assertThatThrownBy(() -> PublishGates.CREDENTIAL_REFERENCE_GATE.evaluate(validStagedVersion(), withCreds))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName())
                        .isEqualTo("CREDENTIAL_REFERENCE_GATE"))
                .hasMessageContaining("requiredSecretPaths");
    }

    @Test
    @DisplayName("CREDENTIAL_REFERENCE_GATE passes when requiredSecretPaths is populated")
    void credentialGate_passesWithSecretPaths() {
        NormalizedProductDefinition.CredentialRuntimeRequirements creds =
                NormalizedProductDefinition.CredentialRuntimeRequirements.builder()
                        .requiredSecretPaths(List.of("secret/data/ubrnms/snmp/nokia"))
                        .build();
        NormalizedProductDefinition withCreds = normalizedWith(List.of(validFp()), creds);
        assertThatCode(() -> PublishGates.CREDENTIAL_REFERENCE_GATE.evaluate(validStagedVersion(), withCreds))
                .doesNotThrowAnyException();
    }

    // ── PublishGateEvaluator composition ─────────────────────────────────────

    @Test
    @DisplayName("Evaluator stops at first failing gate (LIFECYCLE_STATE early-out)")
    void evaluator_stopsAtFirstFailingGate() {
        // Use only 2 gates; second gate should never be called when first fails
        PublishGate failGate = new PublishGate() {
            public String getName() { return "FAIL_GATE"; }
            public void evaluate(ProductDefinitionVersion v, NormalizedProductDefinition n) {
                throw new PublishGateViolation(getName(), "Always fails");
            }
        };
        PublishGate panicGate = new PublishGate() {
            public String getName() { return "PANIC_GATE"; }
            public void evaluate(ProductDefinitionVersion v, NormalizedProductDefinition n) {
                throw new AssertionError("PANIC_GATE should never be reached");
            }
        };
        PublishGateEvaluator twoGateEvaluator = new PublishGateEvaluator(List.of(failGate, panicGate));
        assertThatThrownBy(() -> twoGateEvaluator.evaluate(validStagedVersion(), validNormalized()))
                .isInstanceOf(PublishGateViolation.class)
                .satisfies(ex -> assertThat(((PublishGateViolation) ex).getGateName()).isEqualTo("FAIL_GATE"));
    }

    @Test
    @DisplayName("PublishGate ALL_GATES list contains 6 gates in canonical order")
    void allGates_containsExpectedGates() {
        assertThat(PublishGates.ALL_GATES).hasSize(6);
        assertThat(PublishGates.ALL_GATES.get(0).getName()).isEqualTo("LIFECYCLE_STATE_GATE");
        assertThat(PublishGates.ALL_GATES.get(5).getName()).isEqualTo("CREDENTIAL_REFERENCE_GATE");
    }
}

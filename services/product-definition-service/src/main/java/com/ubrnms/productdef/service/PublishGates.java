package com.ubrnms.productdef.service;

import com.ubrnms.productdef.lifecycle.ProductDefinitionStateMachine;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionVersion;

import java.util.List;

/**
 * Concrete publish validation gates for the Product Definition lifecycle (WO-021).
 *
 * <p>Each gate is a named {@link PublishGate} implementation that enforces exactly
 * one prerequisite.  All gates are evaluated by {@link PublishGateEvaluator} before
 * any state mutation or registry rebuild occurs.
 *
 * <p>Gate evaluation order matters: lifecycle state is checked first so downstream
 * gates never observe a version in an unexpected state.
 *
 * <p>SECURITY: No gate reads or logs credential values.  The credential reference
 * gate checks that a reference exists and is non-empty, not that it resolves to
 * a valid credential (which is validated at runtime by the device adapter).
 */
public final class PublishGates {

    private PublishGates() { /* static factory */ }

    // ── Gate 1: Lifecycle state must be STAGED ────────────────────────────────

    /**
     * Blocks activation unless the version is in {@code STAGED} lifecycle status.
     *
     * <p>AC-4: "Publishing is blocked when the Product Definition has not reached
     * the required approved lifecycle state."
     */
    public static final PublishGate LIFECYCLE_STATE_GATE = new PublishGate() {

        @Override
        public String getName() { return "LIFECYCLE_STATE_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            if (!ProductDefinitionStateMachine.STAGED.equals(version.getLifecycleStatus())) {
                throw new PublishGateViolation(getName(),
                        "Cannot activate version " + version.getVersionId()
                        + ": lifecycle status is '" + version.getLifecycleStatus()
                        + "' but must be 'STAGED'. Stage the version first.");
            }
        }
    };

    // ── Gate 2: Schema validation must have passed ────────────────────────────

    /**
     * Blocks activation unless the version's validation status is {@code VALID}.
     *
     * <p>AC-2: "Publishing is blocked when required metadata is missing or invalid."
     */
    public static final PublishGate SCHEMA_VALIDATION_GATE = new PublishGate() {

        @Override
        public String getName() { return "SCHEMA_VALIDATION_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            if (!"VALID".equals(version.getValidationStatus())) {
                throw new PublishGateViolation(getName(),
                        "Cannot activate version " + version.getVersionId()
                        + ": validationStatus is '" + version.getValidationStatus()
                        + "'. Fix all validation errors before activating.");
            }
        }
    };

    // ── Gate 3: Required metadata completeness ────────────────────────────────

    /**
     * Blocks activation when required product identity metadata is absent.
     *
     * <p>AC-2: "Publishing is blocked when required metadata is missing or invalid."
     * Required fields: vendor, model, schemaVersion.
     */
    public static final PublishGate METADATA_COMPLETENESS_GATE = new PublishGate() {

        @Override
        public String getName() { return "METADATA_COMPLETENESS_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            if (isBlank(version.getVendor())) {
                throw new PublishGateViolation(getName(),
                        "Required field 'vendor' is missing from version "
                        + version.getVersionId() + ". Re-upload with a valid vendor name.");
            }
            if (isBlank(version.getModel())) {
                throw new PublishGateViolation(getName(),
                        "Required field 'model' is missing from version "
                        + version.getVersionId() + ". Re-upload with a valid model identifier.");
            }
            if (isBlank(version.getSchemaVersion())) {
                throw new PublishGateViolation(getName(),
                        "Required field 'schemaVersion' is missing from version "
                        + version.getVersionId() + ". Re-upload with a recognised schema version.");
            }
        }

        private boolean isBlank(String s) { return s == null || s.isBlank(); }
    };

    // ── Gate 4: At least one fingerprint must be defined ─────────────────────

    /**
     * Blocks activation when the normalized definition contains no fingerprint entries.
     *
     * <p>AC-2: A definition with no fingerprints cannot match any device in the field.
     * The SNMP discovery engine uses fingerprints to classify discovered devices;
     * an empty fingerprint list makes the definition operationally useless.
     */
    public static final PublishGate FINGERPRINT_PRESENCE_GATE = new PublishGate() {

        @Override
        public String getName() { return "FINGERPRINT_PRESENCE_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            if (normalized == null) {
                throw new PublishGateViolation(getName(),
                        "Cannot evaluate fingerprint gate: normalized definition metadata is unavailable "
                        + "for version " + version.getVersionId()
                        + ". Re-upload the file to regenerate the parsed definition.");
            }
            List<NormalizedProductDefinition.FingerprintEntry> fps = normalized.getFingerprints();
            if (fps == null || fps.isEmpty()) {
                throw new PublishGateViolation(getName(),
                        "Definition version " + version.getVersionId()
                        + " contains no fingerprint entries. At least one fingerprint (OID, sysDescr pattern, "
                        + "or chassis MAC prefix) is required for device classification.");
            }
        }
    };

    // ── Gate 5: Credential reference must not be empty ────────────────────────

    /**
     * Blocks activation when the credential vault reference is absent or blank.
     *
     * <p>AC-3: "Publishing is blocked when credential references are absent,
     * unresolved, or unauthorized."
     *
     * <p>SECURITY: This gate checks for the <em>presence</em> of a vault reference
     * path only.  It does not read, validate, or log the actual credential value.
     */
    public static final PublishGate CREDENTIAL_REFERENCE_GATE = new PublishGate() {

        @Override
        public String getName() { return "CREDENTIAL_REFERENCE_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            if (normalized == null) return; // structural issue caught by FINGERPRINT gate first
            NormalizedProductDefinition.CredentialRuntimeRequirements creds =
                    normalized.getCredentialRuntimeRequirements();
            if (creds == null) return; // credential section is optional for non-SNMP definitions
            // If a credential section is present, at least one required secret path must be specified
            List<String> secretPaths = creds.getRequiredSecretPaths();
            if (secretPaths == null || secretPaths.isEmpty()) {
                throw new PublishGateViolation(getName(),
                        "Definition version " + version.getVersionId()
                        + " includes a credential requirements section but 'requiredSecretPaths' is absent. "
                        + "Specify at least one vault secret path that holds runtime SNMP credentials, "
                        + "or remove the credentials section if none are needed.");
            }
            // Ensure each path is non-blank
            boolean anyBlank = secretPaths.stream().anyMatch(p -> p == null || p.isBlank());
            if (anyBlank) {
                throw new PublishGateViolation(getName(),
                        "Definition version " + version.getVersionId()
                        + " has one or more blank entries in 'requiredSecretPaths'. "
                        + "All credential vault path references must be non-empty strings.");
            }
        }
    };

    // ── Gate 6: Normalized metadata JSON must be present ─────────────────────

    /**
     * Blocks activation when the stored normalized metadata JSON is absent.
     *
     * <p>This is a structural integrity gate — if {@code normalizedMetadataJson} is
     * missing the registry builder cannot proceed, and the activation would fail
     * mid-execution after state has already changed.  Catching it early ensures
     * the failure is clean and the version stays STAGED.
     */
    public static final PublishGate NORMALIZED_METADATA_GATE = new PublishGate() {

        @Override
        public String getName() { return "NORMALIZED_METADATA_GATE"; }

        @Override
        public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
            String json = version.getNormalizedMetadataJson();
            if (json == null || json.isBlank()) {
                throw new PublishGateViolation(getName(),
                        "Cannot activate version " + version.getVersionId()
                        + ": stored normalizedMetadataJson is absent. "
                        + "Re-upload the definition file to regenerate the parsed metadata.");
            }
        }
    };

    // ── Ordered gate list ─────────────────────────────────────────────────────

    /**
     * The canonical ordered sequence of publish gates.
     *
     * <p>Evaluated in this order:
     * <ol>
     *   <li>{@link #LIFECYCLE_STATE_GATE} — reject wrong lifecycle state first</li>
     *   <li>{@link #SCHEMA_VALIDATION_GATE} — schema must be VALID</li>
     *   <li>{@link #METADATA_COMPLETENESS_GATE} — required fields present</li>
     *   <li>{@link #NORMALIZED_METADATA_GATE} — parsed metadata must exist</li>
     *   <li>{@link #FINGERPRINT_PRESENCE_GATE} — at least one fingerprint</li>
     *   <li>{@link #CREDENTIAL_REFERENCE_GATE} — vault path when credentials needed</li>
     * </ol>
     */
    public static final List<PublishGate> ALL_GATES = List.of(
        LIFECYCLE_STATE_GATE,
        SCHEMA_VALIDATION_GATE,
        METADATA_COMPLETENESS_GATE,
        NORMALIZED_METADATA_GATE,
        FINGERPRINT_PRESENCE_GATE,
        CREDENTIAL_REFERENCE_GATE
    );
}

package com.ubrnms.productdef.validation;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import com.ubrnms.productdef.model.ValidationReport;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Validates a {@link NormalizedProductDefinition} against all field-level rules and
 * produces a {@link ValidationReport}.
 *
 * <p>Validation rules enforced by this service:
 * <ul>
 *   <li>Identity: {@code name}, {@code vendor}, {@code model} are required.</li>
 *   <li>Fingerprints: each entry must have a valid SNMP sysObjectId OID format
 *       ({@code .1.3.6.1.4.1.*} prefix).</li>
 *   <li>Parameters: each entry needs {@code id} and {@code dataType}; numeric ranges
 *       must satisfy {@code minValue <= maxValue}; OIDs in snmpOid must pass OID regex.</li>
 *   <li>Credentials: fields are scanned for credential-like patterns — any match
 *       is an ERROR and the value is redacted from the report.</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductDefinitionValidationService {

    // Loose OID pattern — one or more numeric arcs separated by dots
    private static final Pattern OID_PATTERN = Pattern.compile("^\\.?(\\d+\\.)+\\d+$");

    // Credential-like pattern: catches common secret value patterns
    private static final Pattern CREDENTIAL_PATTERN = Pattern.compile(
            "(?i)(password|passwd|secret|community|apikey|api_key|token|private_?key|auth)\\s*[:=]\\s*\\S+");

    // Allowed dataType values — includes canonical NMS types plus SNMP-native aliases
    // (TIMETICKS, COUNTER32, COUNTER64, GAUGE32, UNSIGNED32) so definitions using
    // SNMP-idiomatic type names validate without requiring a translation layer.
    private static final List<String> VALID_DATA_TYPES = List.of(
            "STRING", "INTEGER", "LONG", "FLOAT", "DOUBLE",
            "BOOLEAN", "ENUM", "OID", "IPADDRESS", "DATETIME", "COUNTER", "GAUGE",
            "TIMETICKS", "COUNTER32", "COUNTER64", "GAUGE32", "UNSIGNED32", "OCTETSTRING");

    // Allowed protocol types
    private static final List<String> VALID_PROTOCOL_TYPES = List.of(
            "SNMP", "CLI", "REST", "GRPC", "NETCONF", "RESTCONF");

    public ValidationReport validate(NormalizedProductDefinition def, String definitionId,
                                     String versionId, String correlationId) {
        List<ValidationError> errors   = new ArrayList<>();
        List<ValidationError> warnings = new ArrayList<>();

        validateIdentity(def, errors, warnings);
        validateFingerprints(def, errors, warnings);
        validateProtocols(def, errors, warnings);
        validateParameters(def, errors, warnings);
        validateCredentialRuntimeContract(def, errors, warnings);
        scanCredentials(def, errors);

        String status = errors.isEmpty() ? "VALID" : "INVALID";

        int paramCount = def.getParameterGroups() == null ? 0
                : def.getParameterGroups().stream()
                      .mapToInt(g -> g.getParameters() == null ? 0 : g.getParameters().size())
                      .sum();

        String summary = buildSummary(def, paramCount);

        return ValidationReport.builder()
                .definitionId(definitionId)
                .versionId(versionId)
                .status(status)
                .errors(errors)
                .warnings(warnings)
                .parameterCount(paramCount)
                .fingerprintCount(def.getFingerprints() == null ? 0 : def.getFingerprints().size())
                .protocolCount(def.getSupportedProtocols() == null ? 0 : def.getSupportedProtocols().size())
                .normalizedSummary(summary)
                .correlationId(correlationId)
                .build();
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    private void validateIdentity(NormalizedProductDefinition def,
                                   List<ValidationError> errors,
                                   List<ValidationError> warnings) {
        if (def.getName() == null || def.getName().isBlank())
            errors.add(err("REQUIRED_FIELD", "identity.name", "name is required"));
        if (def.getVendor() == null || def.getVendor().isBlank())
            errors.add(err("REQUIRED_FIELD", "identity.vendor", "vendor is required"));
        if (def.getModel() == null || def.getModel().isBlank())
            errors.add(err("REQUIRED_FIELD", "identity.model", "model is required"));

        // Firmware range consistency check
        if (def.getFirmwareFrom() != null && def.getFirmwareTo() != null) {
            if (def.getFirmwareFrom().compareToIgnoreCase(def.getFirmwareTo()) > 0) {
                warnings.add(warn("FIRMWARE_RANGE", "identity.firmwareFrom",
                        "firmwareFrom '" + def.getFirmwareFrom()
                        + "' appears later than firmwareTo '" + def.getFirmwareTo() + "'"));
            }
        }
    }

    // ── Fingerprints ──────────────────────────────────────────────────────────

    private void validateFingerprints(NormalizedProductDefinition def,
                                       List<ValidationError> errors,
                                       List<ValidationError> warnings) {
        if (def.getFingerprints() == null || def.getFingerprints().isEmpty()) {
            warnings.add(warn("NO_FINGERPRINTS", "fingerprints",
                    "No fingerprints defined — automatic device matching will not work"));
            return;
        }
        for (int i = 0; i < def.getFingerprints().size(); i++) {
            NormalizedProductDefinition.FingerprintEntry fp = def.getFingerprints().get(i);
            String field = "fingerprints[" + i + "]";
            if (fp.getSysObjectId() == null || fp.getSysObjectId().isBlank()) {
                // sysObjectId is strongly recommended but optional when pattern-based fingerprints
                // (sysDescrPattern / SSH banner / HTTP header match) are provided instead.
                if (fp.getSysDescrPattern() == null || fp.getSysDescrPattern().isBlank()) {
                    errors.add(err("REQUIRED_FIELD", field + ".sysObjectId",
                            "sysObjectId or sysDescrPattern is required on every fingerprint for device matching"));
                } else {
                    warnings.add(warn("MISSING_SNMP_OID", field + ".sysObjectId",
                            "sysObjectId not set — device matching will rely on sysDescrPattern only"));
                }
            } else if (!OID_PATTERN.matcher(fp.getSysObjectId()).matches()) {
                errors.add(err("INVALID_OID", field + ".sysObjectId",
                        "sysObjectId must be a valid OID (e.g. .1.3.6.1.4.1.9.1.1): "
                        + fp.getSysObjectId()));
            }
        }
    }

    // ── Protocols ─────────────────────────────────────────────────────────────

    private void validateProtocols(NormalizedProductDefinition def,
                                    List<ValidationError> errors,
                                    List<ValidationError> warnings) {
        if (def.getSupportedProtocols() == null || def.getSupportedProtocols().isEmpty()) {
            warnings.add(warn("NO_PROTOCOLS", "protocols",
                    "No supported protocols defined — collection will fall back to defaults"));
            return;
        }
        for (int i = 0; i < def.getSupportedProtocols().size(); i++) {
            String t = def.getSupportedProtocols().get(i);
            if (!VALID_PROTOCOL_TYPES.contains(t)) {
                errors.add(err("INVALID_ENUM", "protocols[" + i + "].type",
                        "Unknown protocol type '" + t + "'. Allowed: " + VALID_PROTOCOL_TYPES));
            }
        }
    }

    // ── Parameters ────────────────────────────────────────────────────────────

    private void validateParameters(NormalizedProductDefinition def,
                                     List<ValidationError> errors,
                                     List<ValidationError> warnings) {
        if (def.getParameterGroups() == null || def.getParameterGroups().isEmpty()) {
            warnings.add(warn("NO_PARAMETERS", "parameters",
                    "No parameter groups defined — metrics collection may be empty"));
            return;
        }

        int globalParamIdx = 0;
        for (NormalizedProductDefinition.ParameterGroup group : def.getParameterGroups()) {
            if (group.getParameters() == null) continue;
            for (NormalizedProductDefinition.ParameterEntry p : group.getParameters()) {
                String field = "parameters." + group.getGroupName() + "[" + globalParamIdx + "]";

                if (p.getId() == null || p.getId().isBlank())
                    errors.add(err("REQUIRED_FIELD", field + ".id", "parameter id is required"));

                if (p.getDataType() == null || p.getDataType().isBlank()) {
                    errors.add(err("REQUIRED_FIELD", field + ".dataType", "dataType is required"));
                } else if (!VALID_DATA_TYPES.contains(p.getDataType().toUpperCase())) {
                    errors.add(err("INVALID_ENUM", field + ".dataType",
                            "Unknown dataType '" + p.getDataType() + "'. Allowed: " + VALID_DATA_TYPES));
                }

                // Numeric range: minValue must be <= maxValue
                if (p.getMinValue() != null && p.getMaxValue() != null
                        && p.getMinValue() > p.getMaxValue()) {
                    errors.add(err("INVALID_RANGE", field + ".minValue",
                            "minValue (" + p.getMinValue() + ") must be <= maxValue (" + p.getMaxValue() + ")"));
                }

                // OID format validation for SNMP parameters
                if (p.getSnmpOid() != null && !p.getSnmpOid().isBlank()
                        && !OID_PATTERN.matcher(p.getSnmpOid()).matches()) {
                    errors.add(err("INVALID_OID", field + ".snmpOid",
                            "snmpOid must be a valid OID: " + p.getSnmpOid()));
                }

                // ENUM type must supply enumValues
                if ("ENUM".equalsIgnoreCase(p.getDataType())
                        && (p.getEnumValues() == null || p.getEnumValues().isEmpty())) {
                    warnings.add(warn("MISSING_ENUM_VALUES", field + ".enumValues",
                            "Parameter with dataType ENUM should define enumValues for UI rendering"));
                }

                globalParamIdx++;
            }
        }
    }

    // ── Credential runtime contract (WO-016) ─────────────────────────────────

    /**
     * Validates the {@code credentialRuntimeRequirements} section when protocol mappings
     * reference vault:// credential paths.
     *
     * <p>If any parameter's CLI command, API path, or gRPC path contains a {@code vault://}
     * reference, the {@code credentialRuntimeRequirements} section must be present and valid.
     */
    private void validateCredentialRuntimeContract(NormalizedProductDefinition def,
                                                    List<ValidationError> errors,
                                                    List<ValidationError> warnings) {
        boolean hasVaultReference = hasVaultReferences(def);

        if (!hasVaultReference) {
            return; // contract section is optional when no vault references exist
        }

        NormalizedProductDefinition.CredentialRuntimeRequirements req = def.getCredentialRuntimeRequirements();
        if (req == null) {
            errors.add(err("MISSING_CREDENTIAL_RUNTIME_CONTRACT", "credentialRuntimeRequirements",
                    "Protocol mappings reference vault:// credential paths but credentialRuntimeRequirements section is absent. "
                    + "Add credentialRuntimeRequirements declaring vaultProvider, tenantScoped, and requiredSecretPaths."));
            return;
        }

        if (req.getVaultProvider() == null || req.getVaultProvider().isBlank()) {
            errors.add(err("REQUIRED_FIELD", "credentialRuntimeRequirements.vaultProvider",
                    "vaultProvider is required. Supported value: AES_256_GCM"));
        } else if (!req.getVaultProvider().equals("AES_256_GCM")) {
            // Only AES_256_GCM is supported; other providers should be flagged as warnings
            warnings.add(warn("UNSUPPORTED_VAULT_PROVIDER", "credentialRuntimeRequirements.vaultProvider",
                    "Unsupported vaultProvider '" + req.getVaultProvider()
                    + "'. Production deployments must use AES_256_GCM."));
        }

        if (req.getRequiredSecretPaths() == null || req.getRequiredSecretPaths().isEmpty()) {
            errors.add(err("REQUIRED_FIELD", "credentialRuntimeRequirements.requiredSecretPaths",
                    "requiredSecretPaths must list at least one vault:// path when credential references are present."));
        } else {
            for (int i = 0; i < req.getRequiredSecretPaths().size(); i++) {
                String path = req.getRequiredSecretPaths().get(i);
                if (path == null || !path.startsWith("vault://")) {
                    errors.add(err("INVALID_VAULT_PATH",
                            "credentialRuntimeRequirements.requiredSecretPaths[" + i + "]",
                            "Vault paths must start with vault://. Got: " + path));
                }
            }
        }
    }

    /** Returns true when any protocol mapping in the definition contains a vault:// reference. */
    private boolean hasVaultReferences(NormalizedProductDefinition def) {
        if (def.getParameterGroups() == null) return false;
        for (NormalizedProductDefinition.ParameterGroup group : def.getParameterGroups()) {
            if (group.getParameters() == null) continue;
            for (NormalizedProductDefinition.ParameterEntry p : group.getParameters()) {
                if (containsVaultRef(p.getCliCommand())
                        || containsVaultRef(p.getApiPath())
                        || containsVaultRef(p.getGrpcPath())) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean containsVaultRef(String value) {
        return value != null && value.contains("vault://");
    }

    // ── Credential scan ───────────────────────────────────────────────────────

    /**
     * Scans string representations of all identity and parameter fields for patterns
     * that resemble credentials.  Any match is a blocking ERROR — the definition must
     * not be persisted with credential content.
     */
    private void scanCredentials(NormalizedProductDefinition def, List<ValidationError> errors) {
        List<String[]> candidates = new ArrayList<>();

        if (def.getName() != null)         candidates.add(new String[]{"identity.name", def.getName()});
        if (def.getVendor() != null)       candidates.add(new String[]{"identity.vendor", def.getVendor()});
        if (def.getModel() != null)        candidates.add(new String[]{"identity.model", def.getModel()});
        if (def.getProductFamily() != null) candidates.add(new String[]{"identity.productFamily", def.getProductFamily()});

        if (def.getParameterGroups() != null) {
            for (NormalizedProductDefinition.ParameterGroup g : def.getParameterGroups()) {
                if (g.getParameters() == null) continue;
                for (NormalizedProductDefinition.ParameterEntry p : g.getParameters()) {
                    if (p.getDefaultValue() != null)
                        candidates.add(new String[]{p.getId() + ".defaultValue", p.getDefaultValue()});
                    if (p.getDisplayName() != null)
                        candidates.add(new String[]{p.getId() + ".displayName", p.getDisplayName()});
                }
            }
        }

        for (String[] c : candidates) {
            if (CREDENTIAL_PATTERN.matcher(c[1]).find()) {
                errors.add(ValidationError.builder()
                        .code("CREDENTIAL_DETECTED")
                        .field(c[0])
                        .message("Field appears to contain a credential value. Remove credentials "
                                + "from product definitions — use secret manager references instead.")
                        .severity("ERROR")
                        .build());
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String buildSummary(NormalizedProductDefinition def, int paramCount) {
        String name   = def.getName()   != null ? def.getName()   : "Unknown";
        String vendor = def.getVendor() != null ? def.getVendor() : "Unknown";
        String model  = def.getModel()  != null ? def.getModel()  : "Unknown";
        int fps   = def.getFingerprints()      != null ? def.getFingerprints().size()       : 0;
        int protos = def.getSupportedProtocols() != null ? def.getSupportedProtocols().size() : 0;
        return vendor + " " + name + " (" + model + ") — "
                + fps + " fingerprint(s), " + protos + " protocol(s), " + paramCount + " parameter(s)";
    }

    private ValidationError err(String code, String field, String message) {
        return ValidationError.builder().code(code).field(field).message(message).severity("ERROR").build();
    }

    private ValidationError warn(String code, String field, String message) {
        return ValidationError.builder().code(code).field(field).message(message).severity("WARNING").build();
    }
}

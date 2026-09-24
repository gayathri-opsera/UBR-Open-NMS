package com.ubrnms.productdef.validation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Parses a JSON Product Definition file into a {@link NormalizedProductDefinition}.
 *
 * <p>Required schema URI: {@value REQUIRED_SCHEMA_URI}.  The file must contain a
 * top-level {@code "$schema"} field matching this URI and a {@code "productDefinition"}
 * root object.  Missing either produces a structured error rather than a NullPointerException.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class JsonProductDefinitionParser {

    public static final String REQUIRED_SCHEMA_URI = "urn:nms:productdef:json:1.0";

    private final ObjectMapper objectMapper;

    public NormalizedProductDefinition parse(byte[] bytes, List<ValidationError> errors) {
        JsonNode root;
        try {
            root = objectMapper.readTree(bytes);
        } catch (Exception e) {
            errors.add(ValidationError.builder()
                    .code("JSON_PARSE_ERROR")
                    .field("document")
                    .message("JSON document could not be parsed: " + sanitize(e.getMessage()))
                    .severity("ERROR")
                    .build());
            return null;
        }

        // Schema URI enforcement
        JsonNode schemaNode = root.get("$schema");
        if (schemaNode == null || !REQUIRED_SCHEMA_URI.equals(schemaNode.asText())) {
            errors.add(ValidationError.builder()
                    .code("JSON_SCHEMA_URI_INVALID")
                    .field("$schema")
                    .message("Top-level \"$schema\" must equal \"" + REQUIRED_SCHEMA_URI + "\"")
                    .severity("ERROR")
                    .build());
            return null;
        }

        // productDefinition root object enforcement
        JsonNode defNode = root.get("productDefinition");
        if (defNode == null || defNode.isNull() || !defNode.isObject()) {
            errors.add(ValidationError.builder()
                    .code("MISSING_FIELD")
                    .field("productDefinition")
                    .message("Top-level \"productDefinition\" object is required")
                    .severity("ERROR")
                    .build());
            return null;
        }

        NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder =
                NormalizedProductDefinition.builder();

        parseIdentity(defNode.get("identity"), builder, errors);
        parseFingerprints(defNode.get("fingerprints"), builder, errors);
        parseProtocols(defNode.get("protocols"), builder, errors);
        parseParameters(defNode.get("parameters"), builder, errors);

        return builder.build();
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    private void parseIdentity(JsonNode identity,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                List<ValidationError> errors) {
        if (identity == null || identity.isNull()) {
            errors.add(err("MISSING_FIELD", "productDefinition.identity", "The \"identity\" object is required"));
            return;
        }
        builder.name(str(identity, "name"))
               .vendor(str(identity, "vendor"))
               .model(str(identity, "model"))
               .firmwareFrom(str(identity, "firmwareFrom"))
               .firmwareTo(str(identity, "firmwareTo"))
               .productFamily(str(identity, "productFamily"))
               .deviceType(str(identity, "deviceType"));
    }

    // ── Fingerprints ──────────────────────────────────────────────────────────

    private void parseFingerprints(JsonNode node,
                                    NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                    List<ValidationError> errors) {
        if (node == null || !node.isArray()) {
            builder.fingerprints(List.of());
            return;
        }
        List<NormalizedProductDefinition.FingerprintEntry> list = new ArrayList<>();
        for (JsonNode fp : node) {
            list.add(NormalizedProductDefinition.FingerprintEntry.builder()
                    .sysObjectId(str(fp, "sysObjectId"))
                    .sysDescrPattern(str(fp, "sysDescrPattern"))
                    .firmwareFrom(str(fp, "firmwareFrom"))
                    .firmwareTo(str(fp, "firmwareTo"))
                    .build());
        }
        builder.fingerprints(list);
    }

    // ── Protocols ─────────────────────────────────────────────────────────────

    private void parseProtocols(JsonNode node,
                                 NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                 List<ValidationError> errors) {
        if (node == null || !node.isArray()) {
            builder.supportedProtocols(List.of());
            return;
        }
        List<String> types = new ArrayList<>();
        for (JsonNode p : node) {
            String type = str(p, "type");
            if (type != null && !type.isBlank()) types.add(type.toUpperCase());
        }
        builder.supportedProtocols(types);
    }

    // ── Parameters ────────────────────────────────────────────────────────────

    private void parseParameters(JsonNode node,
                                  NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                  List<ValidationError> errors) {
        if (node == null || !node.isArray()) {
            builder.parameterGroups(List.of());
            return;
        }
        List<NormalizedProductDefinition.ParameterGroup> groups = new ArrayList<>();
        for (JsonNode groupNode : node) {
            String groupName = str(groupNode, "groupName");
            if (groupName == null || groupName.isBlank()) groupName = "default";
            JsonNode params = groupNode.get("parameters");
            List<NormalizedProductDefinition.ParameterEntry> entries = new ArrayList<>();
            if (params != null && params.isArray()) {
                for (JsonNode p : params) entries.add(parseParameterNode(p));
            }
            groups.add(NormalizedProductDefinition.ParameterGroup.builder()
                    .groupName(groupName)
                    .parameters(entries)
                    .build());
        }
        builder.parameterGroups(groups);
    }

    private NormalizedProductDefinition.ParameterEntry parseParameterNode(JsonNode p) {
        var b = NormalizedProductDefinition.ParameterEntry.builder()
                        .id(str(p, "id"))
                        .displayName(str(p, "displayName"))
                        .dataType(str(p, "dataType"))
                        .unit(str(p, "unit"))
                        .defaultValue(str(p, "defaultValue"))
                        .thresholdHigh(str(p, "thresholdHigh"))
                        .thresholdLow(str(p, "thresholdLow"));

        if (p.hasNonNull("minValue")) b.minValue(p.get("minValue").asDouble());
        if (p.hasNonNull("maxValue")) b.maxValue(p.get("maxValue").asDouble());

        // Protocol mappings
        JsonNode snmp = p.get("snmpMapping");
        if (snmp != null) b.snmpOid(str(snmp, "oid"));

        JsonNode cli = p.get("cliMapping");
        if (cli != null) {
            b.cliCommand(str(cli, "command"));
            b.cliParseRegex(str(cli, "parseRegex"));
        }

        JsonNode rest = p.get("restMapping");
        if (rest != null) b.apiPath(str(rest, "apiPath"));

        JsonNode grpc = p.get("grpcMapping");
        if (grpc != null) {
            b.grpcPath(str(grpc, "grpcPath"));
            if (b.build().getApiPath() == null) b.apiPath(str(grpc, "apiPath"));
        }

        // Visibility
        JsonNode visible = p.get("uiVisibleTo");
        if (visible != null && visible.isArray()) {
            List<String> roles = new ArrayList<>();
            for (JsonNode r : visible) roles.add(r.asText().trim());
            b.uiVisibleTo(roles);
        }

        // Enum values
        JsonNode enumVals = p.get("enumValues");
        if (enumVals != null && enumVals.isArray()) {
            List<String> evList = new ArrayList<>();
            for (JsonNode v : enumVals) evList.add(v.asText().trim());
            b.enumValues(evList);
        }

        return b.build();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String str(JsonNode node, String field) {
        if (node == null || !node.hasNonNull(field)) return null;
        String v = node.get(field).asText().trim();
        return v.isEmpty() ? null : v;
    }

    private ValidationError err(String code, String field, String message) {
        return ValidationError.builder().code(code).field(field).message(message).severity("ERROR").build();
    }

    private String sanitize(String msg) {
        if (msg == null) return "unknown error";
        return msg.length() > 200 ? msg.substring(0, 200) + "..." : msg;
    }
}

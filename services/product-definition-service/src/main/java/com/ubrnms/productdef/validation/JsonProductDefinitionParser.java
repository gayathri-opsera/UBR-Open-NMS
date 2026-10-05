package com.ubrnms.productdef.validation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Parses a JSON Product Definition file into a {@link NormalizedProductDefinition}.
 *
 * <p>Supports two JSON layouts:
 * <ol>
 *   <li><b>NMS canonical format</b> — {@code "$schema"} + {@code "productDefinition"} wrapper
 *       with nested {@code identity}, {@code fingerprints}, {@code protocols[]}, and
 *       {@code parameters[]} (groupName / displayName naming).</li>
 *   <li><b>Client flat format</b> — no wrapper; top-level {@code vendor}, {@code model},
 *       {@code id} identity fields; {@code parameterGroups} array with {@code group} key;
 *       {@code protocols} as an object map; fingerprints with {@code match} instead of
 *       {@code sysDescrPattern}; data types {@code uint}/{@code ipv4}/{@code ipv6} etc.</li>
 * </ol>
 *
 * <p>The {@code "$schema"} field is validated as a WARNING (not ERROR) so client-supplied
 * files without it are still fully parsed.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class JsonProductDefinitionParser {

    public static final String REQUIRED_SCHEMA_URI = "urn:nms:productdef:json:1.0";

    // Maps client data-type aliases → NMS canonical types
    private static final Map<String, String> DATA_TYPE_ALIASES = Map.ofEntries(
            Map.entry("uint",       "INTEGER"),
            Map.entry("int",        "INTEGER"),
            Map.entry("integer",    "INTEGER"),
            Map.entry("unsigned",   "INTEGER"),
            Map.entry("unsigned32", "INTEGER"),
            Map.entry("ipv4",       "IPADDRESS"),
            Map.entry("ipv6",       "IPADDRESS"),
            Map.entry("ip",         "IPADDRESS"),
            Map.entry("str",        "STRING"),
            Map.entry("string",     "STRING"),
            Map.entry("text",       "STRING"),
            Map.entry("bool",       "BOOLEAN"),
            Map.entry("boolean",    "BOOLEAN"),
            Map.entry("float",      "FLOAT"),
            Map.entry("double",     "DOUBLE"),
            Map.entry("long",       "LONG"),
            Map.entry("enum",       "ENUM"),
            Map.entry("counter",    "COUNTER"),
            Map.entry("gauge",      "GAUGE"),
            Map.entry("counter32",  "COUNTER32"),
            Map.entry("counter64",  "COUNTER64"),
            Map.entry("gauge32",    "GAUGE32"),
            Map.entry("timeticks",  "TIMETICKS"),
            Map.entry("datetime",   "DATETIME"),
            Map.entry("oid",        "OID"),
            Map.entry("octetstring","OCTETSTRING")
    );

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

        // ── $schema check (WARNING only — parsing continues regardless) ──────
        JsonNode schemaNode = root.get("$schema");
        if (schemaNode == null || !REQUIRED_SCHEMA_URI.equals(schemaNode.asText())) {
            String found = schemaNode == null ? "(missing)" : schemaNode.asText();
            errors.add(ValidationError.builder()
                    .code("JSON_SCHEMA_URI_MISSING")
                    .field("$schema")
                    .message("Top-level \"$schema\" should be \"" + REQUIRED_SCHEMA_URI
                            + "\" (found: " + found + "). Add it for full NMS compliance.")
                    .severity("WARNING")
                    .build());
        }

        // ── productDefinition wrapper — fall back to root for client-format files ──
        JsonNode defNode = root.get("productDefinition");
        if (defNode == null || defNode.isNull() || !defNode.isObject()) {
            boolean hasIdentitySignals = root.hasNonNull("identity")
                    || root.hasNonNull("vendor")
                    || root.hasNonNull("name")
                    || root.hasNonNull("id")
                    || root.hasNonNull("model");
            if (hasIdentitySignals) {
                log.warn("No 'productDefinition' wrapper — treating root as definition (client-format file)");
                defNode = root;
            } else {
                errors.add(ValidationError.builder()
                        .code("MISSING_FIELD")
                        .field("productDefinition")
                        .message("Top-level \"productDefinition\" object is required")
                        .severity("ERROR")
                        .build());
                return null;
            }
        }

        NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder =
                NormalizedProductDefinition.builder();

        // Identity: canonical "identity" block OR flat top-level fields
        JsonNode identityNode = defNode.get("identity");
        if (identityNode != null && identityNode.isObject()) {
            parseIdentity(identityNode, builder, errors);
        } else {
            parseIdentityFlat(defNode, builder, errors);
        }

        parseLocation(defNode, builder);
        parseFingerprints(defNode.get("fingerprints"), builder, errors);
        parseProtocols(defNode, builder, errors);

        // Parameters: canonical "parameters" key OR client "parameterGroups" alias
        JsonNode paramsNode = defNode.get("parameters");
        if (paramsNode == null || !paramsNode.isArray()) paramsNode = defNode.get("parameterGroups");
        parseParameters(paramsNode, builder, errors);

        return builder.build();
    }

    // ── Location ──────────────────────────────────────────────────────────────

    /**
     * Parses optional GPS coordinates from a "location" block in the JSON.
     * Accepted layouts:
     * <pre>
     *   { "location": { "latitude": 17.385, "longitude": 78.486 } }
     *   { "location": { "lat": 17.385, "lon": 78.486 } }
     *   { "latitude": 17.385, "longitude": 78.486 }   // flat root
     * </pre>
     * Silently ignored if missing or unparseable — GPS is optional.
     */
    private void parseLocation(JsonNode defNode,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder) {
        // Try nested "location" block first, then flat root
        JsonNode loc = defNode.get("location");
        JsonNode src = (loc != null && loc.isObject()) ? loc : defNode;

        Double lat = nodeDouble(src, "latitude", "lat");
        Double lon = nodeDouble(src, "longitude", "lng", "lon");

        if (lat != null) builder.defaultLatitude(lat);
        if (lon != null) builder.defaultLongitude(lon);
    }

    /** Returns the first non-null numeric value for any of the given field aliases, or null. */
    private Double nodeDouble(JsonNode node, String... aliases) {
        for (String alias : aliases) {
            JsonNode n = node.get(alias);
            if (n != null && n.isNumber()) return n.doubleValue();
        }
        return null;
    }

    // ── Identity (canonical: nested "identity" object) ────────────────────────

    private void parseIdentity(JsonNode identity,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                List<ValidationError> errors) {
        builder.name(str(identity, "name"))
               .vendor(str(identity, "vendor"))
               .model(str(identity, "model"))
               .firmwareFrom(str(identity, "firmwareFrom"))
               .firmwareTo(str(identity, "firmwareTo"))
               .productFamily(str(identity, "productFamily"))
               .deviceType(str(identity, "deviceType"));
    }

    // ── Identity (client flat format: fields at root level) ───────────────────

    /**
     * Client files place identity fields at the top level without an "identity" wrapper:
     * <pre>
     * {
     *   "id":          "EOC640",                        // device model code
     *   "vendor":      "EOC",
     *   "model":       "EOC640 Wireless Backhaul Unit", // human-readable name
     *   "firmwareVer": "1.0"
     * }
     * </pre>
     * Mapping: name ← model (or id), vendor ← vendor, model ← id (or model).
     */
    private void parseIdentityFlat(JsonNode defNode,
                                    NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                    List<ValidationError> errors) {
        // "name" for NMS = the human-readable product name
        String name = str(defNode, "model");            // "EOC640 Wireless Backhaul Unit"
        if (name == null) name = str(defNode, "name");  // some files use "name" directly
        if (name == null) name = str(defNode, "id");    // last fallback

        // "model" for NMS = the short device model identifier
        String model = str(defNode, "id");              // "EOC640"
        if (model == null) model = str(defNode, "model");

        // firmware: "firmwareVer" is the client alias for "firmwareFrom"
        String firmwareFrom = str(defNode, "firmwareFrom");
        if (firmwareFrom == null) firmwareFrom = str(defNode, "firmwareVer");

        builder.name(name)
               .vendor(str(defNode, "vendor"))
               .model(model)
               .firmwareFrom(firmwareFrom)
               .firmwareTo(str(defNode, "firmwareTo"))
               .productFamily(str(defNode, "productFamily"))
               .deviceType(str(defNode, "deviceType"));
    }

    // ── Fingerprints ──────────────────────────────────────────────────────────

    /**
     * Supports both formats:
     * <ul>
     *   <li>Canonical: {@code {"sysObjectId": ".1.3.6.1.4.1...", "sysDescrPattern": "..."}}</li>
     *   <li>Client:    {@code {"type": "sshBanner", "match": "EOC640.*"}}</li>
     * </ul>
     */
    private void parseFingerprints(JsonNode node,
                                    NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                    List<ValidationError> errors) {
        if (node == null || !node.isArray()) {
            builder.fingerprints(List.of());
            return;
        }
        List<NormalizedProductDefinition.FingerprintEntry> list = new ArrayList<>();
        for (JsonNode fp : node) {
            // sysDescrPattern: canonical key first, then "match" (client format)
            String sysDescrPattern = str(fp, "sysDescrPattern");
            if (sysDescrPattern == null) sysDescrPattern = str(fp, "match");

            list.add(NormalizedProductDefinition.FingerprintEntry.builder()
                    .sysObjectId(str(fp, "sysObjectId"))   // may be null — validated as warning
                    .sysDescrPattern(sysDescrPattern)
                    .firmwareFrom(str(fp, "firmwareFrom"))
                    .firmwareTo(str(fp, "firmwareTo"))
                    .build());
        }
        builder.fingerprints(list);
    }

    // ── Protocols ─────────────────────────────────────────────────────────────

    /**
     * Supports both formats:
     * <ul>
     *   <li>Canonical array: {@code [{"type": "REST"}, {"type": "CLI"}]}</li>
     *   <li>Client object:   {@code {"primary": {"type": "rest"}, "fallback": {"type": "cli"}}}</li>
     * </ul>
     */
    private void parseProtocols(JsonNode defNode,
                                 NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                 List<ValidationError> errors) {
        JsonNode node = defNode.get("protocols");
        if (node == null) {
            builder.supportedProtocols(List.of());
            return;
        }

        List<String> types = new ArrayList<>();

        if (node.isArray()) {
            // Canonical format: [{"type": "REST"}, ...]
            for (JsonNode p : node) {
                String t = str(p, "type");
                if (t != null && !t.isBlank()) types.add(t.toUpperCase());
            }
        } else if (node.isObject()) {
            // Client format: {"primary": {"type": "rest"}, "fallback": {"type": "cli"}}
            node.fields().forEachRemaining(entry -> {
                JsonNode val = entry.getValue();
                if (val != null && val.isObject()) {
                    String t = str(val, "type");
                    if (t != null && !t.isBlank()) types.add(t.toUpperCase());
                }
            });
        }

        builder.supportedProtocols(types);
    }

    // ── Parameters ────────────────────────────────────────────────────────────

    /**
     * Supports both group-key formats:
     * <ul>
     *   <li>Canonical: {@code "groupName"}</li>
     *   <li>Client:    {@code "group"}</li>
     * </ul>
     */
    private void parseParameters(JsonNode node,
                                  NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                  List<ValidationError> errors) {
        if (node == null || !node.isArray()) {
            builder.parameterGroups(List.of());
            return;
        }
        List<NormalizedProductDefinition.ParameterGroup> groups = new ArrayList<>();
        for (JsonNode groupNode : node) {
            // groupName: canonical key first, then "group" (client format)
            String groupName = str(groupNode, "groupName");
            if (groupName == null) groupName = str(groupNode, "group");
            if (groupName == null || groupName.isBlank()) groupName = "default";

            JsonNode params = groupNode.get("parameters");
            List<NormalizedProductDefinition.ParameterEntry> entries = new ArrayList<>();
            if (params != null && params.isArray()) {
                // Track seen IDs within this group to detect and resolve duplicates.
                // Client files may reuse the same id across different subGroups
                // (e.g. "ipAddress" in "ip_configuration" and again in "dhcp2.4").
                // We qualify duplicate IDs with their subGroup to keep them unique.
                Set<String> seenIds = new HashSet<>();
                int order = 0;
                for (JsonNode p : params) {
                    order++;
                    String rawId    = str(p, "id");
                    String subGroup = str(p, "subGroup");
                    String resolvedId = rawId;
                    if (rawId != null && !seenIds.add(rawId)) {
                        // Duplicate: qualify with subGroup or a numeric suffix
                        String suffix = (subGroup != null && !subGroup.isBlank())
                                ? subGroup.replaceAll("[^a-zA-Z0-9]", "_")
                                : String.valueOf(seenIds.size());
                        resolvedId = suffix + "_" + rawId;
                        log.warn("Duplicate parameter id '{}' in group '{}' — resolved to '{}'",
                                rawId, groupName, resolvedId);
                        seenIds.add(resolvedId);
                    }
                    var entry = parseParameterNode(p, resolvedId);
                    entry.setDisplayOrder(order);
                    entries.add(entry);
                }
            }
            groups.add(NormalizedProductDefinition.ParameterGroup.builder()
                    .groupName(groupName)
                    .parameters(entries)
                    .build());
        }
        builder.parameterGroups(groups);
    }

    private NormalizedProductDefinition.ParameterEntry parseParameterNode(JsonNode p, String resolvedId) {
        // displayName: canonical key first, then "name" (client format)
        String displayName = str(p, "displayName");
        if (displayName == null) displayName = str(p, "name");

        // Normalize data type from client aliases to NMS canonical values
        String dataType = normalizeDataType(str(p, "dataType"));

        var b = NormalizedProductDefinition.ParameterEntry.builder()
                        .id(resolvedId)
                        .displayName(displayName)
                        .dataType(dataType)
                        .unit(str(p, "unit"))
                        .defaultValue(str(p, "defaultValue"))
                        .thresholdHigh(str(p, "thresholdHigh"))
                        .thresholdLow(str(p, "thresholdLow"))
                        .subGroup(str(p, "subGroup"))
                        .uiWidget(str(p, "uiWidget"))
                        .readOnly(p.hasNonNull("readOnly") ? Boolean.valueOf(p.get("readOnly").asText().trim()) : null);

        if (p.hasNonNull("minValue")) b.minValue(p.get("minValue").asDouble());
        if (p.hasNonNull("maxValue")) b.maxValue(p.get("maxValue").asDouble());

        // Protocol mappings (canonical format)
        JsonNode snmp = p.get("snmpMapping");
        String topOid = str(p, "oid");
        if (topOid == null) topOid = str(p, "snmpOid");
        String nestedOid = snmp != null ? str(snmp, "oid") : null;
        b.snmpOid(nestedOid != null ? nestedOid : topOid);

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

        // Visibility roles
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

    // ── Data-type normalisation ───────────────────────────────────────────────

    /**
     * Maps client-format data type aliases to NMS canonical uppercase type names.
     * Unknown types are passed through uppercased so validation can report them precisely.
     */
    private String normalizeDataType(String raw) {
        if (raw == null) return null;
        String canonical = DATA_TYPE_ALIASES.get(raw.toLowerCase());
        return canonical != null ? canonical : raw.toUpperCase();
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

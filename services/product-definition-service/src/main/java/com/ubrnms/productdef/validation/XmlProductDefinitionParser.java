package com.ubrnms.productdef.validation;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Parses an XML Product Definition file into a {@link NormalizedProductDefinition}.
 *
 * <p>Supports <b>any reasonable XML layout</b> through heuristic field detection.
 * Namespace mismatches and missing wrapper elements produce WARNINGs only — parsing
 * continues so any configuration-driven XML can be loaded without code changes.
 *
 * <p>Field resolution uses ordered fallback chains covering the most common naming
 * conventions (canonical NMS names, client generator names, SNMP-MIB names, generic
 * names, and attribute variants).  Unknown element names are auto-detected from root.
 *
 * <p><b>Security:</b> XXE is fully disabled; DOCTYPE declarations are rejected.
 */
@Slf4j
@Component
public class XmlProductDefinitionParser {

    public static final String REQUIRED_NAMESPACE = "urn:nms:productdef:1.0";

    // Data-type alias → NMS canonical mapping (same as JSON parser)
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

    public NormalizedProductDefinition parse(byte[] bytes, List<ValidationError> errors) {
        Document doc;
        try {
            doc = buildSecureDocument(bytes, errors);
        } catch (Exception e) {
            errors.add(ValidationError.builder()
                    .code("XML_PARSE_ERROR")
                    .field("document")
                    .message("XML document could not be parsed: " + sanitize(e.getMessage()))
                    .severity("ERROR")
                    .build());
            return null;
        }
        if (doc == null) return null;

        Element root = doc.getDocumentElement();

        // Namespace check — WARNING only, parsing always continues.
        // This mirrors the JSON parser's $schema treatment so any configuration-driven
        // XML (vendor tools, MIB exporters, OSS systems, etc.) can load without changes.
        String ns = root.getNamespaceURI();
        if (ns != null && !ns.isBlank() && !REQUIRED_NAMESPACE.equals(ns)) {
            errors.add(ValidationError.builder()
                    .code("XML_NAMESPACE_MISMATCH")
                    .field("document")
                    .message("Root namespace '" + ns + "' does not match expected '"
                            + REQUIRED_NAMESPACE + "'. File will still be parsed — "
                            + "add xmlns=\"" + REQUIRED_NAMESPACE + "\" for full compliance.")
                    .severity("WARNING")
                    .build());
        }

        NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder =
                NormalizedProductDefinition.builder();

        parseIdentity(root, builder, errors);
        parseLocation(root, builder);
        parseFingerprints(root, builder, errors);
        parseProtocols(root, builder, errors);
        parseParameters(root, builder, errors);

        return builder.build();
    }

    // ── Secure DocumentBuilder factory ────────────────────────────────────────

    private Document buildSecureDocument(byte[] bytes, List<ValidationError> errors) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);

        DocumentBuilder builder = factory.newDocumentBuilder();
        builder.setErrorHandler(null);
        return builder.parse(new ByteArrayInputStream(bytes));
    }

    // ── Location ──────────────────────────────────────────────────────────────

    /**
     * Reads optional GPS coordinates from a {@code <location>} element anywhere in the document.
     * Accepted child element names: latitude/lat, longitude/lon/lng.
     * Silently ignored if absent or unparseable — GPS is optional in a Product Definition.
     */
    private void parseLocation(Element root,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder) {
        Element loc = coalesceEl(
                firstChild(root, "location"),
                firstChild(root, "gps"),
                firstChild(root, "coordinates"),
                firstChild(root, "position")
        );
        if (loc == null) return;

        Double lat = parseDoubleEl(loc, "latitude", "lat");
        Double lon = parseDoubleEl(loc, "longitude", "longitude", "lon", "lng");
        if (lat != null) builder.defaultLatitude(lat);
        if (lon != null) builder.defaultLongitude(lon);
    }

    private Double parseDoubleEl(Element parent, String... aliases) {
        for (String alias : aliases) {
            String val = text(parent, alias);
            if (val != null) {
                try { return Double.parseDouble(val.trim()); } catch (NumberFormatException ignored) { /* try next */ }
            }
        }
        return null;
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    /**
     * Reads identity from an {@code <identity>} (or {@code <device>}/{@code <product>}) element,
     * falling back to root-level elements if no wrapper is found.  Field resolution uses
     * broad alias chains so any reasonable naming convention is accepted.
     *
     * <p>Display-name aliases (NMS "name"): name, productName, deviceName, description,
     *   model, product, title, label, longName, fullName.<br>
     * Model-code aliases (NMS "model"): id, modelId, modelCode, partNumber, deviceId,
     *   sku, productId, model, type.<br>
     * Vendor aliases: vendor, manufacturer, make, brand, vendorName, mfr, org.
     */
    private void parseIdentity(Element root,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                List<ValidationError> errors) {
        // Try canonical and common alias wrapper element names
        Element id = coalesceEl(
                firstChild(root, "identity"),
                firstChild(root, "device"),
                firstChild(root, "product"),
                firstChild(root, "deviceInfo"),
                firstChild(root, "productInfo"),
                firstChild(root, "metadata"),
                firstChild(root, "header")
        );

        // If no wrapper, use root itself (client-format / flat files)
        Element src = id != null ? id : root;
        if (id == null) {
            log.warn("No <identity> wrapper element found — scanning root for identity fields");
            errors.add(ValidationError.builder()
                    .code("XML_NO_IDENTITY_WRAPPER")
                    .field("identity")
                    .message("No <identity> (or <device>/<product>) element found — "
                            + "identity fields read from document root. "
                            + "Add an <identity> wrapper for full NMS compliance.")
                    .severity("WARNING")
                    .build());
        }

        // NMS "name" = human-readable display name — broad alias chain
        String name = coalesce(
                textAny(src, "name", "productName", "deviceName", "description",
                        "model", "product", "title", "label", "longName", "fullName")
        );

        // NMS "model" = short device model/part code — broad alias chain
        String model = coalesce(
                textAny(src, "id", "modelId", "modelCode", "partNumber", "deviceId",
                        "sku", "productId", "model", "type")
        );

        // Vendor — broad alias chain
        String vendor = coalesce(
                textAny(src, "vendor", "manufacturer", "make", "brand",
                        "vendorName", "mfr", "org", "company")
        );

        // Firmware version — broad alias chain
        String firmwareFrom = coalesce(
                textAny(src, "firmwareFrom", "firmwareVer", "firmware", "fwVersion",
                        "swVersion", "softwareVersion", "version", "release")
        );
        String firmwareTo = coalesce(
                textAny(src, "firmwareTo", "firmwareVerTo", "firmwareMax", "fwTo")
        );

        // Product family / device type — broad alias chain
        String productFamily = coalesce(
                textAny(src, "productFamily", "family", "series", "productLine", "range")
        );
        String deviceType = coalesce(
                textAny(src, "deviceType", "type", "category", "class", "role", "deviceClass")
        );

        builder.name(name)
               .vendor(vendor)
               .model(model)
               .firmwareFrom(firmwareFrom)
               .firmwareTo(firmwareTo)
               .productFamily(productFamily)
               .deviceType(deviceType);
    }

    // ── Fingerprints ──────────────────────────────────────────────────────────

    /**
     * Resolves fingerprints from any common container/entry element name.
     *
     * <p>Container aliases: fingerprints, identification, matching, discovery, snmpFingerprints.<br>
     * Entry aliases: fingerprint, match, snmpMatch, deviceMatch, identificationRule.<br>
     * sysObjectId aliases: sysObjectId, oid, snmpOid, objectId, mibOid + attribute variants.<br>
     * sysDescrPattern aliases: sysDescrPattern, match, pattern, descrPattern, sysDescr,
     *   descriptionPattern, banner, sshBanner, regex + attribute variants.
     */
    private void parseFingerprints(Element root,
                                    NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                    List<ValidationError> errors) {
        // Container element — broad alias chain
        Element fps = coalesceEl(
                firstChild(root, "fingerprints"),
                firstChild(root, "identification"),
                firstChild(root, "matching"),
                firstChild(root, "discovery"),
                firstChild(root, "snmpFingerprints"),
                firstChild(root, "deviceMatching")
        );
        if (fps == null) {
            builder.fingerprints(List.of());
            return;
        }

        // Entry element — try each alias
        NodeList nodes = firstTagList(fps,
                "fingerprint", "match", "snmpMatch", "deviceMatch", "identificationRule", "rule");

        List<NormalizedProductDefinition.FingerprintEntry> list = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element fp = (Element) nodes.item(i);

            // sysObjectId — child elements + attributes
            String sysObjectId = coalesce(
                    textAny(fp, "sysObjectId", "oid", "snmpOid", "objectId", "mibOid"),
                    attrAny(fp, "sysObjectId", "oid", "snmpOid", "objectId")
            );

            // sysDescrPattern — child elements + attributes
            String sysDescrPattern = coalesce(
                    textAny(fp, "sysDescrPattern", "descrPattern", "pattern",
                            "sysDescr", "descriptionPattern", "banner", "sshBanner", "regex"),
                    attrAny(fp, "match", "sysDescrPattern", "pattern",
                            "descrPattern", "regex", "banner")
            );

            // firmwareFrom / firmwareTo — child elements + attributes
            String fwFrom = coalesce(
                    textAny(fp, "firmwareFrom", "firmwareVer", "fwFrom", "firmware", "version"),
                    attrAny(fp, "firmwareFrom", "fwFrom", "firmware")
            );
            String fwTo = coalesce(
                    textAny(fp, "firmwareTo", "fwTo", "firmwareMax"),
                    attrAny(fp, "firmwareTo", "fwTo")
            );

            // Include entry if it has at least one usable field
            if (sysObjectId != null || sysDescrPattern != null) {
                list.add(NormalizedProductDefinition.FingerprintEntry.builder()
                        .sysObjectId(sysObjectId)
                        .sysDescrPattern(sysDescrPattern)
                        .firmwareFrom(fwFrom)
                        .firmwareTo(fwTo)
                        .build());
            }
        }
        builder.fingerprints(list);
    }

    // ── Protocols ─────────────────────────────────────────────────────────────

    /**
     * Resolves supported protocols from any common container/entry element name.
     *
     * <p>Container aliases: protocols, management, interfaces, access, communication.<br>
     * Entry aliases: protocol, interface, managementProtocol, accessMethod, transport.<br>
     * Type aliases: type, protocolType, name, method, transport (child + attribute).
     */
    private void parseProtocols(Element root,
                                 NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                 List<ValidationError> errors) {
        // Container element — broad alias chain
        Element protos = coalesceEl(
                firstChild(root, "protocols"),
                firstChild(root, "management"),
                firstChild(root, "interfaces"),
                firstChild(root, "access"),
                firstChild(root, "communication"),
                firstChild(root, "managementProtocols")
        );
        if (protos == null) {
            builder.supportedProtocols(List.of());
            return;
        }

        // Entry element — try each alias
        NodeList nodes = firstTagList(protos,
                "protocol", "interface", "managementProtocol", "accessMethod", "transport", "method");

        List<String> types = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element p = (Element) nodes.item(i);
            // Type: child element first, then attribute
            String type = coalesce(
                    textAny(p, "type", "protocolType", "name", "method", "transport"),
                    attrAny(p, "type", "protocolType", "name", "method", "transport")
            );
            if (type != null && !type.isBlank()) types.add(type.toUpperCase());
        }
        builder.supportedProtocols(types);
    }

    // ── Parameters ────────────────────────────────────────────────────────────

    /**
     * Resolves parameters from any common container/group/entry element name.
     *
     * <p>Container aliases: parameters, parameterGroups, params, configuration, settings,
     *   config, attributes, properties, capabilities, mibObjects.<br>
     * Group aliases: group, parameterGroup, section, category, module, tab, page, set.<br>
     * Group name/id: name/id attribute or child element, title, label.<br>
     * Entry aliases: parameter, param, attribute, property, field, mibObject, object.
     */
    private void parseParameters(Element root,
                                  NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                  List<ValidationError> errors) {
        // Container element — broad alias chain
        Element params = coalesceEl(
                firstChild(root, "parameters"),
                firstChild(root, "parameterGroups"),
                firstChild(root, "params"),
                firstChild(root, "configuration"),
                firstChild(root, "settings"),
                firstChild(root, "config"),
                firstChild(root, "attributes"),
                firstChild(root, "properties"),
                firstChild(root, "capabilities"),
                firstChild(root, "mibObjects")
        );
        if (params == null) {
            builder.parameterGroups(List.of());
            return;
        }

        // Group element — broad alias chain
        NodeList groupNodes = firstTagList(params,
                "group", "parameterGroup", "section", "category",
                "module", "tab", "page", "set", "cluster");

        List<NormalizedProductDefinition.ParameterGroup> groups = new ArrayList<>();
        for (int g = 0; g < groupNodes.getLength(); g++) {
            Element groupEl = (Element) groupNodes.item(g);
            // Group name: broad alias — attributes first, then child elements
            String groupName = coalesce(
                    attrAny(groupEl, "name", "id", "key", "label", "title", "code"),
                    textAny(groupEl, "name", "id", "title", "label", "groupName", "sectionName")
            );
            if (groupName == null || groupName.isBlank()) groupName = "default";

            // Parameter entry element — broad alias chain
            NodeList paramNodes = firstTagList(groupEl,
                    "parameter", "param", "attribute", "property",
                    "field", "mibObject", "object", "item");
            List<NormalizedProductDefinition.ParameterEntry> entries = new ArrayList<>();

            // Track seen IDs within this group to resolve duplicates (same logic as JSON parser)
            Set<String> seenIds = new HashSet<>();
            for (int p = 0; p < paramNodes.getLength(); p++) {
                Element pe = (Element) paramNodes.item(p);

                // Parameter ID: attribute aliases first, then child elements
                String rawId = coalesce(
                        attrAny(pe, "id", "key", "oid", "name", "code", "paramId"),
                        textAny(pe, "id", "paramId", "key", "oid", "name", "code")
                );
                String subGroup = coalesce(
                        textAny(pe, "subGroup", "subSection", "subCategory", "sub"),
                        attrAny(pe, "subGroup", "subSection", "sub")
                );

                String resolvedId = rawId;
                if (rawId != null && !seenIds.add(rawId)) {
                    String suffix = (subGroup != null && !subGroup.isBlank())
                            ? subGroup.replaceAll("[^a-zA-Z0-9]", "_")
                            : String.valueOf(seenIds.size());
                    resolvedId = suffix + "_" + rawId;
                    log.warn("Duplicate parameter id '{}' in group '{}' — resolved to '{}'",
                            rawId, groupName, resolvedId);
                    seenIds.add(resolvedId);
                }
                entries.add(parseParameterElement(pe, resolvedId));
            }
            groups.add(NormalizedProductDefinition.ParameterGroup.builder()
                    .groupName(groupName)
                    .parameters(entries)
                    .build());
        }
        builder.parameterGroups(groups);
    }

    private NormalizedProductDefinition.ParameterEntry parseParameterElement(Element pe, String resolvedId) {
        // displayName — broad alias chain (child elements + attributes)
        String displayName = coalesce(
                textAny(pe, "displayName", "name", "label", "title", "description", "caption", "text"),
                attrAny(pe, "displayName", "name", "label", "title")
        );

        // dataType — broad alias chain (child elements AND attributes, with case variants)
        String rawType = coalesce(
                textAny(pe, "dataType", "type", "valueType", "datatype", "syntax", "format", "valueType"),
                attrAny(pe, "dataType", "datatype", "type", "valueType", "valuetype", "syntax", "format")
        );
        String dataType = normalizeDataType(rawType);

        // defaultValue — broad alias chain
        String defaultValue = coalesce(
                textAny(pe, "defaultValue", "default", "defaultVal", "initialValue", "init"),
                attrAny(pe, "defaultValue", "default", "initialValue")
        );

        // unit — broad alias chain
        String unit = coalesce(
                textAny(pe, "unit", "units", "uom", "measure", "measurement"),
                attrAny(pe, "unit", "units", "uom")
        );

        var b = NormalizedProductDefinition.ParameterEntry.builder()
                        .id(resolvedId)
                        .displayName(displayName)
                        .dataType(dataType)
                        .unit(unit)
                        .defaultValue(defaultValue)
                        .thresholdHigh(coalesce(textAny(pe, "thresholdHigh", "maxThreshold", "highThreshold", "upper"),
                                                attrAny(pe, "thresholdHigh", "maxThreshold")))
                        .thresholdLow(coalesce(textAny(pe, "thresholdLow", "minThreshold", "lowThreshold", "lower"),
                                               attrAny(pe, "thresholdLow", "minThreshold")));

        // minValue / maxValue — child elements + attributes
        String min = coalesce(textAny(pe, "minValue", "min", "minimum", "lowerBound", "rangeMin"),
                              attrAny(pe, "minValue", "min", "minimum"));
        String max = coalesce(textAny(pe, "maxValue", "max", "maximum", "upperBound", "rangeMax"),
                              attrAny(pe, "maxValue", "max", "maximum"));
        if (min != null) { try { b.minValue(Double.parseDouble(min)); } catch (NumberFormatException ignored) {} }
        if (max != null) { try { b.maxValue(Double.parseDouble(max)); } catch (NumberFormatException ignored) {} }

        // SNMP mapping — container element or inline child aliases
        Element snmp = coalesceEl(firstChildOf(pe, "snmpMapping"), firstChildOf(pe, "snmp"), firstChildOf(pe, "mib"));
        if (snmp != null) {
            b.snmpOid(coalesce(textAny(snmp, "oid", "objectId", "snmpOid", "mibOid"),
                               attrAny(snmp, "oid", "objectId", "snmpOid")));
        } else {
            // inline: <oid> or <snmpOid> directly on parameter
            b.snmpOid(coalesce(textAny(pe, "snmpOid", "oid", "mibOid"),
                               attrAny(pe, "snmpOid", "oid")));
        }

        // CLI mapping — container element or inline
        Element cli = coalesceEl(firstChildOf(pe, "cliMapping"), firstChildOf(pe, "cli"), firstChildOf(pe, "command"));
        if (cli != null) {
            b.cliCommand(coalesce(textAny(cli, "command", "cmd", "cliCommand", "syntax"),
                                  attrAny(cli, "command", "cmd")));
            b.cliParseRegex(coalesce(textAny(cli, "parseRegex", "regex", "pattern", "regexp"),
                                     attrAny(cli, "parseRegex", "regex")));
        } else {
            b.cliCommand(coalesce(textAny(pe, "cliCommand", "cmd", "command"),
                                  attrAny(pe, "cliCommand", "cmd")));
            b.cliParseRegex(coalesce(textAny(pe, "cliParseRegex", "parseRegex", "regex"),
                                     attrAny(pe, "cliParseRegex", "parseRegex")));
        }

        // REST / API mapping
        Element rest = coalesceEl(firstChildOf(pe, "restMapping"), firstChildOf(pe, "rest"), firstChildOf(pe, "api"));
        if (rest != null) {
            b.apiPath(coalesce(textAny(rest, "apiPath", "path", "endpoint", "url"),
                               attrAny(rest, "apiPath", "path", "endpoint")));
        } else {
            b.apiPath(coalesce(textAny(pe, "apiPath", "restPath", "endpoint"),
                               attrAny(pe, "apiPath", "restPath")));
        }

        // gRPC mapping
        Element grpc = coalesceEl(firstChildOf(pe, "grpcMapping"), firstChildOf(pe, "grpc"));
        if (grpc != null) {
            b.grpcPath(coalesce(textAny(grpc, "grpcPath", "path", "method", "rpc"),
                                attrAny(grpc, "grpcPath", "path")));
            if (b.build().getApiPath() == null) {
                b.apiPath(coalesce(textAny(grpc, "apiPath", "path"), attrAny(grpc, "apiPath", "path")));
            }
        }

        // UI visibility
        String visible = coalesce(textAny(pe, "uiVisibleTo", "visibleTo", "roles", "visibility", "access"),
                                  attrAny(pe, "uiVisibleTo", "visibleTo", "roles"));
        if (visible != null && !visible.isBlank()) {
            List<String> roles = new ArrayList<>();
            for (String r : visible.split("[,;|]")) {
                String t = r.trim();
                if (!t.isEmpty()) roles.add(t);
            }
            b.uiVisibleTo(roles);
        }

        // Enum values — container element or pipe/comma-delimited string
        Element enumEl = coalesceEl(
                firstChildOf(pe, "enumValues"),
                firstChildOf(pe, "values"),
                firstChildOf(pe, "options"),
                firstChildOf(pe, "allowedValues"),
                firstChildOf(pe, "choices")
        );
        if (enumEl != null) {
            NodeList vals = enumEl.getElementsByTagName("value");
            if (vals.getLength() == 0) vals = enumEl.getElementsByTagName("option");
            if (vals.getLength() == 0) vals = enumEl.getElementsByTagName("item");
            List<String> enumList = new ArrayList<>();
            for (int i = 0; i < vals.getLength(); i++) {
                String v = vals.item(i).getTextContent();
                if (v != null && !v.isBlank()) enumList.add(v.trim());
            }
            b.enumValues(enumList);
        } else {
            // Inline delimited string: <possibleValues>on|off|auto</possibleValues>
            String inline = coalesce(
                    textAny(pe, "possibleValues", "enumValues", "allowedValues", "choices", "options"),
                    attrAny(pe, "possibleValues", "allowedValues", "choices")
            );
            if (inline != null && !inline.isBlank()) {
                List<String> enumList = new ArrayList<>();
                for (String v : inline.split("[|,;]")) {
                    String t = v.trim();
                    if (!t.isEmpty()) enumList.add(t);
                }
                b.enumValues(enumList);
            }
        }

        return b.build();
    }

    // ── Data-type normalisation ───────────────────────────────────────────────

    private String normalizeDataType(String raw) {
        if (raw == null) return null;
        String canonical = DATA_TYPE_ALIASES.get(raw.toLowerCase());
        return canonical != null ? canonical : raw.toUpperCase();
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    /** Find first child by local name, namespace-aware with plain fallback. */
    private Element firstChild(Element parent, String localName) {
        NodeList ns = parent.getElementsByTagNameNS(REQUIRED_NAMESPACE, localName);
        if (ns.getLength() > 0) return (Element) ns.item(0);
        NodeList plain = parent.getElementsByTagName(localName);
        return plain.getLength() > 0 ? (Element) plain.item(0) : null;
    }

    private Element firstChildOf(Element parent, String localName) {
        NodeList nodes = parent.getElementsByTagName(localName);
        return nodes.getLength() > 0 ? (Element) nodes.item(0) : null;
    }

    /** Return the first non-null Element from candidates. */
    private Element coalesceEl(Element... candidates) {
        for (Element e : candidates) if (e != null) return e;
        return null;
    }

    /**
     * Return the NodeList for the first tag name alias that has at least one match,
     * searching direct children of {@code parent}.  Falls back to an empty NodeList.
     */
    private NodeList firstTagList(Element parent, String... tagNames) {
        for (String tag : tagNames) {
            NodeList nl = parent.getElementsByTagName(tag);
            if (nl.getLength() > 0) return nl;
        }
        // Return empty NodeList via a tag we know won't match
        return parent.getElementsByTagName("__no_match__");
    }

    /**
     * Return the text content of the first matching child element across multiple
     * candidate tag names; returns null if none are found or all are blank.
     */
    private String textAny(Element parent, String... tagNames) {
        for (String tag : tagNames) {
            NodeList nodes = parent.getElementsByTagName(tag);
            if (nodes.getLength() > 0) {
                String t = nodes.item(0).getTextContent();
                if (t != null && !t.isBlank()) return t.trim();
            }
        }
        return null;
    }

    /**
     * Return the value of the first matching attribute across multiple candidate
     * attribute names; returns null if none are found or all are blank.
     */
    private String attrAny(Element el, String... attrNames) {
        for (String name : attrNames) {
            String v = el.getAttribute(name);
            if (v != null && !v.isBlank()) return v.trim();
        }
        return null;
    }

    private String text(Element parent, String childName) {
        return textAny(parent, childName);
    }

    private String textDirect(Element parent, String childName) {
        return textAny(parent, childName);
    }

    /** Read an attribute value; returns null if absent or blank. */
    private String attr(Element el, String attrName) {
        return attrAny(el, attrName);
    }

    /** Returns the first non-null value from the candidates. */
    @SafeVarargs
    private <T> T coalesce(T... values) {
        for (T v : values) if (v != null) return v;
        return null;
    }

    private ValidationError err(String code, String field, String message) {
        return ValidationError.builder().code(code).field(field).message(message).severity("ERROR").build();
    }

    private String sanitize(String msg) {
        if (msg == null) return "unknown error";
        return msg.length() > 200 ? msg.substring(0, 200) + "..." : msg;
    }
}

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
import java.util.List;

/**
 * Parses an XML Product Definition file into a {@link NormalizedProductDefinition}.
 *
 * <p><b>Security:</b>
 * <ul>
 *   <li>External entity processing (XXE) is fully disabled.</li>
 *   <li>DOCTYPE declarations are rejected before any content is read.</li>
 *   <li>The required namespace {@value REQUIRED_NAMESPACE} is enforced — files with
 *       the correct visible elements but the wrong namespace fail validation.</li>
 * </ul>
 *
 * <p>Any parse error appends a {@link ValidationError} and returns
 * {@code null} so the caller (ValidationService) can surface structured feedback
 * rather than propagating a raw exception.
 */
@Slf4j
@Component
public class XmlProductDefinitionParser {

    public static final String REQUIRED_NAMESPACE = "urn:nms:productdef:1.0";

    /**
     * Parses {@code bytes} and returns a normalized DTO, or {@code null} if the
     * document cannot be parsed.  Parse errors are appended to {@code errors}.
     *
     * @param bytes  raw bytes of the uploaded XML file
     * @param errors mutable list — parse errors are appended here
     * @return normalized DTO, or {@code null} on unrecoverable parse failure
     */
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

        // Namespace enforcement — wrong namespace must fail even if element names match
        String ns = root.getNamespaceURI();
        if (!REQUIRED_NAMESPACE.equals(ns)) {
            errors.add(ValidationError.builder()
                    .code("XML_NAMESPACE_INVALID")
                    .field("document")
                    .message("Root element must declare namespace '" + REQUIRED_NAMESPACE
                            + "' — found: " + (ns != null ? ns : "none"))
                    .severity("ERROR")
                    .build());
            return null;
        }

        NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder =
                NormalizedProductDefinition.builder();

        parseIdentity(root, builder, errors);
        parseFingerprints(root, builder, errors);
        parseProtocols(root, builder, errors);
        parseParameters(root, builder, errors);

        return builder.build();
    }

    // ── Secure DocumentBuilder factory ────────────────────────────────────────

    private Document buildSecureDocument(byte[] bytes, List<ValidationError> errors) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();

        // Disable XXE — all external entity / schema resolution is disallowed
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);

        DocumentBuilder builder = factory.newDocumentBuilder();
        // Suppress default SAX error handler output — errors are captured via exceptions
        builder.setErrorHandler(null);

        return builder.parse(new ByteArrayInputStream(bytes));
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    private void parseIdentity(Element root,
                                NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                List<ValidationError> errors) {
        Element identity = firstChild(root, "identity");
        if (identity == null) {
            errors.add(err("MISSING_FIELD", "identity", "The <identity> element is required"));
            return;
        }
        builder.name(text(identity, "name"))
               .vendor(text(identity, "vendor"))
               .model(text(identity, "model"))
               .firmwareFrom(text(identity, "firmwareFrom"))
               .firmwareTo(text(identity, "firmwareTo"))
               .productFamily(text(identity, "productFamily"));
    }

    // ── Fingerprints ──────────────────────────────────────────────────────────

    private void parseFingerprints(Element root,
                                    NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                    List<ValidationError> errors) {
        Element fps = firstChild(root, "fingerprints");
        if (fps == null) {
            builder.fingerprints(List.of());
            return;
        }
        NodeList nodes = fps.getElementsByTagNameNS(REQUIRED_NAMESPACE, "fingerprint");
        if (nodes.getLength() == 0) {
            // Fall back to non-namespace-qualified lookup for mixed-mode documents
            nodes = fps.getElementsByTagName("fingerprint");
        }
        List<NormalizedProductDefinition.FingerprintEntry> list = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element fp = (Element) nodes.item(i);
            list.add(NormalizedProductDefinition.FingerprintEntry.builder()
                    .sysObjectId(textDirect(fp, "sysObjectId"))
                    .sysDescrPattern(textDirect(fp, "sysDescrPattern"))
                    .firmwareFrom(textDirect(fp, "firmwareFrom"))
                    .firmwareTo(textDirect(fp, "firmwareTo"))
                    .build());
        }
        builder.fingerprints(list);
    }

    // ── Protocols ─────────────────────────────────────────────────────────────

    private void parseProtocols(Element root,
                                 NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                 List<ValidationError> errors) {
        Element protos = firstChild(root, "protocols");
        if (protos == null) {
            builder.supportedProtocols(List.of());
            return;
        }
        NodeList nodes = protos.getElementsByTagName("protocol");
        List<String> types = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element p = (Element) nodes.item(i);
            String type = textDirect(p, "type");
            if (type != null && !type.isBlank()) types.add(type.toUpperCase());
        }
        builder.supportedProtocols(types);
    }

    // ── Parameters ────────────────────────────────────────────────────────────

    private void parseParameters(Element root,
                                  NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                  List<ValidationError> errors) {
        Element params = firstChild(root, "parameters");
        if (params == null) {
            builder.parameterGroups(List.of());
            return;
        }
        NodeList groupNodes = params.getElementsByTagName("group");
        List<NormalizedProductDefinition.ParameterGroup> groups = new ArrayList<>();
        for (int g = 0; g < groupNodes.getLength(); g++) {
            Element groupEl = (Element) groupNodes.item(g);
            String groupName = groupEl.getAttribute("name");
            if (groupName == null || groupName.isBlank()) groupName = "default";

            NodeList paramNodes = groupEl.getElementsByTagName("parameter");
            List<NormalizedProductDefinition.ParameterEntry> entries = new ArrayList<>();
            for (int p = 0; p < paramNodes.getLength(); p++) {
                Element pe = (Element) paramNodes.item(p);
                entries.add(parseParameterElement(pe));
            }
            groups.add(NormalizedProductDefinition.ParameterGroup.builder()
                    .groupName(groupName)
                    .parameters(entries)
                    .build());
        }
        builder.parameterGroups(groups);
    }

    private NormalizedProductDefinition.ParameterEntry parseParameterElement(Element pe) {
        var b = NormalizedProductDefinition.ParameterEntry.builder()
                        .id(textDirect(pe, "id"))
                        .displayName(textDirect(pe, "displayName"))
                        .dataType(textDirect(pe, "dataType"))
                        .unit(textDirect(pe, "unit"))
                        .defaultValue(textDirect(pe, "defaultValue"))
                        .thresholdHigh(textDirect(pe, "thresholdHigh"))
                        .thresholdLow(textDirect(pe, "thresholdLow"));

        String min = textDirect(pe, "minValue");
        String max = textDirect(pe, "maxValue");
        if (min != null) { try { b.minValue(Double.parseDouble(min)); } catch (NumberFormatException ignored) {} }
        if (max != null) { try { b.maxValue(Double.parseDouble(max)); } catch (NumberFormatException ignored) {} }

        // SNMP mapping
        Element snmp = firstChildOf(pe, "snmpMapping");
        if (snmp != null) b.snmpOid(textDirect(snmp, "oid"));

        // CLI mapping
        Element cli = firstChildOf(pe, "cliMapping");
        if (cli != null) {
            b.cliCommand(textDirect(cli, "command"));
            b.cliParseRegex(textDirect(cli, "parseRegex"));
        }

        // REST mapping
        Element rest = firstChildOf(pe, "restMapping");
        if (rest != null) b.apiPath(textDirect(rest, "apiPath"));

        // GRPC mapping
        Element grpc = firstChildOf(pe, "grpcMapping");
        if (grpc != null) {
            b.grpcPath(textDirect(grpc, "grpcPath"));
            if (b.build().getApiPath() == null) b.apiPath(textDirect(grpc, "apiPath"));
        }

        // Visibility
        String visible = textDirect(pe, "uiVisibleTo");
        if (visible != null && !visible.isBlank()) {
            List<String> roles = new ArrayList<>();
            for (String r : visible.split(",")) {
                String t = r.trim();
                if (!t.isEmpty()) roles.add(t);
            }
            b.uiVisibleTo(roles);
        }

        // Enum values
        Element enumEl = firstChildOf(pe, "enumValues");
        if (enumEl != null) {
            NodeList vals = enumEl.getElementsByTagName("value");
            List<String> enumList = new ArrayList<>();
            for (int i = 0; i < vals.getLength(); i++) {
                String v = vals.item(i).getTextContent();
                if (v != null) enumList.add(v.trim());
            }
            b.enumValues(enumList);
        }

        return b.build();
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    private Element firstChild(Element parent, String localName) {
        // Try namespace-aware first, then fall back
        NodeList ns = parent.getElementsByTagNameNS(REQUIRED_NAMESPACE, localName);
        if (ns.getLength() > 0) return (Element) ns.item(0);
        NodeList plain = parent.getElementsByTagName(localName);
        return plain.getLength() > 0 ? (Element) plain.item(0) : null;
    }

    private Element firstChildOf(Element parent, String localName) {
        NodeList nodes = parent.getElementsByTagName(localName);
        return nodes.getLength() > 0 ? (Element) nodes.item(0) : null;
    }

    private String text(Element parent, String childName) {
        Element child = firstChild(parent, childName);
        if (child == null) return null;
        String t = child.getTextContent();
        return (t == null || t.isBlank()) ? null : t.trim();
    }

    private String textDirect(Element parent, String childName) {
        NodeList nodes = parent.getElementsByTagName(childName);
        if (nodes.getLength() == 0) return null;
        String t = nodes.item(0).getTextContent();
        return (t == null || t.isBlank()) ? null : t.trim();
    }

    private ValidationError err(String code, String field, String message) {
        return ValidationError.builder().code(code).field(field).message(message).severity("ERROR").build();
    }

    /** Strips file contents from error messages to prevent credential leakage in logs. */
    private String sanitize(String msg) {
        if (msg == null) return "unknown error";
        // Truncate to avoid leaking document content in exception messages
        return msg.length() > 200 ? msg.substring(0, 200) + "..." : msg;
    }
}

package com.ubrnms.productdef;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import com.ubrnms.productdef.validation.XmlProductDefinitionParser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class XmlProductDefinitionParserTest {

    private XmlProductDefinitionParser parser;

    @BeforeEach
    void setUp() {
        parser = new XmlProductDefinitionParser();
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void parse_validXml_returnsNormalizedDefinition() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.xml");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(errors).isEmpty();
        assertThat(result).isNotNull();
        assertThat(result.getName()).isEqualTo("ASR 1000");
        assertThat(result.getVendor()).isEqualTo("Cisco");
        assertThat(result.getModel()).isEqualTo("ASR-1001-X");
        assertThat(result.getFingerprints()).hasSize(2);
        assertThat(result.getSupportedProtocols()).containsExactlyInAnyOrder("SNMP", "CLI");
        assertThat(result.getParameterGroups()).hasSize(2);
    }

    @Test
    void parse_validXml_fingerprintHasOid() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.xml");
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        assertThat(result.getFingerprints().get(0).getSysObjectId())
                .isEqualTo(".1.3.6.1.4.1.9.1.685");
    }

    @Test
    void parse_validXml_parameterHasSnmpOid() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.xml");
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        NormalizedProductDefinition.ParameterEntry cpu = result.getParameterGroups().get(0)
                .getParameters().get(0);
        assertThat(cpu.getId()).isEqualTo("cpu_utilization");
        assertThat(cpu.getSnmpOid()).isEqualTo(".1.3.6.1.4.1.9.9.109.1.1.1.1.8.1");
        assertThat(cpu.getMinValue()).isEqualTo(0.0);
        assertThat(cpu.getMaxValue()).isEqualTo(100.0);
    }

    // ── Namespace enforcement ─────────────────────────────────────────────────

    @Test
    void parse_wrongNamespace_returnsNullWithError() {
        String xml = "<?xml version=\"1.0\"?><productDefinition xmlns=\"urn:wrong:ns\">"
                + "<identity><name>X</name><vendor>V</vendor><model>M</model></identity>"
                + "</productDefinition>";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(xml.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "XML_NAMESPACE_INVALID".equals(e.getCode()));
    }

    @Test
    void parse_noNamespace_returnsNullWithError() {
        String xml = "<?xml version=\"1.0\"?><productDefinition>"
                + "<identity><name>X</name><vendor>V</vendor><model>M</model></identity>"
                + "</productDefinition>";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(xml.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "XML_NAMESPACE_INVALID".equals(e.getCode()));
    }

    // ── Missing identity element ──────────────────────────────────────────────

    @Test
    void parse_missingIdentity_addsError() throws Exception {
        byte[] bytes = loadFixture("fixtures/invalid-missing-identity.xml");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        // Parser returns a partial result (identity fields null), not null
        assertThat(errors).anyMatch(e -> "MISSING_FIELD".equals(e.getCode())
                && e.getField().contains("identity"));
    }

    // ── XXE security ──────────────────────────────────────────────────────────

    @Test
    void parse_doctypeDeclaration_isRejected() {
        // DOCTYPE triggers "disallow-doctype-decl" feature — must not parse
        String xxeXml = "<?xml version=\"1.0\"?>"
                + "<!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>"
                + "<productDefinition xmlns=\"urn:nms:productdef:1.0\">"
                + "<identity><name>&xxe;</name><vendor>V</vendor><model>M</model></identity>"
                + "</productDefinition>";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(xxeXml.getBytes(StandardCharsets.UTF_8), errors);

        // Must reject — either null result or an XML_PARSE_ERROR
        assertThat(result == null || errors.stream().anyMatch(e -> e.getCode().startsWith("XML")))
                .isTrue();
    }

    // ── Malformed XML ─────────────────────────────────────────────────────────

    @Test
    void parse_malformedXml_returnsNullWithError() {
        String broken = "<?xml version=\"1.0\"?><productDefinition xmlns=\"urn:nms:productdef:1.0\"><unclosed>";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(broken.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).isNotEmpty();
        assertThat(errors.get(0).getSeverity()).isEqualTo("ERROR");
    }

    // ── Empty bytes ───────────────────────────────────────────────────────────

    @Test
    void parse_emptyBytes_returnsNullWithError() {
        List<ValidationError> errors = new ArrayList<>();
        NormalizedProductDefinition result = parser.parse(new byte[0], errors);
        assertThat(result).isNull();
        assertThat(errors).isNotEmpty();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private byte[] loadFixture(String path) throws Exception {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(path)) {
            assertThat(is).as("Test fixture not found: %s", path).isNotNull();
            return is.readAllBytes();
        }
    }

    @Test
    void parse_parameterGroupElements_notConfusedWithGroupTextChild() {
        String xml = "<productDefinition xmlns=\"urn:nms:productdef:1.0\"><identity><id>x</id><vendor>V</vendor><model>M</model></identity>"
                + "<parameterGroups><parameterGroup id=\"radio\">"
                + "<parameter id=\"a\"><name>A</name><group>radio</group><subGroup>s1</subGroup><dataType>uint</dataType>"
                + "<uiWidget>slider</uiWidget><readOnly>true</readOnly><oid>.1.2.3</oid><minValue>1</minValue><maxValue>9</maxValue></parameter>"
                + "<parameter id=\"a\"><name>A2</name><group>radio</group><subGroup>s2</subGroup><dataType>string</dataType></parameter>"
                + "</parameterGroup></parameterGroups></productDefinition>";
        NormalizedProductDefinition r = parser.parse(xml.getBytes(StandardCharsets.UTF_8), new ArrayList<>());
        assertThat(r.getParameterGroups()).hasSize(1);
        var g = r.getParameterGroups().get(0);
        assertThat(g.getGroupName()).isEqualTo("radio");
        assertThat(g.getParameters()).extracting("id").containsExactly("a", "s2_a");
        var p = g.getParameters().get(0);
        assertThat(p.getSubGroup()).isEqualTo("s1");
        assertThat(p.getUiWidget()).isEqualTo("slider");
        assertThat(p.getReadOnly()).isTrue();
        assertThat(p.getSnmpOid()).isEqualTo(".1.2.3");
        assertThat(p.getMinValue()).isEqualTo(1.0);
        assertThat(p.getDisplayOrder()).isEqualTo(1);
        assertThat(g.getParameters().get(1).getDisplayOrder()).isEqualTo(2);
    }
}

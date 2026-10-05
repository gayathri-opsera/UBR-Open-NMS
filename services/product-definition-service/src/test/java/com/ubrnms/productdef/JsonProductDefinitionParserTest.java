package com.ubrnms.productdef;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import com.ubrnms.productdef.validation.JsonProductDefinitionParser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class JsonProductDefinitionParserTest {

    private JsonProductDefinitionParser parser;

    @BeforeEach
    void setUp() {
        ObjectMapper om = new ObjectMapper().registerModule(new JavaTimeModule());
        parser = new JsonProductDefinitionParser(om);
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void parse_validJson_returnsNormalizedDefinition() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.json");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(errors).isEmpty();
        assertThat(result).isNotNull();
        assertThat(result.getName()).isEqualTo("Radio 4480");
        assertThat(result.getVendor()).isEqualTo("Ericsson");
        assertThat(result.getModel()).isEqualTo("AIR 4480");
        assertThat(result.getFingerprints()).hasSize(1);
        assertThat(result.getSupportedProtocols()).containsExactlyInAnyOrder("SNMP", "REST");
    }

    @Test
    void parse_validJson_parameterWithEnumValues() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.json");
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        NormalizedProductDefinition.ParameterEntry bandMode = result.getParameterGroups().get(0)
                .getParameters().get(1);
        assertThat(bandMode.getId()).isEqualTo("band_mode");
        assertThat(bandMode.getDataType()).isEqualTo("ENUM");
        assertThat(bandMode.getEnumValues()).containsExactly("FDD", "TDD");
    }

    @Test
    void parse_validJson_parameterNumericRange() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.json");
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        NormalizedProductDefinition.ParameterEntry rsrp = result.getParameterGroups().get(0)
                .getParameters().get(0);
        assertThat(rsrp.getMinValue()).isEqualTo(-140.0);
        assertThat(rsrp.getMaxValue()).isEqualTo(-44.0);
    }

    // ── Schema URI enforcement ────────────────────────────────────────────────

    @Test
    void parse_wrongSchemaUri_returnsNullWithError() throws Exception {
        byte[] bytes = loadFixture("fixtures/invalid-wrong-schema.json");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "JSON_SCHEMA_URI_INVALID".equals(e.getCode()));
    }

    @Test
    void parse_missingSchemaField_returnsNullWithError() {
        String json = "{\"productDefinition\":{\"identity\":{\"name\":\"X\",\"vendor\":\"V\",\"model\":\"M\"}}}";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(json.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "JSON_SCHEMA_URI_INVALID".equals(e.getCode()));
    }

    // ── Missing productDefinition root ────────────────────────────────────────

    @Test
    void parse_missingProductDefinitionRoot_returnsNullWithError() {
        String json = "{\"$schema\":\"urn:nms:productdef:json:1.0\"}";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(json.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "MISSING_FIELD".equals(e.getCode()));
    }

    // ── Empty/malformed input ─────────────────────────────────────────────────

    @Test
    void parse_malformedJson_returnsNullWithError() {
        String broken = "{not valid json";
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(broken.getBytes(StandardCharsets.UTF_8), errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "JSON_PARSE_ERROR".equals(e.getCode()));
    }

    @Test
    void parse_emptyBytes_returnsNullWithError() {
        List<ValidationError> errors = new ArrayList<>();
        NormalizedProductDefinition result = parser.parse(new byte[0], errors);
        assertThat(result).isNull();
        assertThat(errors).isNotEmpty();
    }

    // ── Null/missing optional arrays ──────────────────────────────────────────

    @Test
    void parse_noFingerprints_returnsEmptyList() {
        String json = "{\"$schema\":\"urn:nms:productdef:json:1.0\","
                + "\"productDefinition\":{\"identity\":{\"name\":\"X\",\"vendor\":\"V\",\"model\":\"M\"}}}";
        NormalizedProductDefinition result = parser.parse(json.getBytes(StandardCharsets.UTF_8), new ArrayList<>());
        assertThat(result).isNotNull();
        assertThat(result.getFingerprints()).isEmpty();
        assertThat(result.getSupportedProtocols()).isEmpty();
        assertThat(result.getParameterGroups()).isEmpty();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private byte[] loadFixture(String path) throws Exception {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(path)) {
            assertThat(is).as("Test fixture not found: %s", path).isNotNull();
            return is.readAllBytes();
        }
    }

    @Test
    void parse_topLevelOidSubGroupUiWidgetReadOnly() {
        String json = "{\"id\":\"x\",\"vendor\":\"V\",\"model\":\"M\",\"parameterGroups\":[{\"group\":\"radio\",\"parameters\":["
                + "{\"id\":\"a\",\"dataType\":\"uint\",\"subGroup\":\"s1\",\"uiWidget\":\"slider\",\"readOnly\":true,\"oid\":\".1.2.3\"},"
                + "{\"id\":\"b\",\"dataType\":\"enum\",\"enumValues\":[\"Enable(0)\"],\"snmpMapping\":{\"oid\":\".1.2.4\"}}]}]}";
        NormalizedProductDefinition r = parser.parse(json.getBytes(java.nio.charset.StandardCharsets.UTF_8), new java.util.ArrayList<>());
        var ps = r.getParameterGroups().get(0).getParameters();
        assertThat(ps.get(0).getSnmpOid()).isEqualTo(".1.2.3");
        assertThat(ps.get(0).getSubGroup()).isEqualTo("s1");
        assertThat(ps.get(0).getUiWidget()).isEqualTo("slider");
        assertThat(ps.get(0).getReadOnly()).isTrue();
        assertThat(ps.get(0).getDisplayOrder()).isEqualTo(1);
        assertThat(ps.get(1).getSnmpOid()).isEqualTo(".1.2.4");
        assertThat(ps.get(1).getReadOnly()).isNull();
        assertThat(ps.get(1).getEnumValues()).containsExactly("Enable(0)");
    }
}

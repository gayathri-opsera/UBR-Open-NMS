package com.ubrnms.productdef;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.NormalizedProductDefinition.ParameterEntry;
import com.ubrnms.productdef.model.ParameterRegistryEntry;
import com.ubrnms.productdef.model.ValidationError;
import com.ubrnms.productdef.model.ValidationReport;
import com.ubrnms.productdef.service.ParameterRegistryBuilder;
import com.ubrnms.productdef.service.PublishGates;
import com.ubrnms.productdef.validation.JsonProductDefinitionParser;
import com.ubrnms.productdef.validation.ProductDefinitionValidationService;
import com.ubrnms.productdef.validation.XmlProductDefinitionParser;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.*;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** Loads the operator's real Configurations_GUI definition in both formats. */
class OperatorSampleDefinitionTest {

    private static byte[] load(String name) throws Exception {
        try (InputStream in = OperatorSampleDefinitionTest.class.getClassLoader()
                .getResourceAsStream("samples/" + name)) {
            assertThat(in).isNotNull();
            return in.readAllBytes();
        }
    }

    private static NormalizedProductDefinition parse(boolean xml) throws Exception {
        List<ValidationError> errors = new ArrayList<>();
        NormalizedProductDefinition d = xml
                ? new XmlProductDefinitionParser().parse(load("Configurations_GUI.xml"), errors)
                : new JsonProductDefinitionParser(new ObjectMapper()).parse(load("Configurations_GUI.json"), errors);
        assertThat(errors.stream().filter(e -> "ERROR".equals(e.getSeverity())).toList()).isEmpty();
        assertThat(d).isNotNull();
        return d;
    }

    private static void assertShape(NormalizedProductDefinition d) {
        assertThat(d.getParameterGroups()).extracting(NormalizedProductDefinition.ParameterGroup::getGroupName)
                .containsExactly("radio", "network");
        assertThat(d.getParameterGroups().get(0).getParameters()).hasSize(27);
        assertThat(d.getParameterGroups().get(1).getParameters()).hasSize(28);

        List<ParameterEntry> all = d.getParameterGroups().stream()
                .flatMap(g -> g.getParameters().stream()).toList();
        assertThat(all).hasSize(55);
        assertThat(all.stream().filter(p -> p.getSnmpOid() != null)).hasSize(53);
        assertThat(all.stream().filter(p -> p.getSnmpOid() == null).map(ParameterEntry::getId))
                .containsExactlyInAnyOrder("ofdma", "connectorizedAntennaGain");
        assertThat(all).allSatisfy(p -> {
            assertThat(p.getSubGroup()).isNotBlank();
            assertThat(p.getUiWidget()).isIn("dropdown", "textfield", "slider");
            assertThat(p.getReadOnly()).isFalse();
            assertThat(p.getDataType()).isIn("ENUM", "STRING", "INTEGER", "IPADDRESS");
            assertThat(p.getDisplayOrder()).isPositive();
        });
        for (var g : d.getParameterGroups()) {
            List<Integer> orders = g.getParameters().stream().map(ParameterEntry::getDisplayOrder).toList();
            assertThat(orders).isEqualTo(java.util.stream.IntStream.rangeClosed(1, orders.size()).boxed().toList());
            assertThat(g.getParameters().stream().map(ParameterEntry::getId).collect(Collectors.toSet()))
                    .hasSameSizeAs(g.getParameters());
        }
        assertThat(subCounts(d, "radio")).containsExactlyInAnyOrderEntriesOf(Map.of(
                "properties", 12L, "ddrs", 8L, "atpc", 3L, "aptc", 1L, "dcs", 3L));
        assertThat(subCounts(d, "network")).containsExactlyInAnyOrderEntriesOf(Map.of(
                "ip_configuration", 6L, "vlan", 10L, "ethernet", 2L, "dhcp", 4L, "dhcp_2_4", 6L));

        ParameterEntry radioStatus = d.getParameterGroups().get(0).getParameters().get(0);
        assertThat(radioStatus.getId()).isEqualTo("radioStatus");
        assertThat(radioStatus.getEnumValues()).containsExactly("Enable(0)", "Disable(1)");
        assertThat(radioStatus.getDefaultValue()).isEqualTo("Enable(0)");
        assertThat(radioStatus.getSnmpOid()).isEqualTo(".1.3.6.1.4.1.52619.1.1.1.1.1.33");

        assertThat(d.getFingerprints()).hasSize(2);
        assertThat(d.getSupportedProtocols()).containsExactly("REST", "CLI");
        assertThat(d.getVendor()).isEqualTo("EOC");
    }

    private static Map<String, Long> subCounts(NormalizedProductDefinition d, String group) {
        return d.getParameterGroups().stream().filter(g -> g.getGroupName().equals(group))
                .flatMap(g -> g.getParameters().stream())
                .collect(Collectors.groupingBy(ParameterEntry::getSubGroup, Collectors.counting()));
    }

    @Test
    void xml_sampleParsesExactly() throws Exception { assertShape(parse(true)); }

    @Test
    void json_sampleParsesExactly() throws Exception { assertShape(parse(false)); }

    @Test
    void xmlAndJson_yieldSameParameters() throws Exception {
        var x = parse(true).getParameterGroups();
        var j = parse(false).getParameterGroups();
        for (int g = 0; g < 2; g++) {
            var xp = x.get(g).getParameters();
            var jp = j.get(g).getParameters();
            assertThat(xp).hasSameSizeAs(jp);
            for (int i = 0; i < xp.size(); i++) {
                assertThat(xp.get(i)).usingRecursiveComparison().isEqualTo(jp.get(i));
            }
        }
    }

    @Test
    void bothSamples_passValidation() throws Exception {
        for (boolean xml : new boolean[]{true, false}) {
            NormalizedProductDefinition d = parse(xml);
            ValidationReport r = new ProductDefinitionValidationService()
                    .validate(d, "Configurations_GUI", "v1", "c");
            assertThat(r.getErrors()).as("validation errors xml=" + xml).isEmpty();
        }
    }

    @Test
    void registryBuilder_carriesAllFields() throws Exception {
        for (boolean xml : new boolean[]{true, false}) {
            List<ParameterRegistryEntry> es = new ParameterRegistryBuilder()
                    .build(parse(xml), "Configurations_GUI", "v1", 1L);
            assertThat(es).hasSize(55);
            assertThat(es.stream().filter(e -> e.getSnmpOid() != null)).hasSize(53);
            assertThat(es.stream().map(e -> e.getGroupId() + "/" + e.getParameterId()).distinct()).hasSize(55);
            assertThat(es).allSatisfy(e -> {
                assertThat(e.getSubGroup()).isNotBlank();
                assertThat(e.getUiWidget()).isNotBlank();
                assertThat(e.isReadOnly()).isFalse();
                assertThat(e.getDisplayOrder()).isPositive();
            });
        }
    }
}

package com.ubrnms.productdef;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ParameterRegistryEntry;
import com.ubrnms.productdef.service.ParameterRegistryBuilder;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.*;

class ParameterRegistryBuilderTest {

    private final ParameterRegistryBuilder builder = new ParameterRegistryBuilder();

    private static final String DEF_ID  = "ericsson-air-4480";
    private static final String VERSION = "v2";
    private static final long   REG_VER = 5L;

    private NormalizedProductDefinition.ParameterEntry param(String id, String dataType) {
        return NormalizedProductDefinition.ParameterEntry.builder()
                .id(id)
                .displayName("Display " + id)
                .dataType(dataType)
                .snmpOid("1.3.6.1.4.1.193." + id.hashCode())
                .uiVisibleTo(List.of("NMS_OPERATOR", "FRAMEWORK_ADMIN"))
                .thresholdHigh("100")
                .thresholdLow("0")
                .build();
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void build_singleGroup_singleParam_producesOneEntry() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("radio")
                                .parameters(List.of(param("rsrp", "FLOAT")))
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(1);
        ParameterRegistryEntry e = entries.get(0);
        assertThat(e.getGroupId()).isEqualTo("radio");
        assertThat(e.getParameterId()).isEqualTo("rsrp");
        assertThat(e.getDataType()).isEqualTo("FLOAT");
        assertThat(e.getProductDefinitionId()).isEqualTo(DEF_ID);
        assertThat(e.getVersionId()).isEqualTo(VERSION);
        assertThat(e.getRegistryVersion()).isEqualTo(REG_VER);
        assertThat(e.getThresholdHigh()).isEqualTo("100");
        assertThat(e.getUiVisibleTo()).containsExactly("NMS_OPERATOR", "FRAMEWORK_ADMIN");
    }

    @Test
    void build_multipleGroupsAndParams_producesAllEntries() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("radio")
                                .parameters(List.of(param("rsrp", "FLOAT"), param("sinr", "FLOAT")))
                                .build(),
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("cpu")
                                .parameters(List.of(param("load", "NUMERIC")))
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(3);
        assertThat(entries).extracting(ParameterRegistryEntry::getGroupId)
                .containsExactlyInAnyOrder("radio", "radio", "cpu");
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    @Test
    void build_nullParameterGroups_returnsEmpty() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480").parameterGroups(null).build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_emptyParameterGroups_returnsEmpty() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480").parameterGroups(List.of()).build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_groupWithNullGroupName_isSkipped() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName(null)
                                .parameters(List.of(param("rsrp", "FLOAT")))
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_duplicateParameterIdInSameGroup_skipsDuplicate() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("radio")
                                .parameters(List.of(
                                        param("rsrp", "FLOAT"),
                                        param("rsrp", "FLOAT"))) // duplicate
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        // Only one entry should be produced — the duplicate is skipped
        assertThat(entries).hasSize(1);
        assertThat(entries.get(0).getParameterId()).isEqualTo("rsrp");
    }

    @Test
    void build_paramWithNullId_isSkipped() {
        NormalizedProductDefinition.ParameterEntry noId = NormalizedProductDefinition.ParameterEntry.builder()
                .id(null).displayName("No ID").dataType("NUMERIC").build();

        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("cpu")
                                .parameters(List.of(noId))
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_emptyGroup_isSkipped() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("empty")
                                .parameters(List.of())
                                .build()))
                .build();

        List<ParameterRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_carriesSubGroupUiWidgetReadOnlyDisplayOrder() {
        var p = NormalizedProductDefinition.ParameterEntry.builder().id("a").dataType("INTEGER")
                .subGroup("vlan").uiWidget("slider").readOnly(true).displayOrder(7).build();
        var q = NormalizedProductDefinition.ParameterEntry.builder().id("b").dataType("INTEGER").build();
        NormalizedProductDefinition n = NormalizedProductDefinition.builder().parameterGroups(List.of(
                NormalizedProductDefinition.ParameterGroup.builder().groupName("g").parameters(List.of(p, q)).build())).build();
        List<ParameterRegistryEntry> es = builder.build(n, DEF_ID, VERSION, REG_VER);
        assertThat(es.get(0).getSubGroup()).isEqualTo("vlan");
        assertThat(es.get(0).getUiWidget()).isEqualTo("slider");
        assertThat(es.get(0).isReadOnly()).isTrue();
        assertThat(es.get(0).getDisplayOrder()).isEqualTo(7);
        assertThat(es.get(1).isReadOnly()).isFalse();
        assertThat(es.get(1).getDisplayOrder()).isEqualTo(2);
    }
}

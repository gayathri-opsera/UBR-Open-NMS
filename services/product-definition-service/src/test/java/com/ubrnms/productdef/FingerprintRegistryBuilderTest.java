package com.ubrnms.productdef;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.service.FingerprintRegistryBuilder;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.*;

class FingerprintRegistryBuilderTest {

    private final FingerprintRegistryBuilder builder = new FingerprintRegistryBuilder();

    private static final String DEF_ID    = "cisco-asr-1000";
    private static final String VERSION   = "v1";
    private static final long   REG_VER   = 3L;

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void build_singleOidFingerprint_producesOneEntry() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco")
                .model("ASR 1000")
                .firmwareFrom("15.1")
                .firmwareTo("17.3")
                .supportedProtocols(List.of("SNMP"))
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045")
                                .build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(1);
        FingerprintRegistryEntry e = entries.get(0);
        assertThat(e.getFingerprintType()).isEqualTo("SNMP_OID");
        assertThat(e.getFingerprintValue()).isEqualTo(".1.3.6.1.4.1.9.1.1045");
        assertThat(e.getProductDefinitionId()).isEqualTo(DEF_ID);
        assertThat(e.getVersionId()).isEqualTo(VERSION);
        assertThat(e.getRegistryVersion()).isEqualTo(REG_VER);
        assertThat(e.getFirmwareFrom()).isEqualTo("15.1");
        assertThat(e.getFirmwareTo()).isEqualTo("17.3");
        assertThat(e.getSupportedProtocols()).containsExactly("SNMP");
    }

    @Test
    void build_fingerprintWithSysDescrPattern_producesTwoEntries() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco")
                .model("ASR 1000")
                .firmwareFrom("15.1")
                .firmwareTo("17.3")
                .supportedProtocols(List.of("SNMP", "REST"))
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045")
                                .sysDescrPattern(".*Cisco ASR 1000.*")
                                .build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(2);
        assertThat(entries).extracting(FingerprintRegistryEntry::getFingerprintType)
                .containsExactlyInAnyOrder("SNMP_OID", "BANNER");
    }

    @Test
    void build_fingerprintLevelFirmwareRangeOverridesDefinitionLevel() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco")
                .model("ASR 1000")
                .firmwareFrom("15.0")
                .firmwareTo("17.9")
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045")
                                .firmwareFrom("16.0") // override
                                .firmwareTo("16.9")   // override
                                .build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(1);
        assertThat(entries.get(0).getFirmwareFrom()).isEqualTo("16.0");
        assertThat(entries.get(0).getFirmwareTo()).isEqualTo("16.9");
    }

    @Test
    void build_multipleFingerprints_producesOneEntryEach() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco")
                .model("ASR 1000")
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045").build(),
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1046").build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(2);
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    @Test
    void build_nullFingerprints_returnsEmpty() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco").model("ASR 1000").fingerprints(null).build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_emptyFingerprints_returnsEmpty() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco").model("ASR 1000").fingerprints(List.of()).build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_nullSysObjectId_skipsEntry() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco").model("ASR 1000")
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(null)
                                .sysDescrPattern(".*pattern.*")
                                .build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).isEmpty();
    }

    @Test
    void build_blankSysDescrPattern_doesNotProduceBannerEntry() {
        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Cisco").model("ASR 1000")
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045")
                                .sysDescrPattern("  ") // blank
                                .build()))
                .build();

        List<FingerprintRegistryEntry> entries = builder.build(normalized, DEF_ID, VERSION, REG_VER);

        assertThat(entries).hasSize(1);
        assertThat(entries.get(0).getFingerprintType()).isEqualTo("SNMP_OID");
    }
}

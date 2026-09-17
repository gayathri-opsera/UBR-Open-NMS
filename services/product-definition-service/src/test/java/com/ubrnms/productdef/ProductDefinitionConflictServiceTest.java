package com.ubrnms.productdef;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionActiveVersion;
import com.ubrnms.productdef.repository.FingerprintRegistryRepository;
import com.ubrnms.productdef.repository.ProductDefinitionActiveVersionRepository;
import com.ubrnms.productdef.service.ProductDefinitionConflictService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ProductDefinitionConflictServiceTest {

    @Mock private FingerprintRegistryRepository      fingerprintRepo;
    @Mock private ProductDefinitionActiveVersionRepository activeVersionRepo;

    private ProductDefinitionConflictService conflictService;

    private static final String DEF_ID       = "cisco-asr-1000";
    private static final String OTHER_DEF_ID = "juniper-mx240";

    @BeforeEach
    void setUp() {
        conflictService = new ProductDefinitionConflictService(fingerprintRepo, activeVersionRepo);
    }

    private NormalizedProductDefinition buildNormalized(
            String vendor, String model, String fwFrom, String fwTo, String oid) {
        return NormalizedProductDefinition.builder()
                .vendor(vendor)
                .model(model)
                .firmwareFrom(fwFrom)
                .firmwareTo(fwTo)
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(oid)
                                .build()))
                .parameterGroups(List.of())
                .supportedProtocols(List.of("SNMP"))
                .build();
    }

    // ── Happy path — no conflicts ─────────────────────────────────────────────

    @Test
    void detect_noConflicts_returnsEmptyResult() {
        when(fingerprintRepo.findByFingerprintValue(anyString())).thenReturn(List.of());
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        NormalizedProductDefinition normalized = buildNormalized("Cisco", "ASR 1000", "15.0", "17.0", ".1.2.3");

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect(DEF_ID, normalized);

        assertThat(result.hasConflicts()).isFalse();
        assertThat(result.conflicts()).isEmpty();
    }

    // ── Fingerprint conflicts ─────────────────────────────────────────────────

    @Test
    void detect_duplicateOidWithOverlappingFirmwareRange_reportsConflict() {
        FingerprintRegistryEntry existingEntry = FingerprintRegistryEntry.builder()
                .productDefinitionId(OTHER_DEF_ID)
                .fingerprintType("SNMP_OID")
                .fingerprintValue(".1.2.3")
                .firmwareFrom("15.0")
                .firmwareTo("17.0")
                .build();
        when(fingerprintRepo.findByFingerprintValue(".1.2.3")).thenReturn(List.of(existingEntry));
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        NormalizedProductDefinition normalized = buildNormalized("Cisco", "ASR 1000", "16.0", "17.0", ".1.2.3");

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect(DEF_ID, normalized);

        assertThat(result.hasConflicts()).isTrue();
        assertThat(result.conflicts().get(0)).contains("CONFLICTING_FINGERPRINT");
        assertThat(result.conflicts().get(0)).contains(OTHER_DEF_ID);
    }

    @Test
    void detect_sameOidButNonOverlappingFirmwareRange_noConflict() {
        FingerprintRegistryEntry existingEntry = FingerprintRegistryEntry.builder()
                .productDefinitionId(OTHER_DEF_ID)
                .fingerprintType("SNMP_OID")
                .fingerprintValue(".1.2.3")
                .firmwareFrom("10.0")
                .firmwareTo("14.9")
                .build();
        when(fingerprintRepo.findByFingerprintValue(".1.2.3")).thenReturn(List.of(existingEntry));
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        // Activating version for firmware 15.0–17.0 — should not conflict
        NormalizedProductDefinition normalized = buildNormalized("Cisco", "ASR 1000", "15.0", "17.0", ".1.2.3");

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect(DEF_ID, normalized);

        assertThat(result.hasConflicts()).isFalse();
    }

    @Test
    void detect_selfConflict_isIgnored() {
        // Same definitionId in the existing entry — self-activation should not block
        FingerprintRegistryEntry selfEntry = FingerprintRegistryEntry.builder()
                .productDefinitionId(DEF_ID) // same def, not another
                .fingerprintType("SNMP_OID")
                .fingerprintValue(".1.2.3")
                .firmwareFrom("15.0")
                .firmwareTo("17.0")
                .build();
        when(fingerprintRepo.findByFingerprintValue(".1.2.3")).thenReturn(List.of(selfEntry));
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        NormalizedProductDefinition normalized = buildNormalized("Cisco", "ASR 1000", "15.0", "17.0", ".1.2.3");

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect(DEF_ID, normalized);

        assertThat(result.hasConflicts()).isFalse();
    }

    // ── Firmware range overlap ────────────────────────────────────────────────

    @Test
    void detect_overlappingFirmwareRangeSameVendorModel_reportsConflict() {
        ProductDefinitionActiveVersion active = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(OTHER_DEF_ID)
                .vendor("Cisco")
                .model("ASR 1000")
                .firmwareFrom("16.0")
                .firmwareTo("18.0")
                .build();
        when(fingerprintRepo.findByFingerprintValue(anyString())).thenReturn(List.of());
        when(activeVersionRepo.findByVendorAndModel("Cisco", "ASR 1000")).thenReturn(List.of(active));

        NormalizedProductDefinition normalized = buildNormalized("Cisco", "ASR 1000", "15.0", "17.0", ".1.2.3");

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect(DEF_ID, normalized);

        assertThat(result.hasConflicts()).isTrue();
        assertThat(result.conflicts().get(0)).contains("CONFLICTING_FIRMWARE_RANGE");
    }

    // ── Duplicate parameter IDs ───────────────────────────────────────────────

    @Test
    void detect_duplicateParameterIdInGroup_reportsConflict() {
        // No fingerprints in this definition — fingerprintRepo not called.
        // firmwareRangeOverlap check will call activeVersionRepo for vendor+model.
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        NormalizedProductDefinition.ParameterEntry p1 = NormalizedProductDefinition.ParameterEntry.builder()
                .id("rsrp").dataType("FLOAT").build();
        NormalizedProductDefinition.ParameterEntry p2 = NormalizedProductDefinition.ParameterEntry.builder()
                .id("rsrp").dataType("FLOAT").build(); // duplicate

        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .firmwareFrom("21.Q1").firmwareTo("23.Q4")
                .fingerprints(List.of())
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("radio")
                                .parameters(List.of(p1, p2))
                                .build()))
                .build();

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect("ericsson-air-4480", normalized);

        assertThat(result.hasConflicts()).isTrue();
        assertThat(result.conflicts().get(0)).contains("DUPLICATE_PARAMETER_ID");
    }

    // ── Unsupported protocol warnings ─────────────────────────────────────────

    @Test
    void detect_snmpMappingWithoutSnmpProtocol_producesWarning() {
        // No fingerprints in this definition — fingerprintRepo not called.
        // firmwareRangeOverlap check will call activeVersionRepo for vendor+model.
        when(activeVersionRepo.findByVendorAndModel(anyString(), anyString())).thenReturn(List.of());

        NormalizedProductDefinition.ParameterEntry param = NormalizedProductDefinition.ParameterEntry.builder()
                .id("rsrp")
                .dataType("FLOAT")
                .snmpOid("1.3.6.1.4.1.193.81.2.12.1.1.1") // SNMP mapping...
                .build();

        NormalizedProductDefinition normalized = NormalizedProductDefinition.builder()
                .vendor("Ericsson").model("AIR 4480")
                .firmwareFrom("21.Q1").firmwareTo("23.Q4")
                .fingerprints(List.of())
                .supportedProtocols(List.of("REST")) // ...but SNMP not declared
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("radio")
                                .parameters(List.of(param))
                                .build()))
                .build();

        ProductDefinitionConflictService.ConflictResult result =
                conflictService.detect("ericsson-air-4480", normalized);

        assertThat(result.hasConflicts()).isFalse();
        assertThat(result.warnings()).isNotEmpty();
        assertThat(result.warnings().get(0)).contains("SNMP");
    }

    // ── firmwareRangesOverlap static helper ───────────────────────────────────

    @Test
    void firmwareRangesOverlap_nullBounds_alwaysOverlap() {
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap(null, "17.0", "15.0", "16.0")).isTrue();
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap("15.0", null, "15.0", "16.0")).isTrue();
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap(null, null, null, null)).isTrue();
    }

    @Test
    void firmwareRangesOverlap_noOverlap_returnsFalse() {
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap("10.0", "14.9", "15.0", "17.0")).isFalse();
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap("15.0", "17.0", "10.0", "14.9")).isFalse();
    }

    @Test
    void firmwareRangesOverlap_adjacentRanges_returnsTrue() {
        // "15.0" compareTo "15.0" == 0, so adjacent ranges with shared boundary overlap
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap("10.0", "15.0", "15.0", "17.0")).isTrue();
    }

    @Test
    void firmwareRangesOverlap_partialOverlap_returnsTrue() {
        assertThat(ProductDefinitionConflictService.firmwareRangesOverlap("15.0", "17.0", "16.0", "18.0")).isTrue();
    }
}

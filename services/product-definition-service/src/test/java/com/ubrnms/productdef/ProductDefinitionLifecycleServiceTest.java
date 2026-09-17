package com.ubrnms.productdef;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.productdef.model.*;
import com.ubrnms.productdef.repository.*;
import com.ubrnms.productdef.service.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ProductDefinitionLifecycleServiceTest {

    @Mock private ProductDefinitionVersionRepository         versionRepo;
    @Mock private ProductDefinitionActiveVersionRepository   activeVersionRepo;
    @Mock private FingerprintRegistryRepository              fingerprintRegistryRepo;
    @Mock private ParameterRegistryRepository                parameterRegistryRepo;
    @Mock private ProductDefinitionLifecycleEventRepository  lifecycleEventRepo;
    @Mock private IdempotencyRecordRepository                idempotencyRepo;
    @Mock private ProductDefinitionConflictService           conflictService;
    @Mock private KafkaTemplate<String, String>              kafkaTemplate;

    private ObjectMapper objectMapper;
    private FingerprintRegistryBuilder fingerprintBuilder;
    private ParameterRegistryBuilder   parameterBuilder;
    private ProductDefinitionLifecycleService lifecycleService;

    private static final String DEF_ID     = "cisco-asr-1000";
    private static final String VERSION_V1 = "version-v1";
    private static final String VERSION_V2 = "version-v2";
    private static final String USER_ID    = "user-001";
    private static final String USERNAME   = "admin";
    private static final String CORR_ID    = "corr-xyz";

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper().registerModule(new JavaTimeModule());
        fingerprintBuilder = new FingerprintRegistryBuilder();
        parameterBuilder   = new ParameterRegistryBuilder();

        lifecycleService = new ProductDefinitionLifecycleService(
                versionRepo, activeVersionRepo, fingerprintRegistryRepo, parameterRegistryRepo,
                lifecycleEventRepo, idempotencyRepo, fingerprintBuilder, parameterBuilder,
                conflictService, objectMapper, kafkaTemplate);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private NormalizedProductDefinition validNormalized() {
        return NormalizedProductDefinition.builder()
                .vendor("Cisco").model("ASR 1000")
                .firmwareFrom("15.0").firmwareTo("17.0")
                .supportedProtocols(List.of("SNMP"))
                .fingerprints(List.of(
                        NormalizedProductDefinition.FingerprintEntry.builder()
                                .sysObjectId(".1.3.6.1.4.1.9.1.1045").build()))
                .parameterGroups(List.of(
                        NormalizedProductDefinition.ParameterGroup.builder()
                                .groupName("cpu")
                                .parameters(List.of(
                                        NormalizedProductDefinition.ParameterEntry.builder()
                                                .id("cpu_load")
                                                .displayName("CPU Load")
                                                .dataType("NUMERIC")
                                                .snmpOid("1.3.6.1.4.1.9.2.1.56.0")
                                                .build()))
                                .build()))
                .build();
    }

    private ProductDefinitionVersion draftVersion(String versionId, String validationStatus) {
        ProductDefinitionVersion v = new ProductDefinitionVersion();
        v.setDefinitionId(DEF_ID);
        v.setVersionId(versionId);
        v.setLifecycleStatus("DRAFT");
        v.setValidationStatus(validationStatus);
        try {
            v.setNormalizedMetadataJson(objectMapper.writeValueAsString(validNormalized()));
        } catch (Exception e) { throw new RuntimeException(e); }
        return v;
    }

    private ProductDefinitionVersion stagedVersion(String versionId) {
        ProductDefinitionVersion v = draftVersion(versionId, "VALID");
        v.setLifecycleStatus("STAGED");
        return v;
    }

    // ── stageVersion ─────────────────────────────────────────────────────────

    @Test
    void stageVersion_validDraft_movesToStaged() {
        ProductDefinitionVersion draft = draftVersion(VERSION_V1, "VALID");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(draft));
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ProductDefinitionVersion result =
                lifecycleService.stageVersion(DEF_ID, VERSION_V1, USER_ID, USERNAME, CORR_ID);

        assertThat(result.getLifecycleStatus()).isEqualTo("STAGED");
        assertThat(result.getStagedBy()).isEqualTo(USER_ID);
        assertThat(result.getStagedAt()).isNotNull();
        verify(versionRepo).save(argThat(v -> "STAGED".equals(v.getLifecycleStatus())));
    }

    @Test
    void stageVersion_invalidDraft_throwsIllegalArgument() {
        ProductDefinitionVersion invalid = draftVersion(VERSION_V1, "INVALID");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(invalid));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        assertThatThrownBy(() ->
                lifecycleService.stageVersion(DEF_ID, VERSION_V1, USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("VALID");
    }

    @Test
    void stageVersion_alreadyStagedVersion_throwsIllegalArgument() {
        ProductDefinitionVersion staged = stagedVersion(VERSION_V1);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(staged));

        assertThatThrownBy(() ->
                lifecycleService.stageVersion(DEF_ID, VERSION_V1, USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("DRAFT");
    }

    @Test
    void stageVersion_versionNotFound_throwsNoSuchElement() {
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, "missing"))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() ->
                lifecycleService.stageVersion(DEF_ID, "missing", USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(NoSuchElementException.class);
    }

    // ── activateVersion ───────────────────────────────────────────────────────

    @Test
    void activateVersion_stagedVersion_noConflicts_succeeds() {
        ProductDefinitionVersion staged = stagedVersion(VERSION_V1);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(staged));
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(conflictService.detect(any(), any()))
                .thenReturn(new ProductDefinitionConflictService.ConflictResult(List.of(), List.of()));
        when(activeVersionRepo.findByProductDefinitionIdAndFirmwareFromAndFirmwareTo(any(), any(), any()))
                .thenReturn(Optional.empty());
        when(activeVersionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        // idempotencyKey is null — idempotencyRepo is not consulted in this call

        Map<String, Object> result = lifecycleService.activateVersion(
                DEF_ID, VERSION_V1, null, USER_ID, USERNAME, CORR_ID);

        assertThat(result.get("activationStatus")).isEqualTo("SUCCESS");
        assertThat(result.get("registryVersion")).isEqualTo(1L);
        assertThat((Integer) result.get("fingerprintCount")).isGreaterThan(0);
        assertThat((Integer) result.get("parameterCount")).isGreaterThan(0);

        verify(fingerprintRegistryRepo).deleteByProductDefinitionId(DEF_ID);
        verify(parameterRegistryRepo).deleteByProductDefinitionId(DEF_ID);
        verify(activeVersionRepo).save(any());
    }

    @Test
    void activateVersion_withConflict_throwsIllegalState() {
        ProductDefinitionVersion staged = stagedVersion(VERSION_V1);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(staged));
        when(conflictService.detect(any(), any()))
                .thenReturn(new ProductDefinitionConflictService.ConflictResult(
                        List.of("CONFLICTING_FINGERPRINT: sysObjectId '.1.2.3' conflicts with other-def"),
                        List.of()));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        assertThatThrownBy(() ->
                lifecycleService.activateVersion(DEF_ID, VERSION_V1, null, USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("CONFLICTING_FINGERPRINT");
    }

    @Test
    void activateVersion_notStagedVersion_throwsIllegalArgument() {
        ProductDefinitionVersion draft = draftVersion(VERSION_V1, "VALID");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(draft));

        assertThatThrownBy(() ->
                lifecycleService.activateVersion(DEF_ID, VERSION_V1, null, USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STAGED");
    }

    @Test
    void activateVersion_idempotencyKeyAlreadyExists_returnsExistingOutcome() {
        IdempotencyRecord existing = IdempotencyRecord.builder()
                .compositeKey("ACTIVATE:key-001")
                .operation("ACTIVATE")
                .outcome("SUCCESS")
                .resultActiveVersionId(VERSION_V1)
                .registryVersion(3L)
                .build();
        when(idempotencyRepo.findByCompositeKey("ACTIVATE:key-001")).thenReturn(Optional.of(existing));

        Map<String, Object> result = lifecycleService.activateVersion(
                DEF_ID, VERSION_V1, "key-001", USER_ID, USERNAME, CORR_ID);

        assertThat(result.get("activationStatus")).isEqualTo("SUCCESS");
        assertThat(result.get("registryVersion")).isEqualTo(3L);
        // No version load or registry rebuild should happen
        verify(versionRepo, never()).findByDefinitionIdAndVersionId(any(), any());
    }

    @Test
    void activateVersion_secondActivation_advancesRegistryVersion() {
        ProductDefinitionVersion staged = stagedVersion(VERSION_V2);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V2))
                .thenReturn(Optional.of(staged));
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1))
                .thenReturn(Optional.of(draftVersion(VERSION_V1, "VALID")));
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(conflictService.detect(any(), any()))
                .thenReturn(new ProductDefinitionConflictService.ConflictResult(List.of(), List.of()));

        // Simulate existing active version at registryVersion=5
        ProductDefinitionActiveVersion existingActive = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID)
                .activeVersionId(VERSION_V1)
                .firmwareFrom("15.0").firmwareTo("17.0")
                .registryVersion(5L)
                .build();
        when(activeVersionRepo.findByProductDefinitionIdAndFirmwareFromAndFirmwareTo(DEF_ID, "15.0", "17.0"))
                .thenReturn(Optional.of(existingActive));
        when(activeVersionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        // idempotencyKey is null — idempotencyRepo is not consulted in this call

        Map<String, Object> result = lifecycleService.activateVersion(
                DEF_ID, VERSION_V2, null, USER_ID, USERNAME, CORR_ID);

        // registryVersion must be 6 (previous 5 + 1)
        assertThat(result.get("registryVersion")).isEqualTo(6L);
        assertThat(result.get("activationStatus")).isEqualTo("SUCCESS");
    }

    // ── rollbackVersion ───────────────────────────────────────────────────────

    @Test
    void rollbackVersion_withPreviousVersion_succeeds() throws Exception {
        // V2 is currently ACTIVE; V1 was the previous version
        ProductDefinitionActiveVersion active = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID)
                .activeVersionId(VERSION_V2)
                .previousVersionId(VERSION_V1)
                .firmwareFrom("15.0").firmwareTo("17.0")
                .registryVersion(6L)
                .build();
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(active));

        ProductDefinitionVersion v1 = draftVersion(VERSION_V1, "VALID");
        v1.setLifecycleStatus("SUPERSEDED");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1)).thenReturn(Optional.of(v1));

        ProductDefinitionVersion v2 = stagedVersion(VERSION_V2);
        v2.setLifecycleStatus("ACTIVE");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V2)).thenReturn(Optional.of(v2));

        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(activeVersionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(inv -> inv.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> result = lifecycleService.rollbackVersion(
                DEF_ID, "Reverting unstable release", USER_ID, USERNAME, CORR_ID);

        assertThat(result.get("rollbackStatus")).isEqualTo("SUCCESS");
        assertThat(result.get("restoredVersionId")).isEqualTo(VERSION_V1);
        assertThat(result.get("registryVersion")).isEqualTo(7L); // 6+1
    }

    @Test
    void rollbackVersion_noPreviousVersion_throwsIllegalArgument() {
        ProductDefinitionActiveVersion active = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID)
                .activeVersionId(VERSION_V1)
                .previousVersionId(null) // no previous
                .registryVersion(1L)
                .build();
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(active));
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        assertThatThrownBy(() ->
                lifecycleService.rollbackVersion(DEF_ID, "test", USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("No previous active version");
    }

    @Test
    void rollbackVersion_noActiveVersion_throwsNoSuchElement() {
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of());
        when(lifecycleEventRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        assertThatThrownBy(() ->
                lifecycleService.rollbackVersion(DEF_ID, "test", USER_ID, USERNAME, CORR_ID))
                .isInstanceOf(NoSuchElementException.class)
                .hasMessageContaining("No active version");
    }

    // ── getActiveVersion ──────────────────────────────────────────────────────

    @Test
    void getActiveVersion_exists_returnsVersion() {
        ProductDefinitionActiveVersion pointer = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID).activeVersionId(VERSION_V1).build();
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(pointer));

        ProductDefinitionVersion active = draftVersion(VERSION_V1, "VALID");
        active.setLifecycleStatus("ACTIVE");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, VERSION_V1)).thenReturn(Optional.of(active));

        ProductDefinitionVersion result = lifecycleService.getActiveVersion(DEF_ID);
        assertThat(result.getVersionId()).isEqualTo(VERSION_V1);
        assertThat(result.getLifecycleStatus()).isEqualTo("ACTIVE");
    }

    @Test
    void getActiveVersion_noActive_throwsNoSuchElement() {
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of());

        assertThatThrownBy(() -> lifecycleService.getActiveVersion(DEF_ID))
                .isInstanceOf(NoSuchElementException.class);
    }

    // ── listDefinitions ───────────────────────────────────────────────────────

    @Test
    void listDefinitions_returnsAllActivePointers() {
        ProductDefinitionActiveVersion pointer = ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID)
                .vendor("Cisco")
                .model("ASR 1000")
                .activeVersionId(VERSION_V1)
                .registryVersion(1L)
                .build();
        when(activeVersionRepo.findAll()).thenReturn(List.of(pointer));

        List<Map<String, Object>> result = lifecycleService.listDefinitions();

        assertThat(result).hasSize(1);
        assertThat(result.get(0).get("productDefinitionId")).isEqualTo(DEF_ID);
        assertThat(result.get(0).get("vendor")).isEqualTo("Cisco");
        assertThat(result.get(0).get("registryVersion")).isEqualTo(1L);
    }
}

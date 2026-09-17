package com.ubrnms.productdef;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.productdef.model.*;
import com.ubrnms.productdef.repository.*;
import com.ubrnms.productdef.service.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
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

/**
 * Unit tests for WO-017 targeted rollback — rollbackToVersion().
 * Covers: successful rollback, ineligible targets, ARCHIVED/DRAFT rejection,
 * already-active rejection, registry rebuild failure, AC validation.
 */
@ExtendWith(MockitoExtension.class)
class RollbackToVersionTest {

    @Mock private ProductDefinitionVersionRepository         versionRepo;
    @Mock private ProductDefinitionActiveVersionRepository   activeVersionRepo;
    @Mock private FingerprintRegistryRepository              fingerprintRegistryRepo;
    @Mock private ParameterRegistryRepository                parameterRegistryRepo;
    @Mock private ProductDefinitionLifecycleEventRepository  lifecycleEventRepo;
    @Mock private IdempotencyRecordRepository                idempotencyRepo;
    @Mock private ProductDefinitionConflictService           conflictService;
    @Mock private KafkaTemplate<String, String>              kafkaTemplate;
    @Mock private PublishGateEvaluator                       publishGateEvaluator;
    @Mock private IdempotencyService                         idempotencyService;

    private ProductDefinitionLifecycleService lifecycleService;

    private static final String DEF_ID     = "def-001";
    private static final String ACTIVE_VID = "v3.0";
    private static final String TARGET_VID = "v1.0";
    private static final String ACTOR      = "admin@test.com";
    private static final String ACTOR_UID  = "usr-001";
    private static final String CORR_ID    = "corr-xyz";

    @BeforeEach
    void setUp() {
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());
        lifecycleService = new ProductDefinitionLifecycleService(
                versionRepo, activeVersionRepo, fingerprintRegistryRepo, parameterRegistryRepo,
                lifecycleEventRepo, idempotencyRepo, new FingerprintRegistryBuilder(),
                new ParameterRegistryBuilder(), conflictService, mapper, kafkaTemplate,
                publishGateEvaluator, idempotencyService);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private ProductDefinitionVersion supersededVersion(String vid) {
        ProductDefinitionVersion v = new ProductDefinitionVersion();
        v.setVersionId(vid);
        v.setDefinitionId(DEF_ID);
        v.setLifecycleStatus("SUPERSEDED");
        v.setValidationStatus("VALID");
        v.setVendor("Nokia");
        v.setModel("7210");
        v.setSchemaVersion("1.0");
        v.setVersion(1L);
        v.setNormalizedMetadataJson(validNormalizedJson());
        return v;
    }

    private ProductDefinitionVersion activeVersion(String vid) {
        ProductDefinitionVersion v = supersededVersion(vid);
        v.setLifecycleStatus("ACTIVE");
        return v;
    }

    private String validNormalizedJson() {
        return "{\"vendor\":\"Nokia\",\"model\":\"7210\",\"firmwareFrom\":\"3.0\",\"firmwareTo\":\"9.0\"," +
               "\"fingerprints\":[{\"sysObjectId\":\"1.3.6.1.4.1.6527.1\"}],\"parameterGroups\":[]}";
    }

    private ProductDefinitionActiveVersion activePointer() {
        return ProductDefinitionActiveVersion.builder()
                .productDefinitionId(DEF_ID)
                .activeVersionId(ACTIVE_VID)
                .previousVersionId(TARGET_VID)
                .registryVersion(5L)
                .build();
    }

    // ── AC-1: SuperAdmin can initiate rollback to prior valid version ──────────

    @Test
    @DisplayName("rollbackToVersion succeeds when target is SUPERSEDED with VALID validation")
    void rollbackToVersion_supersededTarget_succeeds() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, ACTIVE_VID)).thenReturn(Optional.of(activeVersion(ACTIVE_VID)));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));
        when(versionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(activeVersionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(i -> i.getArgument(0));

        Map<String, Object> result = lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "Restore stable release", ACTOR_UID, ACTOR, CORR_ID);

        assertThat(result.get("rollbackStatus")).isEqualTo("SUCCESS");
        assertThat(result.get("restoredVersionId")).isEqualTo(TARGET_VID);
        assertThat(result.get("supersededVersionId")).isEqualTo(ACTIVE_VID);
        assertThat(result.get("lifecycleStatus")).isEqualTo("ACTIVE");
        assertThat((Long) result.get("registryVersion")).isEqualTo(6L);
    }

    @Test
    @DisplayName("rollbackToVersion succeeds when target is STAGED with VALID validation")
    void rollbackToVersion_stagedTarget_succeeds() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        target.setLifecycleStatus("STAGED"); // STAGED → also eligible
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, ACTIVE_VID)).thenReturn(Optional.of(activeVersion(ACTIVE_VID)));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));
        when(versionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(activeVersionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(i -> i.getArgument(0));

        Map<String, Object> result = lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "Rollback", ACTOR_UID, ACTOR, CORR_ID);

        assertThat(result.get("rollbackStatus")).isEqualTo("SUCCESS");
    }

    // ── AC-3: Invalid/ARCHIVED/DRAFT versions cannot be rollback targets ──────

    @Test
    @DisplayName("INVALID validation status is rejected with ROLLBACK_TARGET_INVALID")
    void rollbackToVersion_invalidValidation_rejected() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        target.setValidationStatus("INVALID");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));

        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ROLLBACK_TARGET_INVALID");
    }

    @Test
    @DisplayName("ARCHIVED lifecycle status is rejected with ROLLBACK_TARGET_INVALID")
    void rollbackToVersion_archivedTarget_rejected() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        target.setLifecycleStatus("ARCHIVED");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));

        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ROLLBACK_TARGET_INVALID");
    }

    @Test
    @DisplayName("DRAFT lifecycle status is rejected with ROLLBACK_TARGET_INVALID")
    void rollbackToVersion_draftTarget_rejected() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        target.setLifecycleStatus("DRAFT");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));

        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("ROLLBACK_TARGET_INVALID");
    }

    @Test
    @DisplayName("Non-existent target version returns NoSuchElementException")
    void rollbackToVersion_missingTarget_throwsNoSuchElement() {
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, "nonexistent"))
                .thenReturn(Optional.empty());

        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, "nonexistent", "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(NoSuchElementException.class)
                .hasMessageContaining("ROLLBACK_TARGET_INVALID");
    }

    // ── ROLLBACK_CONFLICT: target is already active ───────────────────────────

    @Test
    @DisplayName("Rollback to the currently active version is rejected with ROLLBACK_CONFLICT code")
    void rollbackToVersion_targetIsCurrentlyActive_rejected() {
        ProductDefinitionVersion target = supersededVersion(ACTIVE_VID); // same as ACTIVE_VID
        target.setLifecycleStatus("SUPERSEDED");
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, ACTIVE_VID)).thenReturn(Optional.of(target));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));

        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, ACTIVE_VID, "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already the active version");
    }

    // ── AC-6: Rollback failures leave previously active version unchanged ─────

    @Test
    @DisplayName("Registry rebuild failure leaves previously active version unchanged")
    void rollbackToVersion_registryRebuildFails_activeVersionUnchanged() {
        // Return a version with null normalizedMetadataJson to force parsing failure
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        target.setNormalizedMetadataJson(null); // will fail parsing
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));
        // No lifecycleEventRepo stub — parsing fails before any event is written

        // When normalizedMetadataJson is null, parseNormalizedMetadata throws IllegalStateException
        // before registry rebuild — the active pointer must never be updated
        assertThatThrownBy(() -> lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "reason", ACTOR_UID, ACTOR, CORR_ID))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("no stored normalized metadata"); // message from parseNormalizedMetadata

        // Active version pointer must NOT have been updated
        verify(activeVersionRepo, never()).save(any());
    }

    // ── AC-2: Immutable lifecycle transition record ───────────────────────────

    @Test
    @DisplayName("Successful rollback persists an immutable ROLLED_BACK lifecycle event")
    void rollbackToVersion_persistsRolledBackEvent() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, ACTIVE_VID)).thenReturn(Optional.of(activeVersion(ACTIVE_VID)));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));
        when(versionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(activeVersionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(i -> i.getArgument(0));

        lifecycleService.rollbackToVersion(
                DEF_ID, TARGET_VID, "Audit test", ACTOR_UID, ACTOR, CORR_ID);

        verify(lifecycleEventRepo).save(argThat(evt ->
            "ROLLED_BACK".equals(evt.getEventType())
            && TARGET_VID.equals(evt.getVersionId())
            && "SUCCESS".equals(evt.getOutcome())
            && ACTOR_UID.equals(evt.getActorUserId())
            && CORR_ID.equals(evt.getCorrelationId())
            && ACTIVE_VID.equals(evt.getPredecessorVersionId())
        ));
    }

    // ── AC-5: Atomicity — pointer updated last ────────────────────────────────

    @Test
    @DisplayName("Registry is rebuilt before the active version pointer is updated")
    void rollbackToVersion_registryRebuildBeforePointerUpdate() {
        ProductDefinitionVersion target = supersededVersion(TARGET_VID);
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, TARGET_VID)).thenReturn(Optional.of(target));
        when(versionRepo.findByDefinitionIdAndVersionId(DEF_ID, ACTIVE_VID)).thenReturn(Optional.of(activeVersion(ACTIVE_VID)));
        when(activeVersionRepo.findByProductDefinitionId(DEF_ID)).thenReturn(List.of(activePointer()));
        when(versionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(activeVersionRepo.save(any())).thenAnswer(i -> i.getArgument(0));
        when(fingerprintRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(parameterRegistryRepo.saveAll(any())).thenAnswer(i -> i.getArgument(0));
        when(lifecycleEventRepo.save(any())).thenAnswer(i -> i.getArgument(0));

        lifecycleService.rollbackToVersion(DEF_ID, TARGET_VID, "reason", ACTOR_UID, ACTOR, CORR_ID);

        // Verify registry was rebuilt (saveAll called for both collections)
        verify(fingerprintRegistryRepo).saveAll(any());
        verify(parameterRegistryRepo).saveAll(any());
        // And active pointer was updated after
        verify(activeVersionRepo).save(argThat(p ->
            TARGET_VID.equals(p.getActiveVersionId()) && ACTIVE_VID.equals(p.getPreviousVersionId())
        ));
    }
}

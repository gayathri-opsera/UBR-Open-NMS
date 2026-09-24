package com.ubrnms.productdef;

import com.ubrnms.productdef.model.IdempotencyRecord;
import com.ubrnms.productdef.repository.IdempotencyRecordRepository;
import com.ubrnms.productdef.service.IdempotencyService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ConcurrentModificationException;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for WO-022 idempotency and optimistic locking service.
 * Covers: PROCEED, DUPLICATE, MISMATCH, parameter mismatch rejection,
 * record persistence, optimistic lock check, fingerprint generation.
 */
@ExtendWith(MockitoExtension.class)
class IdempotencyServiceTest {

    @Mock
    private IdempotencyRecordRepository idempotencyRepo;

    private IdempotencyService idempotencyService;

    private static final String DEF_ID  = "def-001";
    private static final String VER_ID  = "1.0.0";
    private static final String KEY     = "caller-key-abc";

    @BeforeEach
    void setUp() {
        idempotencyService = new IdempotencyService(idempotencyRepo);
    }

    // ── PROCEED ───────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Returns PROCEED when no idempotency key is supplied")
    void check_nullKey_returnsProceed() {
        IdempotencyService.CheckOutcome outcome = idempotencyService.check("ACTIVATE", null, DEF_ID, VER_ID);
        assertThat(outcome.result()).isEqualTo(IdempotencyService.CheckResult.PROCEED);
        verifyNoInteractions(idempotencyRepo);
    }

    @Test
    @DisplayName("Returns PROCEED when idempotency key is blank")
    void check_blankKey_returnsProceed() {
        IdempotencyService.CheckOutcome outcome = idempotencyService.check("ACTIVATE", "  ", DEF_ID, VER_ID);
        assertThat(outcome.result()).isEqualTo(IdempotencyService.CheckResult.PROCEED);
        verifyNoInteractions(idempotencyRepo);
    }

    @Test
    @DisplayName("Returns PROCEED when no existing record is found for the composite key")
    void check_noExistingRecord_returnsProceed() {
        when(idempotencyRepo.findByCompositeKey(any())).thenReturn(Optional.empty());
        IdempotencyService.CheckOutcome outcome = idempotencyService.check("ACTIVATE", KEY, DEF_ID, VER_ID);
        assertThat(outcome.result()).isEqualTo(IdempotencyService.CheckResult.PROCEED);
    }

    // ── DUPLICATE (AC-4) ──────────────────────────────────────────────────────

    @Test
    @DisplayName("Returns DUPLICATE when existing record has matching fingerprint")
    void check_existingRecordMatchingFingerprint_returnsDuplicate() {
        String fingerprint = idempotencyService.fingerprint("ACTIVATE", DEF_ID, VER_ID);
        IdempotencyRecord existing = IdempotencyRecord.builder()
                .compositeKey("ACTIVATE:" + KEY)
                .operation("ACTIVATE")
                .productDefinitionId(DEF_ID)
                .versionId(VER_ID)
                .requestFingerprint(fingerprint)
                .outcome("SUCCESS")
                .resultActiveVersionId(VER_ID)
                .registryVersion(3L)
                .build();
        when(idempotencyRepo.findByCompositeKey("ACTIVATE:" + KEY)).thenReturn(Optional.of(existing));

        IdempotencyService.CheckOutcome outcome = idempotencyService.check("ACTIVATE", KEY, DEF_ID, VER_ID);

        assertThat(outcome.result()).isEqualTo(IdempotencyService.CheckResult.DUPLICATE);
        assertThat(outcome.record().getRegistryVersion()).isEqualTo(3L);
        assertThat(outcome.record().getOutcome()).isEqualTo("SUCCESS");
    }

    // ── MISMATCH (AC-5) ───────────────────────────────────────────────────────

    @Test
    @DisplayName("Returns MISMATCH when existing record has different fingerprint (different versionId)")
    void check_existingRecordDifferentFingerprint_returnsMismatch() {
        // Record was for versionId="1.0.0", but new request targets "2.0.0"
        String originalFingerprint = idempotencyService.fingerprint("ACTIVATE", DEF_ID, "1.0.0");
        IdempotencyRecord existing = IdempotencyRecord.builder()
                .compositeKey("ACTIVATE:" + KEY)
                .requestFingerprint(originalFingerprint)
                .outcome("SUCCESS")
                .build();
        when(idempotencyRepo.findByCompositeKey("ACTIVATE:" + KEY)).thenReturn(Optional.of(existing));

        // New request uses same key but different versionId
        IdempotencyService.CheckOutcome outcome = idempotencyService.check("ACTIVATE", KEY, DEF_ID, "2.0.0");

        assertThat(outcome.result()).isEqualTo(IdempotencyService.CheckResult.MISMATCH);
    }

    // ── Record persistence (AC-4, AC-6) ──────────────────────────────────────

    @Test
    @DisplayName("record() saves IdempotencyRecord with correct fields including fingerprint")
    void record_savesWithCorrectFields() {
        ArgumentCaptor<IdempotencyRecord> captor = ArgumentCaptor.forClass(IdempotencyRecord.class);
        when(idempotencyRepo.save(any())).thenReturn(null);

        idempotencyService.record("STAGE", KEY, DEF_ID, VER_ID, "SUCCESS", VER_ID, 5L);

        verify(idempotencyRepo).save(captor.capture());
        IdempotencyRecord saved = captor.getValue();
        assertThat(saved.getCompositeKey()).isEqualTo("STAGE:" + KEY);
        assertThat(saved.getOperation()).isEqualTo("STAGE");
        assertThat(saved.getProductDefinitionId()).isEqualTo(DEF_ID);
        assertThat(saved.getVersionId()).isEqualTo(VER_ID);
        assertThat(saved.getOutcome()).isEqualTo("SUCCESS");
        assertThat(saved.getRegistryVersion()).isEqualTo(5L);
        assertThat(saved.getRequestFingerprint()).isNotBlank();
    }

    @Test
    @DisplayName("record() is a no-op when idempotencyKey is null")
    void record_nullKey_noOp() {
        idempotencyService.record("STAGE", null, DEF_ID, VER_ID, "SUCCESS", VER_ID, 5L);
        verifyNoInteractions(idempotencyRepo);
    }

    @Test
    @DisplayName("record() handles DuplicateKeyException gracefully (concurrent success race)")
    void record_duplicateKeyException_handled() {
        when(idempotencyRepo.save(any()))
                .thenThrow(new org.springframework.dao.DuplicateKeyException("duplicate"));
        // Must not throw
        assertThatCode(() -> idempotencyService.record("ACTIVATE", KEY, DEF_ID, VER_ID, "SUCCESS", VER_ID, 3L))
                .doesNotThrowAnyException();
    }

    // ── Optimistic locking (AC-1, AC-2) ──────────────────────────────────────

    @Test
    @DisplayName("validateOptimisticLock passes when expectedVersion matches stored version")
    void optimisticLock_versionMatches_passes() {
        assertThatCode(() -> idempotencyService.validateOptimisticLock(5L, 5L, VER_ID))
                .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("validateOptimisticLock throws when expectedVersion differs from stored version")
    void optimisticLock_versionMismatch_throws() {
        assertThatThrownBy(() -> idempotencyService.validateOptimisticLock(5L, 3L, VER_ID))
                .isInstanceOf(ConcurrentModificationException.class)
                .hasMessageContaining("Version conflict")
                .hasMessageContaining("3")
                .hasMessageContaining("5");
    }

    @Test
    @DisplayName("validateOptimisticLock skips check when expectedVersion is null")
    void optimisticLock_nullExpectedVersion_skips() {
        assertThatCode(() -> idempotencyService.validateOptimisticLock(5L, null, VER_ID))
                .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("validateOptimisticLock skips check when expectedVersion is 0")
    void optimisticLock_zeroExpectedVersion_skips() {
        assertThatCode(() -> idempotencyService.validateOptimisticLock(5L, 0L, VER_ID))
                .doesNotThrowAnyException();
    }

    // ── Fingerprint determinism ───────────────────────────────────────────────

    @Test
    @DisplayName("fingerprint() is deterministic for same inputs")
    void fingerprint_deterministic() {
        String fp1 = idempotencyService.fingerprint("ACTIVATE", DEF_ID, VER_ID);
        String fp2 = idempotencyService.fingerprint("ACTIVATE", DEF_ID, VER_ID);
        assertThat(fp1).isEqualTo(fp2);
    }

    @Test
    @DisplayName("fingerprint() differs for different operations")
    void fingerprint_differsForDifferentOperations() {
        String activateFp = idempotencyService.fingerprint("ACTIVATE", DEF_ID, VER_ID);
        String stageFp    = idempotencyService.fingerprint("STAGE",    DEF_ID, VER_ID);
        assertThat(activateFp).isNotEqualTo(stageFp);
    }

    @Test
    @DisplayName("fingerprint() differs for different versionIds")
    void fingerprint_differsForDifferentVersions() {
        String fp1 = idempotencyService.fingerprint("ACTIVATE", DEF_ID, "1.0.0");
        String fp2 = idempotencyService.fingerprint("ACTIVATE", DEF_ID, "2.0.0");
        assertThat(fp1).isNotEqualTo(fp2);
    }

    @Test
    @DisplayName("fingerprint() produces 64-char hex SHA-256 output")
    void fingerprint_producesHex64Chars() {
        String fp = idempotencyService.fingerprint("ACTIVATE", DEF_ID, VER_ID);
        assertThat(fp).hasSize(64).matches("[0-9a-f]+");
    }
}

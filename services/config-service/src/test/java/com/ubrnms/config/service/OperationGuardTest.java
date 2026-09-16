package com.ubrnms.config.service;

import com.ubrnms.config.model.OperationClass;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;

/** Unit tests for OperationGuard per-device concurrency control (WO-018). */
class OperationGuardTest {

    private OperationGuard guard;

    @BeforeEach
    void setUp() throws Exception {
        guard = new OperationGuard();
        // Inject default marker TTL (3600s) via reflection (matches @Value default)
        Field ttl = OperationGuard.class.getDeclaredField("markerTtlSeconds");
        ttl.setAccessible(true);
        ttl.set(guard, 3600);
    }

    // ── Happy path ──────────────────────────────────────────────────────────────

    @Test
    void acquire_noExistingMarker_succeeds() {
        Optional<OperationGuard.InFlightMarker> conflict =
                guard.acquire("dev-1", OperationClass.CONFIG_CHANGE, "job-1", "admin");
        assertThat(conflict).isEmpty();
    }

    @Test
    void acquire_andRelease_thenAcquireAgainSucceeds() {
        guard.acquire("dev-1", OperationClass.CONFIG_CHANGE, "job-1", "admin");
        guard.release("dev-1", "job-1");

        Optional<OperationGuard.InFlightMarker> second =
                guard.acquire("dev-1", OperationClass.FIRMWARE_UPGRADE, "job-2", "admin");
        assertThat(second).isEmpty();
    }

    @Test
    void readOnlyDiagnostic_alwaysAllowed_withoutAcquiringLock() {
        // Exclusive operation already in flight
        guard.acquire("dev-2", OperationClass.FIRMWARE_UPGRADE, "job-fw", "admin");

        // Read-only diagnostic must still be allowed
        Optional<OperationGuard.InFlightMarker> diag =
                guard.acquire("dev-2", OperationClass.READ_ONLY_DIAGNOSTIC, "job-diag", "admin");
        assertThat(diag).isEmpty();
    }

    // ── Limit reached ───────────────────────────────────────────────────────────

    @Test
    void acquire_conflictingExclusiveOperation_returnsExistingMarker() {
        guard.acquire("dev-3", OperationClass.CONFIG_CHANGE, "job-cfg", "admin");

        Optional<OperationGuard.InFlightMarker> conflict =
                guard.acquire("dev-3", OperationClass.REBOOT, "job-reboot", "admin");

        assertThat(conflict).isPresent();
        assertThat(conflict.get().operationClass).isEqualTo(OperationClass.CONFIG_CHANGE);
        assertThat(conflict.get().jobId).isEqualTo("job-cfg");
    }

    @Test
    void acquire_sameDeviceSameClass_conflicts() {
        guard.acquire("dev-4", OperationClass.FIRMWARE_UPGRADE, "job-fw-1", "admin");

        Optional<OperationGuard.InFlightMarker> second =
                guard.acquire("dev-4", OperationClass.FIRMWARE_UPGRADE, "job-fw-2", "admin");

        assertThat(second).isPresent();
    }

    // ── Per-device blocking ─────────────────────────────────────────────────────

    @Test
    void acquire_differentDevices_independentLocks() {
        guard.acquire("dev-A", OperationClass.FIRMWARE_UPGRADE, "job-fw-A", "admin");

        // Different device must not be blocked
        Optional<OperationGuard.InFlightMarker> conflict =
                guard.acquire("dev-B", OperationClass.FIRMWARE_UPGRADE, "job-fw-B", "admin");
        assertThat(conflict).isEmpty();
    }

    // ── Idempotent duplicate ─────────────────────────────────────────────────────

    @Test
    void acquire_idempotentDuplicate_returnsSameJobSuccess() {
        guard.acquire("dev-5", OperationClass.CONFIG_CHANGE, "job-idem", "admin");

        // Same caller same job — idempotent, must not conflict
        Optional<OperationGuard.InFlightMarker> duplicate =
                guard.acquire("dev-5", OperationClass.CONFIG_CHANGE, "job-idem", "admin");
        assertThat(duplicate).isEmpty();
    }

    // ── Stale lock release ───────────────────────────────────────────────────────

    @Test
    void acquire_staleExpiredMarker_isReleasedAndNewAcquireSucceeds() throws Exception {
        // Set a very short TTL
        Field ttl = OperationGuard.class.getDeclaredField("markerTtlSeconds");
        ttl.setAccessible(true);
        ttl.set(guard, -1); // expired in the past immediately

        guard.acquire("dev-6", OperationClass.FIRMWARE_UPGRADE, "old-job", "admin");

        // Reset to normal TTL for the new acquire
        ttl.set(guard, 3600);

        // Expired marker must be reconciled and new acquire must succeed
        Optional<OperationGuard.InFlightMarker> result =
                guard.acquire("dev-6", OperationClass.FIRMWARE_UPGRADE, "new-job", "admin");
        assertThat(result).isEmpty();
    }

    // ── Compatible operations ────────────────────────────────────────────────────

    @Test
    void operationClass_compatibilityMatrix_isCorrect() {
        assertThat(OperationClass.READ_ONLY_DIAGNOSTIC.isCompatibleWith(OperationClass.FIRMWARE_UPGRADE)).isTrue();
        assertThat(OperationClass.FIRMWARE_UPGRADE.isCompatibleWith(OperationClass.READ_ONLY_DIAGNOSTIC)).isTrue();
        assertThat(OperationClass.CONFIG_CHANGE.isCompatibleWith(OperationClass.REBOOT)).isFalse();
        assertThat(OperationClass.FIRMWARE_UPGRADE.isCompatibleWith(OperationClass.CONFIG_CHANGE)).isFalse();
        assertThat(OperationClass.REBOOT.isCompatibleWith(OperationClass.FACTORY_RESET)).isFalse();
    }

    @Test
    void operationClass_exclusiveClasses_doNotIncludeDiagnostic() {
        assertThat(OperationClass.EXCLUSIVE_CLASSES).doesNotContain(OperationClass.READ_ONLY_DIAGNOSTIC);
        assertThat(OperationClass.EXCLUSIVE_CLASSES).contains(
                OperationClass.CONFIG_CHANGE,
                OperationClass.REBOOT,
                OperationClass.FACTORY_RESET,
                OperationClass.FIRMWARE_UPGRADE,
                OperationClass.FILE_TRANSFER
        );
    }

    // ── getCurrent ───────────────────────────────────────────────────────────────

    @Test
    void getCurrent_afterAcquire_returnsMarker() {
        guard.acquire("dev-7", OperationClass.REBOOT, "job-r", "admin");
        Optional<OperationGuard.InFlightMarker> current = guard.getCurrent("dev-7");
        assertThat(current).isPresent();
        assertThat(current.get().operationClass).isEqualTo(OperationClass.REBOOT);
    }

    @Test
    void getCurrent_afterRelease_isEmpty() {
        guard.acquire("dev-8", OperationClass.CONFIG_CHANGE, "job-c", "admin");
        guard.release("dev-8", "job-c");
        assertThat(guard.getCurrent("dev-8")).isEmpty();
    }
}

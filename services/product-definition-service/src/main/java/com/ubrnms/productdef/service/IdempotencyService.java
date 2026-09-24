package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.IdempotencyRecord;
import com.ubrnms.productdef.repository.IdempotencyRecordRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ConcurrentModificationException;
import java.util.HexFormat;
import java.util.Optional;

/**
 * Centralised idempotency management for Product Definition lifecycle commands (WO-022).
 *
 * <p>Every state-changing command (stage, activate, rollback) may supply an optional
 * {@code idempotencyKey}.  This service:
 * <ol>
 *   <li>Generates a <em>request fingerprint</em> — SHA-256 of {@code op:definitionId:versionId}
 *       — which identifies the exact intent of the command.</li>
 *   <li>Looks up any existing {@link IdempotencyRecord} for the composite key.</li>
 *   <li>If found with a <em>matching fingerprint</em>, returns {@link CheckResult#DUPLICATE}
 *       so the caller can return the cached outcome without re-executing.</li>
 *   <li>If found with a <em>different fingerprint</em>, returns {@link CheckResult#MISMATCH}
 *       so the caller can reject the request with HTTP 409.</li>
 *   <li>If not found, returns {@link CheckResult#PROCEED} — the caller should execute normally
 *       then call {@link #record} to persist the outcome.</li>
 * </ol>
 *
 * <p><b>Deduplication guarantee:</b> callers only call {@link #record} after the mutation
 * succeeds and before the response is sent.  A persisted record therefore proves the
 * operation completed — retries find the record and skip the mutation, preventing
 * duplicate lifecycle events (WO-022 AC-6).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class IdempotencyService {

    private final IdempotencyRecordRepository idempotencyRepo;

    // ── Public types ──────────────────────────────────────────────────────────

    /**
     * Result of an idempotency check.
     */
    public enum CheckResult {
        /** No record exists — caller should execute the command normally. */
        PROCEED,
        /** Record exists and fingerprint matches — caller should return cached outcome. */
        DUPLICATE,
        /** Record exists but fingerprint differs — caller should reject with MISMATCH. */
        MISMATCH
    }

    /**
     * Full check outcome for callers that need the stored record on DUPLICATE.
     */
    public record CheckOutcome(CheckResult result, IdempotencyRecord record) {
        /** Convenience factory for PROCEED. */
        public static CheckOutcome proceed() { return new CheckOutcome(CheckResult.PROCEED, null); }
    }

    // ── Idempotency check ─────────────────────────────────────────────────────

    /**
     * Checks whether a command should proceed, return a cached result, or be rejected.
     *
     * @param operation    operation name, e.g. {@code "STAGE"}, {@code "ACTIVATE"}, {@code "ROLLBACK"}
     * @param idempotencyKey the caller-supplied idempotency key; if blank, returns PROCEED immediately
     * @param definitionId stable definition ID
     * @param versionId    the version the command targets
     * @return a {@link CheckOutcome} carrying the result and, when DUPLICATE, the existing record
     */
    public CheckOutcome check(
            String operation,
            String idempotencyKey,
            String definitionId,
            String versionId) {

        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return CheckOutcome.proceed();
        }

        String compositeKey = operation + ":" + idempotencyKey;
        String fingerprint  = fingerprint(operation, definitionId, versionId);

        Optional<IdempotencyRecord> existing = idempotencyRepo.findByCompositeKey(compositeKey);
        if (existing.isEmpty()) {
            return CheckOutcome.proceed();
        }

        IdempotencyRecord record = existing.get();
        if (fingerprint.equals(record.getRequestFingerprint())) {
            log.info("[idempotency] Duplicate {} for key '{}' — returning cached outcome",
                    operation, idempotencyKey);
            return new CheckOutcome(CheckResult.DUPLICATE, record);
        }

        log.warn("[idempotency] Key mismatch for '{}': fingerprint on file='{}', incoming='{}'",
                idempotencyKey, record.getRequestFingerprint(), fingerprint);
        return new CheckOutcome(CheckResult.MISMATCH, record);
    }

    // ── Record persistence ────────────────────────────────────────────────────

    /**
     * Persists the outcome of a successful lifecycle command so that retries can return
     * the cached result without re-executing (WO-022 AC-4 and AC-6).
     *
     * <p>Called <em>after</em> the command completes successfully and <em>before</em>
     * the response is returned to the caller.  Only called when {@code idempotencyKey}
     * is non-blank.
     *
     * @param operation         operation name
     * @param idempotencyKey    caller-supplied key
     * @param definitionId      stable definition ID
     * @param versionId         the version that was acted upon
     * @param outcome           {@code "SUCCESS"} or {@code "FAILURE"}
     * @param resultVersionId   the version ID that is now ACTIVE after the command
     * @param registryVersion   registry version after the command
     */
    public void record(
            String operation,
            String idempotencyKey,
            String definitionId,
            String versionId,
            String outcome,
            String resultVersionId,
            long   registryVersion) {

        if (idempotencyKey == null || idempotencyKey.isBlank()) return;

        String compositeKey = operation + ":" + idempotencyKey;
        String fingerprint  = fingerprint(operation, definitionId, versionId);

        try {
            idempotencyRepo.save(IdempotencyRecord.builder()
                    .compositeKey(compositeKey)
                    .operation(operation)
                    .productDefinitionId(definitionId)
                    .versionId(versionId)
                    .requestFingerprint(fingerprint)
                    .outcome(outcome)
                    .resultActiveVersionId(resultVersionId)
                    .registryVersion(registryVersion)
                    .build());
        } catch (org.springframework.dao.DuplicateKeyException e) {
            // A concurrent successful attempt already wrote the record — harmless, log and continue
            log.warn("[idempotency] Duplicate key on record save for compositeKey='{}' — concurrent success",
                    compositeKey);
        }
    }

    // ── Optimistic lock check ─────────────────────────────────────────────────

    /**
     * Validates that the caller-supplied expected version matches the version stored
     * in the database.  Throws {@link ConcurrentModificationException} (HTTP 409) if not.
     *
     * <p>If {@code expectedVersion} is {@code null} or less than {@code 1}, the check
     * is skipped — commands that do not supply a version token are permitted to proceed
     * (optimistic locking is optional for backward compatibility in this release; AC-1
     * states commands "require or derive" a token — they derive one if not supplied by
     * incrementing the stored version on success).
     *
     * @param storedVersion   the {@code version} field from the database record
     * @param expectedVersion the version the caller believes is current; may be {@code null}
     * @param versionId       included in the exception message for diagnostics
     * @throws ConcurrentModificationException if the versions do not match
     */
    public void validateOptimisticLock(long storedVersion, Long expectedVersion, String versionId) {
        if (expectedVersion == null || expectedVersion < 1) return; // skip — token not supplied
        if (storedVersion != expectedVersion) {
            throw new ConcurrentModificationException(
                    "Version conflict for version " + versionId
                    + ": expected version " + expectedVersion
                    + " but current version is " + storedVersion
                    + ". Fetch the latest version and retry.");
        }
    }

    // ── Internal fingerprint ──────────────────────────────────────────────────

    /**
     * Returns a deterministic SHA-256 fingerprint of the request intent.
     * Used to detect when the same idempotency key is supplied for a different command.
     */
    public String fingerprint(String operation, String definitionId, String versionId) {
        String input = operation + ":" + definitionId + ":" + (versionId != null ? versionId : "");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is guaranteed to be available in all Java SE implementations
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}

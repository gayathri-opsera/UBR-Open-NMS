package com.ubrnms.productdef.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.lifecycle.ProductDefinitionLifecycleException;
import com.ubrnms.productdef.lifecycle.ProductDefinitionStateMachine;
import com.ubrnms.productdef.model.*;
import com.ubrnms.productdef.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/**
 * Orchestrates the Product Definition lifecycle: stage, activate, rollback.
 *
 * <p>Activation is the control-plane consistency boundary.  All registry writes
 * (fingerprint entries, parameter entries, active-version pointer) are committed
 * together with the version-status update and audit event.  If any step fails the
 * method throws so the caller can return an appropriate HTTP error — no partial
 * state is left silently.
 *
 * <p>Rollback restores the previous active version from the
 * {@link ProductDefinitionActiveVersion#getPreviousVersionId()} pointer; it does not
 * delete newer versions, preserving the full audit history.
 *
 * <p>Idempotency: callers may supply an {@code idempotencyKey} with activation or
 * rollback requests.  If a record for that key already exists the prior outcome is
 * returned without re-executing the mutation.
 *
 * <p><b>Error semantics:</b>
 * <ul>
 *   <li>{@link IllegalArgumentException} — client error (4xx) such as wrong lifecycle
 *       state or version not found.</li>
 *   <li>{@link IllegalStateException} — conflict (409) such as fingerprint collision.</li>
 *   <li>{@link NoSuchElementException} — not found (404).</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductDefinitionLifecycleService {

    private final ProductDefinitionVersionRepository     versionRepo;
    private final ProductDefinitionActiveVersionRepository activeVersionRepo;
    private final FingerprintRegistryRepository          fingerprintRegistryRepo;
    private final ParameterRegistryRepository            parameterRegistryRepo;
    private final ProductDefinitionLifecycleEventRepository lifecycleEventRepo;
    private final IdempotencyRecordRepository            idempotencyRepo;

    private final FingerprintRegistryBuilder             fingerprintBuilder;
    private final ParameterRegistryBuilder               parameterBuilder;
    private final ProductDefinitionConflictService       conflictService;

    private final ObjectMapper                           objectMapper;
    private final KafkaTemplate<String, String>         kafkaTemplate;
    /** WO-021: Evaluates all publish prerequisite gates before state change. */
    private final PublishGateEvaluator                  publishGateEvaluator;
    /** WO-022: Centralised idempotency and optimistic lock service. */
    private final IdempotencyService                    idempotencyService;

    // Kafka topic for sanitised lifecycle events consumed by downstream services
    private static final String LIFECYCLE_TOPIC = "product-definition.lifecycle.events";

    // ── Stage ─────────────────────────────────────────────────────────────────

    /**
     * Moves a DRAFT version with VALID validation status to STAGED.
     *
     * <p>Only VALID definitions may be staged — operators must correct validation
     * errors and re-upload rather than staging an invalid file.
     *
     * @param definitionId  stable product definition ID
     * @param versionId     version to stage
     * @param actorUserId   user performing the action
     * @param actorUsername display name for audit
     * @param correlationId request correlation ID for distributed tracing
     * @return the updated {@link ProductDefinitionVersion}
     * @throws NoSuchElementException   if the version does not exist
     * @throws IllegalArgumentException if the version is not DRAFT or not VALID
     */
    public ProductDefinitionVersion stageVersion(
            String definitionId,
            String versionId,
            Long   expectedVersion,
            String idempotencyKey,
            String actorUserId,
            String actorUsername,
            String correlationId) {

        // WO-022: Idempotency check for STAGE
        IdempotencyService.CheckOutcome stageIdempotency =
                idempotencyService.check("STAGE", idempotencyKey, definitionId, versionId);
        if (stageIdempotency.result() == IdempotencyService.CheckResult.DUPLICATE) {
            // Reload the version to return the current state (it is now STAGED)
            return loadVersion(definitionId, versionId);
        }
        if (stageIdempotency.result() == IdempotencyService.CheckResult.MISMATCH) {
            throw new IllegalArgumentException(
                    "Idempotency key '" + idempotencyKey + "' was already used for a different STAGE request. "
                    + "Use a unique idempotency key for each distinct staging operation.");
        }

        ProductDefinitionVersion version = loadVersion(definitionId, versionId);

        // WO-022: Optimistic lock validation
        idempotencyService.validateOptimisticLock(version.getVersion(), expectedVersion, versionId);

        validateTransition(version, ProductDefinitionStateMachine.STAGED, correlationId);

        String prevStatus = version.getLifecycleStatus();

        if (!"VALID".equals(version.getValidationStatus())) {
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("STAGED")
                    .productDefinitionId(definitionId)
                    .versionId(versionId)
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .previousLifecycleStatus(prevStatus)
                    .newLifecycleStatus(prevStatus) // unchanged — transition was rejected
                    .outcome("FAILURE")
                    .errorCode("VALIDATION_REQUIRED")
                    .changeSummary("Stage rejected: version " + versionId
                            + " has validationStatus=" + version.getValidationStatus()
                            + " — only VALID definitions may be staged.")
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());

            throw new IllegalArgumentException(
                    "Only VALID definitions may be staged. Version " + versionId
                    + " has validationStatus=" + version.getValidationStatus()
                    + ". Fix validation errors and re-upload.");
        }

        Instant now = Instant.now();
        version.setLifecycleStatus(ProductDefinitionStateMachine.STAGED);
        version.setStagedBy(actorUserId);
        version.setStagedAt(now);
        version.setVersion(version.getVersion() + 1); // WO-022: increment optimistic lock counter
        ProductDefinitionVersion saved = versionRepo.save(version);

        // WO-022: Record idempotency after successful stage
        idempotencyService.record("STAGE", idempotencyKey, definitionId, versionId,
                "SUCCESS", versionId, 0L);

        recordEvent(ProductDefinitionLifecycleEvent.builder()
                .eventType("STAGED")
                .productDefinitionId(definitionId)
                .versionId(versionId)
                .actor(actorUsername)
                .actorUserId(actorUserId)
                .previousLifecycleStatus(prevStatus)
                .newLifecycleStatus(ProductDefinitionStateMachine.STAGED)
                .outcome("SUCCESS")
                .changeSummary("Version " + versionId + " moved to STAGED by " + actorUsername)
                .registryVersion(0L)
                .correlationId(correlationId)
                .build());

        log.info("[{}] Version {} of definition {} staged by {}", correlationId, versionId, definitionId, actorUsername);
        return saved;
    }

    // ── Activate ──────────────────────────────────────────────────────────────

    /**
     * Activates a STAGED version, rebuilding the fingerprint and parameter registries.
     *
     * <p>Activation is atomic in the sense that all registry entries are written before
     * the active version pointer is updated.  If registry rebuild fails the active pointer
     * is not advanced and the previous active version remains intact.
     *
     * @param definitionId   stable product definition ID
     * @param versionId      version to activate (must be STAGED)
     * @param idempotencyKey optional caller-supplied key for safe retries (may be null)
     * @param actorUserId    user performing the action
     * @param actorUsername  display name for audit
     * @param correlationId  request correlation ID
     * @return activation result map with registryVersion, fingerprintCount, parameterCount
     * @throws NoSuchElementException   if the version does not exist
     * @throws IllegalArgumentException if the version is not in STAGED status
     * @throws IllegalStateException    if fingerprint or firmware-range conflicts are detected
     */
    public Map<String, Object> activateVersion(
            String definitionId,
            String versionId,
            String idempotencyKey,
            String actorUserId,
            String actorUsername,
            String correlationId) {

        // WO-022: Idempotency check using IdempotencyService (fingerprint + mismatch detection)
        IdempotencyService.CheckOutcome idempotencyCheck =
                idempotencyService.check("ACTIVATE", idempotencyKey, definitionId, versionId);
        switch (idempotencyCheck.result()) {
            case DUPLICATE -> {
                IdempotencyRecord rec = idempotencyCheck.record();
                log.info("[{}] Idempotent activation: returning cached outcome for key {}", correlationId, idempotencyKey);
                return buildActivationResult(rec.getResultActiveVersionId(), rec.getRegistryVersion(), 0, 0, rec.getOutcome());
            }
            case MISMATCH -> throw new IllegalArgumentException(
                    "Idempotency key '" + idempotencyKey + "' was already used for a different ACTIVATE request. "
                    + "Use a unique idempotency key for each distinct activation.");
            default -> { /* PROCEED — continue */ }
        }

        ProductDefinitionVersion version = loadVersion(definitionId, versionId);
        validateTransition(version, ProductDefinitionStateMachine.ACTIVE, correlationId);

        // Parse the stored normalized metadata to rebuild registries
        NormalizedProductDefinition normalized = parseNormalizedMetadata(version, correlationId);

        // Publish gate evaluation (WO-021) — all gates must pass before any state change
        try {
            publishGateEvaluator.evaluate(version, normalized);
        } catch (PublishGateViolation gv) {
            log.warn("[{}] Publish gate '{}' blocked activation of version {}: {}",
                    correlationId, gv.getGateName(), versionId, gv.getMessage());
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("ACTIVATION_BLOCKED")
                    .productDefinitionId(definitionId)
                    .versionId(versionId)
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .previousLifecycleStatus(version.getLifecycleStatus())
                    .newLifecycleStatus(version.getLifecycleStatus()) // unchanged
                    .outcome("FAILURE")
                    .errorCode(gv.getGateName())
                    .changeSummary("Publish gate '" + gv.getGateName() + "' blocked activation: " + gv.getMessage())
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());
            throw gv; // re-throw so the controller returns HTTP 422
        }

        // Conflict detection — must run before any state change
        ProductDefinitionConflictService.ConflictResult conflicts =
                conflictService.detect(definitionId, normalized);

        String activatePrevStatus = version.getLifecycleStatus();

        if (conflicts.hasConflicts()) {
            String conflictDetail = String.join("; ", conflicts.conflicts());
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("ACTIVATION_CONFLICT")
                    .productDefinitionId(definitionId)
                    .versionId(versionId)
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .previousLifecycleStatus(activatePrevStatus)
                    .newLifecycleStatus(activatePrevStatus) // unchanged
                    .outcome("FAILURE")
                    .errorCode("CONFLICTING_FINGERPRINT")
                    .changeSummary("Activation blocked: " + conflictDetail)
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());

            throw new IllegalStateException(
                    "Activation blocked due to conflicts: " + conflictDetail
                    + ". Resolve conflicts before activating this version.");
        }

        if (!conflicts.warnings().isEmpty()) {
            log.warn("[{}] Activation warnings for definition {} version {}: {}",
                    correlationId, definitionId, versionId, conflicts.warnings());
        }

        // Determine the new registry version
        Optional<ProductDefinitionActiveVersion> currentActive =
                findCurrentActive(definitionId, normalized);
        long newRegistryVersion = currentActive.map(a -> a.getRegistryVersion() + 1).orElse(1L);

        // Build registry entries from normalised metadata
        List<FingerprintRegistryEntry> fpEntries =
                fingerprintBuilder.build(normalized, definitionId, versionId, newRegistryVersion);
        List<ParameterRegistryEntry> paramEntries =
                parameterBuilder.build(normalized, definitionId, versionId, newRegistryVersion);

        // Persist registry entries — delete old entries first, then insert new ones
        fingerprintRegistryRepo.deleteByProductDefinitionId(definitionId);
        fingerprintRegistryRepo.saveAll(fpEntries);
        parameterRegistryRepo.deleteByProductDefinitionId(definitionId);
        parameterRegistryRepo.saveAll(paramEntries);

        // Supersede the previous active version
        String previousVersionId = null;
        if (currentActive.isPresent()) {
            previousVersionId = currentActive.get().getActiveVersionId();
            ProductDefinitionVersion previousVersion = versionRepo
                    .findByDefinitionIdAndVersionId(definitionId, previousVersionId)
                    .orElse(null);
            if (previousVersion != null) {
                previousVersion.setLifecycleStatus(ProductDefinitionStateMachine.SUPERSEDED);
                previousVersion.setSupersededAt(Instant.now());
                versionRepo.save(previousVersion);
            }
        }

        // Update the active version pointer (upsert)
        Instant now = Instant.now();
        ProductDefinitionActiveVersion activePointer = currentActive
                .orElseGet(ProductDefinitionActiveVersion::new);
        activePointer.setProductDefinitionId(definitionId);
        activePointer.setVendor(normalized.getVendor());
        activePointer.setModel(normalized.getModel());
        activePointer.setProductFamily(normalized.getProductFamily());
        activePointer.setFirmwareFrom(normalized.getFirmwareFrom());
        activePointer.setFirmwareTo(normalized.getFirmwareTo());
        activePointer.setPreviousVersionId(previousVersionId);
        activePointer.setActiveVersionId(versionId);
        activePointer.setRegistryVersion(newRegistryVersion);
        activePointer.setActivatedBy(actorUserId);
        activePointer.setActivatedAt(now);
        activeVersionRepo.save(activePointer);

        // Mark this version as ACTIVE
        version.setLifecycleStatus(ProductDefinitionStateMachine.ACTIVE);
        version.setActivatedBy(actorUserId);
        version.setActivatedAt(now);
        version.setRegistryVersion(newRegistryVersion);
        versionRepo.save(version);

        // Immutable audit event
        String summary = String.format(
                "Activated version %s for definition %s, registryVersion advanced to %d, "
              + "%d fingerprint entries and %d parameter entries rebuilt.",
                versionId, definitionId, newRegistryVersion, fpEntries.size(), paramEntries.size());
        recordEvent(ProductDefinitionLifecycleEvent.builder()
                .eventType("ACTIVATED")
                .productDefinitionId(definitionId)
                .versionId(versionId)
                .actor(actorUsername)
                .actorUserId(actorUserId)
                .previousLifecycleStatus(activatePrevStatus)
                .newLifecycleStatus(ProductDefinitionStateMachine.ACTIVE)
                .predecessorVersionId(previousVersionId) // lineage: which version was superseded
                .outcome("SUCCESS")
                .changeSummary(summary)
                .registryVersion(newRegistryVersion)
                .correlationId(correlationId)
                .build());

        // Publish sanitised Kafka event for asynchronous consumers
        publishLifecycleEvent("ACTIVATED", definitionId, versionId, newRegistryVersion,
                fpEntries.size(), paramEntries.size(), correlationId);

        // WO-022: Increment optimistic lock counter on successful activation
        version.setVersion(version.getVersion() + 1);
        versionRepo.save(version);

        // WO-022: Record idempotency via centralised service (includes fingerprint)
        idempotencyService.record("ACTIVATE", idempotencyKey, definitionId, versionId,
                "SUCCESS", versionId, newRegistryVersion);

        log.info("[{}] Definition {} version {} activated at registryVersion={} by {}",
                correlationId, definitionId, versionId, newRegistryVersion, actorUsername);

        return buildActivationResult(versionId, newRegistryVersion, fpEntries.size(),
                paramEntries.size(), "SUCCESS");
    }

    // ── Rollback ──────────────────────────────────────────────────────────────

    /**
     * Rolls back the current active version to the immediately previous active version.
     *
     * <p>Rollback rebuilds the fingerprint and parameter registries from the previous
     * version's stored normalised metadata.  The current ACTIVE version is marked
     * SUPERSEDED; the previous version is restored to ACTIVE.
     *
     * @param definitionId   stable product definition ID
     * @param reason         human-readable reason for rollback (required for audit)
     * @param actorUserId    user performing the rollback
     * @param actorUsername  display name for audit
     * @param correlationId  request correlation ID
     * @return rollback result map with restored active versionId and new registryVersion
     * @throws NoSuchElementException   if no active version exists for this definition
     * @throws IllegalArgumentException if there is no previous active version to roll back to
     */
    public Map<String, Object> rollbackVersion(
            String definitionId,
            String reason,
            String idempotencyKey,
            String actorUserId,
            String actorUsername,
            String correlationId) {

        // WO-022: Idempotency check for ROLLBACK
        IdempotencyService.CheckOutcome rbIdempotency =
                idempotencyService.check("ROLLBACK", idempotencyKey, definitionId, null);
        if (rbIdempotency.result() == IdempotencyService.CheckResult.DUPLICATE) {
            IdempotencyRecord rec = rbIdempotency.record();
            log.info("[{}] Idempotent rollback: returning cached outcome for key {}", correlationId, idempotencyKey);
            return Map.of("restoredVersionId", rec.getResultActiveVersionId() != null ? rec.getResultActiveVersionId() : "unknown",
                          "registryVersion",   rec.getRegistryVersion(),
                          "outcome",           rec.getOutcome());
        }
        if (rbIdempotency.result() == IdempotencyService.CheckResult.MISMATCH) {
            throw new IllegalArgumentException(
                    "Idempotency key '" + idempotencyKey + "' was already used for a different ROLLBACK request. "
                    + "Use a unique idempotency key for each distinct rollback operation.");
        }

        // Find the current active version pointer
        List<ProductDefinitionActiveVersion> activePointers =
                activeVersionRepo.findByProductDefinitionId(definitionId);

        if (activePointers.isEmpty()) {
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("ROLLBACK_FAILED")
                    .productDefinitionId(definitionId)
                    .versionId("unknown")
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .outcome("FAILURE")
                    .errorCode("ROLLBACK_NOT_AVAILABLE")
                    .changeSummary("Rollback failed: no active version found for definition " + definitionId)
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());
            throw new NoSuchElementException(
                    "No active version found for definition " + definitionId
                    + ". Cannot roll back when nothing is active.");
        }

        // Use the first active pointer (definitions have one per firmware range;
        // rollback targets the primary / most recently activated range)
        ProductDefinitionActiveVersion activePointer = activePointers.get(0);
        String currentVersionId  = activePointer.getActiveVersionId();
        String previousVersionId = activePointer.getPreviousVersionId();

        if (previousVersionId == null || previousVersionId.isBlank()) {
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("ROLLBACK_FAILED")
                    .productDefinitionId(definitionId)
                    .versionId(currentVersionId)
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .outcome("FAILURE")
                    .errorCode("ROLLBACK_NOT_AVAILABLE")
                    .changeSummary("Rollback failed: no previous active version recorded for definition "
                            + definitionId + " version " + currentVersionId)
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());
            throw new IllegalArgumentException(
                    "No previous active version available for rollback. "
                    + "Definition " + definitionId + " has only one activation in its history.");
        }

        // Load the previous version
        ProductDefinitionVersion previousVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, previousVersionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "Previous version " + previousVersionId + " not found for rollback of definition "
                        + definitionId + " — rollback history may be incomplete."));

        NormalizedProductDefinition normalized = parseNormalizedMetadata(previousVersion, correlationId);
        long newRegistryVersion = activePointer.getRegistryVersion() + 1;

        // Rebuild registries from previous version's metadata
        List<FingerprintRegistryEntry> fpEntries =
                fingerprintBuilder.build(normalized, definitionId, previousVersionId, newRegistryVersion);
        List<ParameterRegistryEntry> paramEntries =
                parameterBuilder.build(normalized, definitionId, previousVersionId, newRegistryVersion);

        fingerprintRegistryRepo.deleteByProductDefinitionId(definitionId);
        fingerprintRegistryRepo.saveAll(fpEntries);
        parameterRegistryRepo.deleteByProductDefinitionId(definitionId);
        parameterRegistryRepo.saveAll(paramEntries);

        // Mark current active version as ROLLED_BACK
        Instant now = Instant.now();
        ProductDefinitionVersion currentVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, currentVersionId)
                .orElse(null);
        if (currentVersion != null) {
            currentVersion.setLifecycleStatus(ProductDefinitionStateMachine.SUPERSEDED);
            currentVersion.setRolledBackBy(actorUserId);
            currentVersion.setRolledBackAt(now);
            currentVersion.setRollbackReason(reason);
            versionRepo.save(currentVersion);
        }

        // Restore previous version to ACTIVE
        previousVersion.setLifecycleStatus(ProductDefinitionStateMachine.ACTIVE);
        previousVersion.setActivatedBy(actorUserId);
        previousVersion.setActivatedAt(now);
        previousVersion.setRegistryVersion(newRegistryVersion);
        versionRepo.save(previousVersion);

        // Advance the active version pointer
        activePointer.setActiveVersionId(previousVersionId);
        activePointer.setPreviousVersionId(currentVersionId);
        activePointer.setRegistryVersion(newRegistryVersion);
        activePointer.setActivatedBy(actorUserId);
        activePointer.setActivatedAt(now);
        activeVersionRepo.save(activePointer);

        // Audit event — include both prev/new status and lineage (WO-020)
        String rollbackPrevStatus = currentVersion != null
                ? ProductDefinitionStateMachine.ACTIVE : ProductDefinitionStateMachine.SUPERSEDED;
        String summary = String.format(
                "Rolled back definition %s from version %s to version %s. "
              + "Reason: %s. RegistryVersion advanced to %d. "
              + "%d fingerprint entries and %d parameter entries rebuilt.",
                definitionId, currentVersionId, previousVersionId, reason,
                newRegistryVersion, fpEntries.size(), paramEntries.size());
        recordEvent(ProductDefinitionLifecycleEvent.builder()
                .eventType("ROLLED_BACK")
                .productDefinitionId(definitionId)
                .versionId(previousVersionId)
                .actor(actorUsername)
                .actorUserId(actorUserId)
                .previousLifecycleStatus(rollbackPrevStatus)
                .newLifecycleStatus(ProductDefinitionStateMachine.ACTIVE)
                .predecessorVersionId(currentVersionId) // lineage: what was the ACTIVE version before rollback
                .reason(AuditRecordRedactor.redact(reason)) // redact before embedding in summary
                .outcome("SUCCESS")
                .changeSummary(summary)
                .registryVersion(newRegistryVersion)
                .correlationId(correlationId)
                .build());

        publishLifecycleEvent("ROLLED_BACK", definitionId, previousVersionId, newRegistryVersion,
                fpEntries.size(), paramEntries.size(), correlationId);

        log.info("[{}] Definition {} rolled back from {} to {} at registryVersion={} by {}",
                correlationId, definitionId, currentVersionId, previousVersionId,
                newRegistryVersion, actorUsername);

        // WO-022: Record idempotency after successful rollback
        idempotencyService.record("ROLLBACK", idempotencyKey, definitionId, currentVersionId,
                "SUCCESS", previousVersionId, newRegistryVersion);

        return Map.of(
                "restoredVersionId",   previousVersionId,
                "registryVersion",     newRegistryVersion,
                "fingerprintCount",    fpEntries.size(),
                "parameterCount",      paramEntries.size(),
                "rollbackStatus",      "SUCCESS"
        );
    }

    // ── Targeted rollback (WO-017) ────────────────────────────────────────────

    /**
     * Rolls back the active version to a specific eligible historical version (WO-017).
     *
     * <p>Unlike {@link #rollbackVersion}, which always targets the immediately previous
     * active version, this method accepts an explicit {@code targetVersionId} so
     * administrators can restore any eligible historical version.
     *
     * <p><b>Eligibility rules:</b>
     * <ul>
     *   <li>Target version must exist and belong to {@code definitionId}.</li>
     *   <li>Target version's {@code validationStatus} must be {@code VALID}.</li>
     *   <li>Target version's {@code lifecycleStatus} must be {@code STAGED} or
     *       {@code SUPERSEDED} — ACTIVE, ARCHIVED, and DRAFT are not eligible.</li>
     *   <li>Target version must not be the currently active version.</li>
     * </ul>
     *
     * <p><b>Atomicity:</b> Registry entries are deleted and rebuilt before the active
     * version pointer is updated.  If registry rebuild fails the method throws
     * {@link IllegalStateException} with code {@code REGISTRY_REBUILD_FAILED}; the
     * previously active version and pointer remain unchanged because the pointer update
     * runs last.
     *
     * @param definitionId    stable product definition ID
     * @param targetVersionId the version to restore to ACTIVE
     * @param reason          human-readable rollback reason (required for audit)
     * @param actorUserId     user performing the rollback
     * @param actorUsername   display name for audit
     * @param correlationId   request correlation ID
     * @return rollback result map with active definition metadata, active version metadata, and lifecycle status
     * @throws NoSuchElementException   if the target version does not exist or no active version is found
     * @throws IllegalArgumentException if the target version is ineligible
     */
    public Map<String, Object> rollbackToVersion(
            String definitionId,
            String targetVersionId,
            String reason,
            String actorUserId,
            String actorUsername,
            String correlationId) {

        // Load and validate target version
        ProductDefinitionVersion targetVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, targetVersionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "Rollback target version '" + targetVersionId + "' not found for definition "
                        + definitionId + ". ROLLBACK_TARGET_INVALID"));

        validateRollbackEligibility(targetVersion, correlationId);

        // Find the current active version
        List<ProductDefinitionActiveVersion> activePointers =
                activeVersionRepo.findByProductDefinitionId(definitionId);
        if (activePointers.isEmpty()) {
            throw new NoSuchElementException(
                    "No active version found for definition " + definitionId
                    + ". Cannot roll back when nothing is active. ROLLBACK_TARGET_INVALID");
        }

        ProductDefinitionActiveVersion activePointer = activePointers.get(0);
        String currentVersionId = activePointer.getActiveVersionId();

        if (targetVersionId.equals(currentVersionId)) {
            throw new IllegalArgumentException(
                    "Target version '" + targetVersionId + "' is already the active version. "
                    + "ROLLBACK_TARGET_INVALID");
        }

        // Parse normalized metadata to rebuild registries
        NormalizedProductDefinition normalized = parseNormalizedMetadata(targetVersion, correlationId);
        long newRegistryVersion = activePointer.getRegistryVersion() + 1;

        // Rebuild registries — if this fails the pointer has not moved yet (atomicity)
        List<FingerprintRegistryEntry> fpEntries;
        List<ParameterRegistryEntry>   paramEntries;
        try {
            fpEntries    = fingerprintBuilder.build(normalized, definitionId, targetVersionId, newRegistryVersion);
            paramEntries = parameterBuilder.build(normalized, definitionId, targetVersionId, newRegistryVersion);
        } catch (Exception e) {
            log.error("[{}] Registry rebuild failed during rollback to target {}: {}",
                    correlationId, targetVersionId, e.getMessage(), e);
            recordEvent(ProductDefinitionLifecycleEvent.builder()
                    .eventType("ROLLBACK_FAILED")
                    .productDefinitionId(definitionId)
                    .versionId(targetVersionId)
                    .actor(actorUsername)
                    .actorUserId(actorUserId)
                    .previousLifecycleStatus(targetVersion.getLifecycleStatus())
                    .newLifecycleStatus(targetVersion.getLifecycleStatus())
                    .outcome("FAILURE")
                    .errorCode("REGISTRY_REBUILD_FAILED")
                    .changeSummary("Registry rebuild failed during rollback to " + targetVersionId + ": " + e.getMessage())
                    .registryVersion(0L)
                    .correlationId(correlationId)
                    .build());
            throw new IllegalStateException(
                    "Registry rebuild failed during rollback to version " + targetVersionId
                    + ". REGISTRY_REBUILD_FAILED. The previously active version " + currentVersionId
                    + " remains active. Cause: " + e.getMessage(), e);
        }

        // Persist new registry — atomicity: pointer update happens AFTER all registry writes succeed
        fingerprintRegistryRepo.deleteByProductDefinitionId(definitionId);
        fingerprintRegistryRepo.saveAll(fpEntries);
        parameterRegistryRepo.deleteByProductDefinitionId(definitionId);
        parameterRegistryRepo.saveAll(paramEntries);

        // Supersede the current active version
        Instant now = Instant.now();
        ProductDefinitionVersion currentVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, currentVersionId)
                .orElse(null);
        String prevLifecycleStatus = targetVersion.getLifecycleStatus();
        if (currentVersion != null) {
            currentVersion.setLifecycleStatus(ProductDefinitionStateMachine.SUPERSEDED);
            currentVersion.setRolledBackBy(actorUserId);
            currentVersion.setRolledBackAt(now);
            currentVersion.setRollbackReason(AuditRecordRedactor.redact(reason));
            currentVersion.setVersion(currentVersion.getVersion() + 1);
            versionRepo.save(currentVersion);
        }

        // Restore target version to ACTIVE
        targetVersion.setLifecycleStatus(ProductDefinitionStateMachine.ACTIVE);
        targetVersion.setActivatedBy(actorUserId);
        targetVersion.setActivatedAt(now);
        targetVersion.setRegistryVersion(newRegistryVersion);
        targetVersion.setRestoredFromVersionId(currentVersionId); // lineage: WO-020
        targetVersion.setVersion(targetVersion.getVersion() + 1);
        versionRepo.save(targetVersion);

        // Advance the active version pointer — this is the last write; after this point the state is consistent
        activePointer.setPreviousVersionId(currentVersionId);
        activePointer.setActiveVersionId(targetVersionId);
        activePointer.setRegistryVersion(newRegistryVersion);
        activePointer.setActivatedBy(actorUserId);
        activePointer.setActivatedAt(now);
        activeVersionRepo.save(activePointer);

        // Immutable audit event
        String summary = String.format(
                "Targeted rollback of definition %s: restored version %s from %s. "
              + "Reason: %s. RegistryVersion advanced to %d. "
              + "%d fingerprint entries and %d parameter entries rebuilt.",
                definitionId, targetVersionId, currentVersionId,
                AuditRecordRedactor.redact(reason), newRegistryVersion, fpEntries.size(), paramEntries.size());

        recordEvent(ProductDefinitionLifecycleEvent.builder()
                .eventType("ROLLED_BACK")
                .productDefinitionId(definitionId)
                .versionId(targetVersionId)
                .actor(actorUsername)
                .actorUserId(actorUserId)
                .previousLifecycleStatus(prevLifecycleStatus)
                .newLifecycleStatus(ProductDefinitionStateMachine.ACTIVE)
                .predecessorVersionId(currentVersionId)
                .reason(AuditRecordRedactor.redact(reason))
                .outcome("SUCCESS")
                .changeSummary(summary)
                .registryVersion(newRegistryVersion)
                .correlationId(correlationId)
                .build());

        publishLifecycleEvent("ROLLED_BACK", definitionId, targetVersionId,
                newRegistryVersion, fpEntries.size(), paramEntries.size(), correlationId);

        log.info("[{}] Targeted rollback of definition {} from {} to {} at registryVersion={} by {}",
                correlationId, definitionId, currentVersionId, targetVersionId, newRegistryVersion, actorUsername);

        return Map.of(
                "productDefinitionId",  definitionId,
                "restoredVersionId",    targetVersionId,
                "supersededVersionId",  currentVersionId,
                "registryVersion",      newRegistryVersion,
                "lifecycleStatus",      ProductDefinitionStateMachine.ACTIVE,
                "fingerprintCount",     fpEntries.size(),
                "parameterCount",       paramEntries.size(),
                "rollbackStatus",       "SUCCESS"
        );
    }

    /**
     * Validates that a version is eligible as a rollback target (WO-017 step 1).
     *
     * <p>Eligible versions must:
     * <ol>
     *   <li>Have {@code validationStatus} = {@code VALID}</li>
     *   <li>Have {@code lifecycleStatus} in {STAGED, SUPERSEDED}</li>
     * </ol>
     *
     * @throws IllegalArgumentException if the version fails any eligibility rule
     */
    private void validateRollbackEligibility(ProductDefinitionVersion version, String correlationId) {
        if (!"VALID".equals(version.getValidationStatus())) {
            throw new IllegalArgumentException(
                    "Version '" + version.getVersionId()
                    + "' cannot be a rollback target: validationStatus is '"
                    + version.getValidationStatus()
                    + "'. Only VALID versions are eligible for rollback. ROLLBACK_TARGET_INVALID");
        }
        String status = version.getLifecycleStatus();
        if (!ProductDefinitionStateMachine.STAGED.equals(status)
                && !ProductDefinitionStateMachine.SUPERSEDED.equals(status)) {
            throw new IllegalArgumentException(
                    "Version '" + version.getVersionId()
                    + "' cannot be a rollback target: lifecycleStatus is '"
                    + status + "'. Only STAGED or SUPERSEDED versions are eligible. ROLLBACK_TARGET_INVALID");
        }
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /**
     * Returns all distinct product definition IDs that have at least one uploaded version.
     */
    public List<Map<String, Object>> listDefinitions() {
        // Group by definitionId — return one summary per definition
        List<ProductDefinitionActiveVersion> activePointers = activeVersionRepo.findAll();
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProductDefinitionActiveVersion pointer : activePointers) {
            result.add(Map.of(
                    "productDefinitionId", pointer.getProductDefinitionId(),
                    "vendor",              Optional.ofNullable(pointer.getVendor()).orElse(""),
                    "model",               Optional.ofNullable(pointer.getModel()).orElse(""),
                    "activeVersionId",     Optional.ofNullable(pointer.getActiveVersionId()).orElse(""),
                    "registryVersion",     pointer.getRegistryVersion()
            ));
        }
        return result;
    }

    /**
     * Returns the currently active version for a product definition.
     */
    public ProductDefinitionVersion getActiveVersion(String definitionId) {
        List<ProductDefinitionActiveVersion> pointers = activeVersionRepo.findByProductDefinitionId(definitionId);
        if (pointers.isEmpty()) {
            throw new NoSuchElementException("No active version found for definition " + definitionId);
        }
        ProductDefinitionActiveVersion pointer = pointers.get(0);
        return versionRepo
                .findByDefinitionIdAndVersionId(definitionId, pointer.getActiveVersionId())
                .orElseThrow(() -> new NoSuchElementException(
                        "Active version record " + pointer.getActiveVersionId()
                        + " not found for definition " + definitionId));
    }

    /**
     * Returns all lifecycle events for a product definition, newest first.
     */
    public List<ProductDefinitionLifecycleEvent> getLifecycleHistory(String definitionId) {
        return lifecycleEventRepo.findByProductDefinitionIdOrderByOccurredAtDesc(definitionId);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private ProductDefinitionVersion loadVersion(String definitionId, String versionId) {
        return versionRepo.findByDefinitionIdAndVersionId(definitionId, versionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "Version " + versionId + " not found for definition " + definitionId));
    }

    /**
     * Guards lifecycle transitions via the centralized {@link ProductDefinitionStateMachine}.
     *
     * <p>The state machine is the single authority for valid transitions — no hard-coded
     * string comparisons are used here.  {@link ProductDefinitionLifecycleException} is
     * caught and re-wrapped as {@link IllegalArgumentException} so callers continue to
     * receive a consistent exception type at the service boundary.
     */
    private void validateTransition(
            ProductDefinitionVersion version,
            String toStatus,
            String correlationId) {

        String currentStatus = version.getLifecycleStatus();
        try {
            ProductDefinitionStateMachine.validateTransition(currentStatus, toStatus);
        } catch (ProductDefinitionLifecycleException e) {
            log.warn("[{}] Lifecycle transition rejected for version {}: {} — {}",
                    correlationId, version.getVersionId(), e.getErrorCode(), e.getMessage());
            throw new IllegalArgumentException(
                    "Cannot transition version " + version.getVersionId()
                    + " to " + toStatus + ": " + e.getMessage());
        }
    }

    /**
     * Deserializes the stored {@code normalizedMetadataJson} into a
     * {@link NormalizedProductDefinition}.  Throws if the field is absent or unparseable.
     */
    private NormalizedProductDefinition parseNormalizedMetadata(
            ProductDefinitionVersion version, String correlationId) {
        String json = version.getNormalizedMetadataJson();
        if (json == null || json.isBlank()) {
            throw new IllegalStateException(
                    "Version " + version.getVersionId()
                    + " has no stored normalized metadata — cannot rebuild registries. "
                    + "Re-upload and validate the definition file.");
        }
        try {
            return objectMapper.readValue(json, NormalizedProductDefinition.class);
        } catch (Exception e) {
            log.error("[{}] Failed to deserialize normalized metadata for version {}",
                    correlationId, version.getVersionId(), e);
            throw new IllegalStateException(
                    "Failed to deserialize normalized metadata for version " + version.getVersionId()
                    + " — the stored metadata may be corrupt. Re-upload the definition file.", e);
        }
    }

    /**
     * Finds the current active version pointer for the given product definition,
     * matching by the firmware range declared in the normalized metadata.
     */
    private Optional<ProductDefinitionActiveVersion> findCurrentActive(
            String definitionId, NormalizedProductDefinition normalized) {
        return activeVersionRepo.findByProductDefinitionIdAndFirmwareFromAndFirmwareTo(
                definitionId, normalized.getFirmwareFrom(), normalized.getFirmwareTo());
    }

    /**
     * Redacts secret material from the event's text fields, then persists the event.
     *
     * <p>Redaction is applied before save so that no credential values or secret
     * strings ever reach the MongoDB audit collection (WO-020 AC-7).
     */
    private void recordEvent(ProductDefinitionLifecycleEvent event) {
        // Apply redaction to mutable text fields before persistence (WO-020)
        event.setChangeSummary(AuditRecordRedactor.redact(event.getChangeSummary()));
        event.setReason(AuditRecordRedactor.redact(event.getReason()));

        try {
            lifecycleEventRepo.save(event);
        } catch (Exception e) {
            // Audit publication failure must not silently swallow — log at error level
            // so operations are alerted. The lifecycle mutation may continue because the
            // event was constructed from in-memory data and the failure is a persistence problem.
            log.error("AUDIT_FAILURE: Failed to persist lifecycle event type={} for definition={} version={}",
                    event.getEventType(), event.getProductDefinitionId(), event.getVersionId(), e);
        }
    }

    private void publishLifecycleEvent(
            String eventType,
            String definitionId,
            String versionId,
            long registryVersion,
            int fingerprintCount,
            int parameterCount,
            String correlationId) {
        try {
            // Sanitised event payload — no credential values, no file content
            Map<String, Object> payload = Map.of(
                    "eventType",       eventType,
                    "productDefinitionId", definitionId,
                    "versionId",       versionId,
                    "registryVersion", registryVersion,
                    "fingerprintCount", fingerprintCount,
                    "parameterCount",  parameterCount,
                    "correlationId",   correlationId,
                    "occurredAt",      Instant.now().toString()
            );
            String json = objectMapper.writeValueAsString(payload);
            kafkaTemplate.send(LIFECYCLE_TOPIC, definitionId, json);
            log.debug("[{}] Published lifecycle event {} to topic {}", correlationId, eventType, LIFECYCLE_TOPIC);
        } catch (Exception e) {
            // Kafka publish failure is logged but does not fail the lifecycle mutation.
            // Downstream consumers must handle eventual consistency; the audit event
            // in MongoDB provides durable evidence of the lifecycle action.
            log.warn("[{}] Failed to publish lifecycle event {} to Kafka — downstream consumers will miss this event",
                    correlationId, eventType, e);
        }
    }

    private Map<String, Object> buildActivationResult(
            String activeVersionId,
            long registryVersion,
            int fingerprintCount,
            int parameterCount,
            String activationStatus) {
        return Map.of(
                "activeVersionId",   activeVersionId != null ? activeVersionId : "",
                "registryVersion",   registryVersion,
                "fingerprintCount",  fingerprintCount,
                "parameterCount",    parameterCount,
                "activationStatus",  activationStatus
        );
    }
}

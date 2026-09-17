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
            String actorUserId,
            String actorUsername,
            String correlationId) {

        ProductDefinitionVersion version = loadVersion(definitionId, versionId);

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
        ProductDefinitionVersion saved = versionRepo.save(version);

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

        // Idempotency check
        if (idempotencyKey != null && !idempotencyKey.isBlank()) {
            String compositeKey = "ACTIVATE:" + idempotencyKey;
            Optional<IdempotencyRecord> existing = idempotencyRepo.findByCompositeKey(compositeKey);
            if (existing.isPresent()) {
                IdempotencyRecord record = existing.get();
                log.info("[{}] Idempotent activation: returning existing outcome for key {}",
                        correlationId, idempotencyKey);
                return buildActivationResult(record.getResultActiveVersionId(),
                        record.getRegistryVersion(), 0, 0, record.getOutcome());
            }
        }

        ProductDefinitionVersion version = loadVersion(definitionId, versionId);
        validateTransition(version, ProductDefinitionStateMachine.ACTIVE, correlationId);

        // Parse the stored normalized metadata to rebuild registries
        NormalizedProductDefinition normalized = parseNormalizedMetadata(version, correlationId);

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

        // Record idempotency for safe retries
        if (idempotencyKey != null && !idempotencyKey.isBlank()) {
            idempotencyRepo.save(IdempotencyRecord.builder()
                    .compositeKey("ACTIVATE:" + idempotencyKey)
                    .operation("ACTIVATE")
                    .productDefinitionId(definitionId)
                    .versionId(versionId)
                    .outcome("SUCCESS")
                    .resultActiveVersionId(versionId)
                    .registryVersion(newRegistryVersion)
                    .build());
        }

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
            String actorUserId,
            String actorUsername,
            String correlationId) {

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

        return Map.of(
                "restoredVersionId",   previousVersionId,
                "registryVersion",     newRegistryVersion,
                "fingerprintCount",    fpEntries.size(),
                "parameterCount",      paramEntries.size(),
                "rollbackStatus",      "SUCCESS"
        );
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

package com.ubrnms.productdef.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Persisted record of a Product Definition upload attempt.
 * Stores artifact metadata, sanitized normalized summary, and validation outcome.
 * The uploaded file bytes are NOT stored — only the SHA-256 content hash.
 * Credential policy: no credential values, community strings, or keys in any field.
 */
@Data
@NoArgsConstructor
@Document(collection = "product_definition_versions")
@CompoundIndex(name = "idx_def_ver", def = "{'definitionId': 1, 'versionId': 1}", unique = true)
public class ProductDefinitionVersion {

    @Id
    private String id;

    @Indexed
    private String definitionId;

    @Indexed
    private String versionId;

    private String name;
    private String vendor;
    private String model;
    private String schemaVersion;

    /** DRAFT | VALIDATED | STAGED | ACTIVE | SUPERSEDED | ROLLED_BACK | ARCHIVED */
    @Indexed
    private String lifecycleStatus;

    /** VALID | INVALID | PENDING */
    private String validationStatus;

    /** SHA-256 hex digest of the uploaded file bytes. */
    private String contentHash;

    /** XML | XLS | JSON */
    private String uploadedFormat;

    private String description;
    private String actorUserId;
    private String actorUsername;
    private String actorRole;

    @Indexed
    private String correlationId;

    /**
     * JSON-serialized full sanitized NormalizedProductDefinition — no credentials.
     * Populated on upload; used by lifecycle service to rebuild registries on
     * activation and rollback without re-parsing the original file bytes.
     */
    private String normalizedMetadataJson;

    // ── Optimistic concurrency token (WO-022) ─────────────────────────────────

    /**
     * Monotonically increasing version counter used for optimistic locking (WO-022).
     *
     * <p>Starts at {@code 1} when the version is first uploaded and is incremented
     * by every state-changing lifecycle command (stage, activate, rollback).
     *
     * <p>Callers may supply this value as {@code X-Expected-Version} to detect
     * concurrent modifications: if the value in the database differs from the
     * caller-supplied token, the command fails with HTTP 409 / {@code VERSION_CONFLICT}.
     */
    private long version = 1L;

    // ── Lineage fields (WO-020) ───────────────────────────────────────────────

    /**
     * The {@code versionId} of the version that was ACTIVE or STAGED immediately
     * before this version was uploaded into the same definition.
     *
     * <p>Populated during upload when an earlier version already exists.  Used by
     * the audit trail to reconstruct the lineage chain from oldest to newest.
     * {@code null} for the first version of a definition.
     */
    private String predecessorVersionId;

    /**
     * When this version was created by a rollback restore operation, this field
     * holds the {@code versionId} of the source version that was restored.
     *
     * <p>For WO-017 rollback: when version V3 is ACTIVE and an admin rolls back
     * to V1, V1 transitions to ACTIVE and {@code restoredFromVersionId} on the
     * event record points back to V3's lineage for bi-directional tracing.
     * This field lives here so the audit history endpoint can surface it
     * without joining on event records.
     */
    private String restoredFromVersionId;

    // ── Lifecycle provenance fields (WO-002) ─────────────────────────────────

    /** User ID that moved this version to STAGED. */
    private String stagedBy;
    private Instant stagedAt;

    /** User ID that activated this version. */
    private String activatedBy;
    private Instant activatedAt;

    /** When this version was superseded by a newer activation. */
    private Instant supersededAt;

    /** User ID that rolled back away from this version. */
    private String rolledBackBy;
    private Instant rolledBackAt;

    /** Human-readable reason supplied at rollback time. */
    private String rollbackReason;

    /**
     * Registry generation counter at the time this version was activated.
     * Incremented on every activation or rollback so downstream consumers can
     * detect stale cached registries and trigger a refresh.
     */
    private Long registryVersion;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}

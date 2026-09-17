package com.ubrnms.productdef.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Single-document active-version pointer for a Product Definition identity + firmware range.
 *
 * <p>There is at most one ACTIVE version per {@code (productDefinitionId, firmwareFrom, firmwareTo)}
 * tuple at any given time.  Activation replaces this document (upsert), and rollback restores it
 * to the previous version so downstream consumers always read a consistent pointer.
 *
 * <p>This collection is the source of truth for "what is currently active" and is the
 * document that conflict detection locks on during activation.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "product_definition_active_versions")
@CompoundIndex(
    name   = "idx_pav_def_fw",
    def    = "{'productDefinitionId': 1, 'firmwareFrom': 1, 'firmwareTo': 1}",
    unique = true
)
public class ProductDefinitionActiveVersion {

    @Id
    private String id;

    /** Stable definition ID (vendor-model slug, e.g. {@code cisco-asr-1000}). */
    @Indexed
    private String productDefinitionId;

    // ── Product identity ────────────────────────────────────────────────────

    private String vendor;
    private String model;
    private String productFamily;

    /**
     * Firmware version lower bound covered by the active version.
     * May be null for definitions that apply to all firmware versions.
     */
    private String firmwareFrom;

    /**
     * Firmware version upper bound covered by the active version.
     * May be null for definitions that apply to all firmware versions.
     */
    private String firmwareTo;

    // ── Active version pointers ──────────────────────────────────────────────

    /** The currently active version ID. */
    private String activeVersionId;

    /**
     * The version that was active before the most recent activation.
     * Used by rollback to restore the prior state without needing to
     * scan lifecycle event history.
     */
    private String previousVersionId;

    // ── Registry versioning ──────────────────────────────────────────────────

    /**
     * Monotonically increasing counter.  Incremented on every activation or
     * rollback.  Downstream consumers cache by this value to avoid reloading
     * unchanged registries.
     */
    private long registryVersion;

    // ── Provenance ───────────────────────────────────────────────────────────

    private String activatedBy;
    private Instant activatedAt;

    @LastModifiedDate
    private Instant updatedAt;
}

package com.ubrnms.productdef.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Immutable audit record for a Product Definition lifecycle action.
 *
 * <p>One event is emitted for every stage, activation, activation conflict, rollback,
 * or rollback failure.  Documents in this collection are never updated after creation —
 * audit integrity requires that each event is a complete, self-contained record.
 *
 * <p><b>Credential policy:</b> {@code changeSummary} and all other fields must contain
 * only sanitised metadata.  No credential values, community strings, uploaded file
 * contents, or vault paths may appear in any field.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "product_definition_lifecycle_events")
@CompoundIndex(name = "idx_plev_def_type", def = "{'productDefinitionId': 1, 'eventType': 1}")
public class ProductDefinitionLifecycleEvent {

    @Id
    private String id;

    /**
     * Discriminator for the type of lifecycle action that produced this event.
     * Values: {@code STAGED}, {@code ACTIVATED}, {@code ACTIVATION_CONFLICT},
     * {@code ROLLED_BACK}, {@code ROLLBACK_FAILED}.
     */
    @Indexed
    private String eventType;

    /** Stable product definition ID (e.g. {@code cisco-asr-1000}). */
    @Indexed
    private String productDefinitionId;

    /** The version ID that was acted upon. */
    private String versionId;

    /** Username of the actor who triggered the lifecycle action. */
    private String actor;

    /** User ID of the actor. */
    private String actorUserId;

    /**
     * Outcome of the action.
     * Values: {@code SUCCESS}, {@code FAILURE}.
     */
    private String outcome;

    /**
     * Machine-readable error code when {@code outcome} is {@code FAILURE}.
     * Values: {@code VALIDATION_REQUIRED}, {@code ACTIVATION_BLOCKED},
     * {@code CONFLICTING_FINGERPRINT}, {@code ROLLBACK_NOT_AVAILABLE},
     * {@code INTERNAL_ERROR}.
     */
    private String errorCode;

    /**
     * Sanitised human-readable description of what changed.
     * Must not contain file contents, credential values, or PII beyond username.
     * Example: "Activated version v2, registryVersion advanced to 7,
     *   12 fingerprint entries and 45 parameter entries rebuilt."
     */
    private String changeSummary;

    /**
     * Registry version in effect after this event completed.
     * Zero for failed or conflict events that did not advance the registry.
     */
    private long registryVersion;

    /**
     * Request correlation ID from the originating API call.
     * Enables distributed tracing across gateway, service, and audit logs.
     */
    @Indexed
    private String correlationId;

    @CreatedDate
    private Instant occurredAt;
}

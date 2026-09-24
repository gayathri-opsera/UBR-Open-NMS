package com.ubrnms.productdef.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/**
 * Idempotency record for safe lifecycle retries.
 *
 * <p>When a caller supplies an {@code idempotencyKey} with an activation or rollback
 * request, the service checks this collection before executing the mutation.  If a
 * record already exists for the same {@code (operation, idempotencyKey)} pair the
 * previous outcome is returned without re-executing the action.
 *
 * <p>This prevents double-activation or duplicate audit events when clients retry
 * a timed-out request.  A distinct key on a second attempt is treated as a new,
 * independent request and is safe to execute independently (no conflicting active
 * pointers can result because the conflict guard runs independently).
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "idempotency_records")
public class IdempotencyRecord {

    @Id
    private String id;

    /**
     * Composite uniqueness key: {@code "<operation>:<callerSuppliedIdempotencyKey>"}.
     * Indexed with uniqueness so duplicate inserts fail fast.
     */
    @Indexed(unique = true)
    private String compositeKey;

    /**
     * Operation name.  Values: {@code ACTIVATE}, {@code ROLLBACK}.
     */
    private String operation;

    /** Stable product definition ID the operation targeted. */
    private String productDefinitionId;

    /** Version ID that was activated or rolled back. */
    private String versionId;

    /**
     * WO-022: SHA-256 hash of {@code "<operation>:<definitionId>:<versionId>"}.
     *
     * <p>Used to detect when the same idempotency key is reused with different
     * request parameters.  If the fingerprint on a retry differs from the original,
     * the service rejects the request with {@code IDEMPOTENCY_KEY_MISMATCH}.
     */
    private String requestFingerprint;

    /**
     * Outcome recorded when the record was first written.
     * Values: {@code SUCCESS}, {@code FAILURE}.
     */
    private String outcome;

    /**
     * The version ID that ended up active after this operation.
     * Null when outcome is FAILURE.
     */
    private String resultActiveVersionId;

    /** Registry version after the operation completed. Zero on failure. */
    private long registryVersion;

    @CreatedDate
    private Instant createdAt;
}

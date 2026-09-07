package com.ubrnms.config.model;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Request body for POST /api/v1/config/history/{deviceId}/{versionId}/rollback (WO-052).
 *
 * <p>Must NOT include credentials, rendered secrets, southbound connection parameters,
 * or configuration content. Only operator intent, identity, and approval metadata.
 */
@Data
@NoArgsConstructor
public class RollbackRequest {

    /**
     * Operator-supplied reason for the rollback.
     * Required — rollback without an auditable reason is not permitted.
     * Maximum 500 characters; control characters are stripped before persistence.
     */
    @NotBlank(message = "reason is required to initiate rollback")
    private String reason;

    /**
     * Username or service account initiating the rollback.
     * If omitted the controller substitutes "system".
     */
    private String actor;

    /**
     * Optional external approval reference (change ticket, incident ID, etc.)
     * for correlation with change management systems.
     */
    private String approvalReference;
}

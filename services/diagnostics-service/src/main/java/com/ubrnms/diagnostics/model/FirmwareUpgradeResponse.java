package com.ubrnms.diagnostics.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Response DTO for firmware upgrade submission (WO-012).
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class FirmwareUpgradeResponse {

    private String jobId;
    private String status;             // PENDING, IN_PROGRESS, COMPLETED, FAILED
    private String firmwarePhase;      // ACCEPTED, PRECHECK, TRANSFER, etc.
    private Instant acceptedAt;
    private String precheckState;      // COMPATIBLE, INCOMPATIBLE, POLICY_BLOCKED, PENDING
    private String trackingUrl;        // URL to query job status

    public static FirmwareUpgradeResponse fromJob(FirmwareJob job) {
        return new FirmwareUpgradeResponse(
                job.getId(),
                job.getStatus(),
                job.getFirmwarePhase(),
                job.getAcceptedAt(),
                job.getCompatibilityDecision(),
                "/api/v1/operations/firmware-jobs/" + job.getId()
        );
    }
}

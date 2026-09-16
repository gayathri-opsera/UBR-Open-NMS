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
import java.util.List;

/**
 * Persisted validation report for a Product Definition version.
 * One report is created per upload attempt and linked to its version by
 * definitionId + versionId.  Reports are immutable once written.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "product_definition_validation_reports")
@CompoundIndex(name = "idx_report_def_ver", def = "{'definitionId': 1, 'versionId': 1}", unique = true)
public class ValidationReport {

    @Id
    private String id;

    @Indexed
    private String definitionId;

    @Indexed
    private String versionId;

    /** VALID | INVALID */
    private String status;

    private List<ValidationError> errors;
    private List<ValidationError> warnings;

    private int parameterCount;
    private int fingerprintCount;
    private int protocolCount;

    /**
     * Human-readable summary of the normalized model (safe to display).
     * Example: "Cisco ASR 1000 — 3 fingerprints, 2 protocols, 12 parameters"
     */
    private String normalizedSummary;

    @Indexed
    private String correlationId;

    @CreatedDate
    private Instant createdAt;
}

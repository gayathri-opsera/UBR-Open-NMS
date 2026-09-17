package com.ubrnms.productdef.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.CompoundIndexes;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.List;

/**
 * Runtime parameter registry entry generated from an activated Product Definition.
 *
 * <p>Each parameter within a parameter group of an activated definition produces
 * one entry.  Registry rebuild replaces all entries for the definition atomically.
 * Downstream polling, UI, and threshold services read this collection to know
 * <em>what</em> to collect and <em>how</em> to collect it for a given device.
 *
 * <p><b>Credential policy:</b> adapter mappings may reference an OID, API path,
 * or gRPC field — no credential values, community strings, or vault paths may
 * appear in any field.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Document(collection = "parameter_registry_entries")
@CompoundIndexes({
    @CompoundIndex(
        name = "idx_preg_def_grp_param",
        def  = "{'productDefinitionId': 1, 'groupId': 1, 'parameterId': 1}",
        unique = true
    ),
    @CompoundIndex(
        name = "idx_preg_def_ver",
        def  = "{'productDefinitionId': 1, 'registryVersion': 1}"
    )
})
public class ParameterRegistryEntry {

    @Id
    private String id;

    /** Stable product definition ID this entry belongs to. */
    @Indexed
    private String productDefinitionId;

    /** The activated version that produced this entry. */
    private String versionId;

    // ── Parameter identity ──────────────────────────────────────────────────

    /** Parameter group name (e.g. {@code radio}, {@code cpu}). */
    private String groupId;

    /** Stable parameter ID within the group (e.g. {@code rsrp}). */
    private String parameterId;

    private String displayName;

    /** One of: NUMERIC, FLOAT, STRING, ENUM, BOOLEAN */
    private String dataType;

    private String unit;
    private String defaultValue;

    /** Inclusive minimum for NUMERIC/FLOAT parameters. */
    private Double minValue;

    /** Inclusive maximum for NUMERIC/FLOAT parameters. */
    private Double maxValue;

    /** Allowed values for ENUM parameters. */
    private List<String> enumValues;

    // ── Adapter mappings ─────────────────────────────────────────────────────

    /** SNMP OID string (dotted-numeric, e.g. {@code 1.3.6.1.4.1.9.2.1.56.0}). */
    private String snmpOid;

    /** CLI command template. Must be allow-listed; no shell-escape sequences. */
    private String cliCommand;

    /** Regex to extract the value from CLI command output. */
    private String cliParseRegex;

    /** REST API path (e.g. {@code /api/v1/system/cpu}). */
    private String apiPath;

    /** gRPC field path for GRPC protocol adapters. */
    private String grpcPath;

    // ── UI metadata ──────────────────────────────────────────────────────────

    /**
     * Roles that may view this parameter in the adaptive UI.
     * Null or empty means the parameter is visible to all authenticated users.
     */
    private List<String> uiVisibleTo;

    /**
     * High-threshold string used by the alarm service.
     * Compared numerically for NUMERIC/FLOAT parameters.
     */
    private String thresholdHigh;

    /** Low-threshold string used by the alarm service. */
    private String thresholdLow;

    /**
     * Whether this parameter is read-only (display-only, never polled for writes).
     * Informational — the poller does not attempt to set read-only parameters.
     */
    private boolean readOnly;

    // ── Registry versioning ──────────────────────────────────────────────────

    /**
     * Registry generation counter advanced on every activation or rollback.
     * Consumers can use this to detect and discard stale cached entries.
     */
    private long registryVersion;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}

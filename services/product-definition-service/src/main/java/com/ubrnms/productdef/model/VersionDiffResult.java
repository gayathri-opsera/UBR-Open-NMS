package com.ubrnms.productdef.model;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * Result of a parameter-level diff between two Product Definition versions.
 *
 * <p>The diff compares the {@code normalizedMetadataJson} stored in each
 * {@link ProductDefinitionVersion} document, so it does not require re-parsing
 * the original file bytes and works for any version in the version history.
 */
@Data
@Builder
public class VersionDiffResult {

    private String definitionId;
    private String fromVersionId;
    private String toVersionId;

    /** Vendor + model identity line (from toVersion). */
    private String vendor;
    private String model;

    /** Total parameters in fromVersion. */
    private int fromParamCount;
    /** Total parameters in toVersion. */
    private int toParamCount;

    /** Parameters present in toVersion but absent in fromVersion. */
    private List<ParamChange> added;

    /** Parameters present in fromVersion but absent in toVersion. */
    private List<ParamChange> removed;

    /**
     * Parameters present in both versions where dataType, unit, label, or
     * min/max changed but the parameter was not removed/added.
     */
    private List<ParamChange> modified;

    /**
     * Parameters present in both versions but under a different groupId.
     * A parameter that moved AND had dataType changes appears in both
     * {@code moved} and {@code modified}.
     */
    private List<ParamChange> moved;

    /**
     * Parameters whose {@code readOnly} flag changed between versions,
     * i.e. a statistic became configurable or vice-versa.
     */
    private List<ParamChange> permissionChanged;

    @Data
    @Builder
    public static class ParamChange {
        /** Stable parameter identifier. */
        private String parameterId;
        /** Human-readable label (from toVersion when available, fromVersion otherwise). */
        private String label;
        /** Group in fromVersion (null for added parameters). */
        private String fromGroupId;
        /** Group in toVersion (null for removed parameters). */
        private String toGroupId;
        /** Data type in fromVersion (null for added). */
        private String fromDataType;
        /** Data type in toVersion (null for removed). */
        private String toDataType;
        /** readOnly flag in fromVersion (null for added). */
        private Boolean fromReadOnly;
        /** readOnly flag in toVersion (null for removed). */
        private Boolean toReadOnly;
        /** One-line plain-English description of what changed. */
        private String summary;
    }
}

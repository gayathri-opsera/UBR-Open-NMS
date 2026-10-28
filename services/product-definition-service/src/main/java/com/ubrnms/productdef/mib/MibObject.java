package com.ubrnms.productdef.mib;

import lombok.Builder;
import lombok.Data;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Represents a single parsed MIB OBJECT-TYPE definition.
 *
 * <p>Populated by {@link MibParser} from the raw MIB text. Every field maps
 * directly to the corresponding clause in the SMIv2 OBJECT-TYPE macro:
 * <pre>
 *   objectName OBJECT-TYPE
 *       SYNTAX      SomeType
 *       MAX-ACCESS  read-write
 *       STATUS      current
 *       DESCRIPTION "..."
 *       INDEX       { indexObj1, indexObj2 }
 *       ::= { parentObject N }
 * </pre>
 */
@Data
@Builder
public class MibObject {

    // ── Identity ──────────────────────────────────────────────────────────────

    /** MIB object name (e.g. {@code radioStatus}). */
    private String name;

    /** Fully resolved numeric OID (e.g. {@code .1.3.6.1.4.1.52619.1.1.1.1.1.33}). */
    private String oid;

    // ── MIB clauses ───────────────────────────────────────────────────────────

    /**
     * Raw MIB SYNTAX value (e.g. {@code Integer32}, {@code OCTET STRING},
     * {@code IpAddress}, {@code INTEGER { enable(0), disable(1) }}).
     */
    private String rawSyntax;

    /**
     * NMS canonical data type derived from {@link #rawSyntax}.
     * One of: INTEGER, STRING, IPADDRESS, BOOLEAN, FLOAT, ENUM, COUNTER,
     * COUNTER32, COUNTER64, GAUGE, GAUGE32, TIMETICKS, OID, OCTETSTRING.
     */
    private String nmsDataType;

    /**
     * MIB MAX-ACCESS value: {@code read-only}, {@code read-write},
     * {@code read-create}, {@code not-accessible}, {@code accessible-for-notify}.
     */
    private String access;

    /** MIB STATUS: {@code current}, {@code deprecated}, or {@code obsolete}. */
    private String status;

    /** MIB DESCRIPTION text (first sentence, trimmed). */
    private String description;

    /** Optional UNITS clause (e.g. "seconds", "milliseconds"). */
    private String units;

    // ── Indexing ──────────────────────────────────────────────────────────────

    /**
     * Index classification derived from the INDEX clause of this object's
     * ancestor table entry. Determines the correct instance OID suffix.
     */
    @Builder.Default
    private MibIndexType indexType = MibIndexType.SCALAR;

    /**
     * Names of the index objects listed in the INDEX { ... } clause of the
     * enclosing table entry. Empty for scalar objects.
     */
    @Builder.Default
    private List<String> indexNames = List.of();

    // ── Enum values ───────────────────────────────────────────────────────────

    /**
     * For INTEGER objects with named values (ENUM in NMS terms).
     * Key = display label (e.g. "enable(0)"), Value = numeric string (e.g. "0").
     * Empty map if not an enumeration type.
     */
    @Builder.Default
    private Map<String, String> enumValues = new LinkedHashMap<>();

    // ── Tree classification ───────────────────────────────────────────────────

    /** True if this is a TABLE object (SYNTAX SEQUENCE OF X) — skipped in output. */
    private boolean table;

    /** True if this is a TABLE ENTRY object (has INDEX clause) — skipped in output. */
    private boolean tableEntry;

    /** True if this is a TABLE COLUMN (parent is an entry, indexed by entry's INDEX). */
    private boolean tableColumn;

    // ── Grouping ──────────────────────────────────────────────────────────────

    /**
     * Section/group name derived from the OID subtree.
     * Examples: {@code configuration}, {@code management}, {@code monitor}, {@code network}.
     */
    private String section;

    /**
     * Sub-group within the section (e.g. {@code radio}, {@code network.ip},
     * {@code monitor.link_stats}). Derived from OID subtree or MIB name conventions.
     */
    private String subSection;

    // ── OID tree metadata ─────────────────────────────────────────────────────

    /** Parent object name from {@code ::= { parentName N }} assignment. */
    private String parentName;

    /** Numeric offset from parent: the {@code N} in {@code ::= { parent N }}. */
    private int childIndex;
}

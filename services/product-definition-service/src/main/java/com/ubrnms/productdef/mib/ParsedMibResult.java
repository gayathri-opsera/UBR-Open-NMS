package com.ubrnms.productdef.mib;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * Result returned by {@link MibParser} after successfully parsing a MIB file.
 *
 * <p>Contains the full list of parsed {@link MibObject}s (columns and scalars only —
 * table and entry objects are excluded), per-type statistics, and the generated
 * discovery XML ready for upload through the standard product-definition pipeline.
 */
@Data
@Builder
public class ParsedMibResult {

    // ── Module metadata ───────────────────────────────────────────────────────

    /** MIB MODULE-IDENTITY name (e.g. {@code UBR-WIRELESS-MIB}). */
    private String moduleName;

    /** Enterprise OID prefix (e.g. {@code .1.3.6.1.4.1.52619}). */
    private String enterpriseOid;

    /** Vendor name inferred from MIB ORGANIZATION or module name. */
    private String vendor;

    /** Product/model name inferred from module name or description. */
    private String productLine;

    // ── Parsed objects ────────────────────────────────────────────────────────

    /**
     * All accessible, non-table-container objects extracted from the MIB.
     * Includes both scalars and table columns. Ordered by OID.
     */
    private List<MibObject> objects;

    // ── Statistics ────────────────────────────────────────────────────────────

    /** Total accessible objects (scalars + table columns). */
    private int totalObjects;

    /** Objects classified as {@link MibIndexType#SCALAR}. */
    private int scalarCount;

    /** Objects classified as {@link MibIndexType#SINGLE_INDEX}. */
    private int singleIndexCount;

    /** Objects classified as {@link MibIndexType#DOUBLE_INDEX}. */
    private int doubleIndexCount;

    /** Objects classified as {@link MibIndexType#TRIPLE_INDEX}. */
    private int tripleIndexCount;

    /** Number of distinct ENUM-typed objects. */
    private int enumCount;

    // ── Generated artifact ────────────────────────────────────────────────────

    /**
     * Discovery XML generated from the parsed objects, ready to be submitted
     * to {@code POST /api/v1/framework/product-definitions/upload} as an XML file.
     *
     * <p>The generated XML uses {@code xmlns="urn:nms:productdef:1.0"} and includes:
     * <ul>
     *   <li>Identity block (vendor, model from MIB metadata)</li>
     *   <li>Fingerprint with enterprise OID</li>
     *   <li>SNMP protocol declaration</li>
     *   <li>Parameter groups with correct data types and OIDs</li>
     *   <li>Scalar objects use their base OID (gateway appends .0 at poll time)</li>
     *   <li>Table columns carry their base column OID (gateway walks for all instances)</li>
     * </ul>
     */
    private String generatedXml;

    // ── Parse diagnostics ─────────────────────────────────────────────────────

    /** Any warnings generated during parsing (e.g. unresolved OIDs, deprecated objects). */
    private List<String> warnings;
}

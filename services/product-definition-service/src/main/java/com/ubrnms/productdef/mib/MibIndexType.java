package com.ubrnms.productdef.mib;

/**
 * Classifies a MIB object's SNMP indexing structure.
 *
 * <p>The INDEX clause in an OBJECT-TYPE definition determines how many index
 * components an instance OID has after the column OID:
 *
 * <ul>
 *   <li>{@link #SCALAR}       — no INDEX ancestor; instance suffix is {@code .0}</li>
 *   <li>{@link #SINGLE_INDEX} — INDEX { x }; one variable index component</li>
 *   <li>{@link #DOUBLE_INDEX} — INDEX { x, y }; two variable index components</li>
 *   <li>{@link #TRIPLE_INDEX} — INDEX { x, y, z }; three variable index components</li>
 * </ul>
 *
 * <p>This is the root cause of the current hand-built XML defect: the XML typed every
 * field as ENUM and applied table indexes to scalar objects, causing SNMP GET to return
 * "not served". The MIB parser reads the INDEX clause directly and populates this field,
 * so the generated XML always carries the correct index structure.
 */
public enum MibIndexType {

    /** Non-table object. Instance OID = column OID + ".0". */
    SCALAR,

    /** Single-index table (e.g. one radio index). Instance OID = column OID + ".N". */
    SINGLE_INDEX,

    /** Double-index table (e.g. radio × station). Instance OID = column OID + ".N.M". */
    DOUBLE_INDEX,

    /** Triple-index table (e.g. three-level MIB hierarchy). Instance OID = column OID + ".N.M.P". */
    TRIPLE_INDEX;

    /**
     * Returns the appropriate index type from the number of INDEX clause components.
     *
     * @param indexCount number of objects named in the INDEX { ... } clause
     * @return the corresponding {@link MibIndexType}
     */
    public static MibIndexType fromIndexCount(int indexCount) {
        return switch (indexCount) {
            case 0  -> SCALAR;
            case 1  -> SINGLE_INDEX;
            case 2  -> DOUBLE_INDEX;
            default -> TRIPLE_INDEX;
        };
    }

    /** Human-readable label for display and XML annotation. */
    public String label() {
        return switch (this) {
            case SCALAR       -> "Scalar (.0)";
            case SINGLE_INDEX -> "Single-index table";
            case DOUBLE_INDEX -> "Double-index table";
            case TRIPLE_INDEX -> "Triple-index table";
        };
    }

    /** Example instance suffix pattern for documentation purposes. */
    public String instancePattern() {
        return switch (this) {
            case SCALAR       -> ".0";
            case SINGLE_INDEX -> ".{i}";
            case DOUBLE_INDEX -> ".{i1}.{i2}";
            case TRIPLE_INDEX -> ".{i1}.{i2}.{i3}";
        };
    }
}

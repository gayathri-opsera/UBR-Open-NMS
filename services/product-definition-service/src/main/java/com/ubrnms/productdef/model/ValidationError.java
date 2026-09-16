package com.ubrnms.productdef.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * A single validation finding attached to a ProductDefinition version.
 * The {@code field} path uses a dot-notation / array-index convention
 * (e.g. {@code "parameters[0].snmpOid"}) so clients can highlight the exact
 * location without re-parsing the uploaded document.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ValidationError {

    /** Stable, machine-readable error code (e.g. {@code OID_INVALID}). */
    private String code;

    /**
     * Dot-notation field path in the normalized model.
     * Examples: {@code "identity.name"}, {@code "fingerprints[0].sysObjectId"},
     * {@code "parameters[0].snmpOid"}.
     */
    private String field;

    /** Human-readable explanation safe to display in operator UIs. */
    private String message;

    /** {@code ERROR} blocks activation; {@code WARNING} is advisory only. */
    private String severity; // ERROR | WARNING
}

package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionVersion;

/**
 * Interface for a composable publish validation gate (WO-021).
 *
 * <p>Each gate validates one specific prerequisite that must be satisfied before
 * a Product Definition version can be activated.  Gates are evaluated in order by
 * {@link PublishGateEvaluator} before any state change or registry rebuild occurs.
 *
 * <p>Gate implementations must be:
 * <ul>
 *   <li><b>Pure</b> — no side effects; reads only, no mutations.</li>
 *   <li><b>Named</b> — return a stable machine-readable {@link #getName()} for structured errors.</li>
 *   <li><b>Self-documenting</b> — throw {@link PublishGateViolation} with a clear remediation message.</li>
 * </ul>
 */
public interface PublishGate {

    /**
     * Machine-readable name of this gate (e.g. {@code SCHEMA_VALIDATION_GATE}).
     * Used as the {@code failedGate} field in structured error responses.
     */
    String getName();

    /**
     * Evaluates this gate against the given version and its normalized metadata.
     *
     * @param version    the version being published
     * @param normalized the parsed normalized definition (may be {@code null} if parsing failed)
     * @throws PublishGateViolation if this gate's prerequisite is not satisfied
     */
    void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized);
}

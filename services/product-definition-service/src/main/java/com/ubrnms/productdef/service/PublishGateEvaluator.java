package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionVersion;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Orchestrates evaluation of all publish validation gates before lifecycle activation (WO-021).
 *
 * <p>All gates are evaluated against the version in sequence.  The first gate that
 * fails throws {@link PublishGateViolation}, which halts evaluation and propagates
 * to the caller.  No partial evaluation or partial failure is allowed — a version
 * either passes all gates or is blocked entirely.
 *
 * <p>Callers in {@link ProductDefinitionLifecycleService} must invoke
 * {@link #evaluate(ProductDefinitionVersion, NormalizedProductDefinition)} before
 * any state mutation so that gate failures are clean: the version stays in STAGED
 * with no partial state changes applied.
 *
 * <p>The list of active gates is {@link PublishGates#ALL_GATES}.  Custom gate
 * lists can be injected for testing.
 */
@Slf4j
@Service
public class PublishGateEvaluator {

    private final List<PublishGate> gates;

    /** Production constructor — uses the canonical gate list. */
    public PublishGateEvaluator() {
        this.gates = PublishGates.ALL_GATES;
    }

    /** Test constructor — allows injecting a custom gate list. */
    public PublishGateEvaluator(List<PublishGate> gates) {
        this.gates = gates;
    }

    /**
     * Evaluates all publish gates against the given version.
     *
     * <p>Returns normally when all gates pass.  Throws {@link PublishGateViolation}
     * (with the {@link PublishGate#getName()} of the first failed gate) when any gate fails.
     *
     * @param version    the version being activated
     * @param normalized the parsed normalized definition; may be {@code null} if parsing failed
     * @throws PublishGateViolation if any gate's prerequisite is not satisfied
     */
    public void evaluate(ProductDefinitionVersion version, NormalizedProductDefinition normalized) {
        for (PublishGate gate : gates) {
            log.debug("Evaluating publish gate {} for version {} of definition {}",
                    gate.getName(), version.getVersionId(), version.getDefinitionId());
            gate.evaluate(version, normalized);
        }
        log.debug("All {} publish gates passed for version {} of definition {}",
                gates.size(), version.getVersionId(), version.getDefinitionId());
    }
}

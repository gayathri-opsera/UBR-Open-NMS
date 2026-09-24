package com.ubrnms.productdef.service;

/**
 * Thrown when a publish validation gate is not satisfied (WO-021).
 *
 * <p>Carries a machine-readable {@link #getGateName()} and a structured
 * description so callers can produce deterministic API error responses
 * without string-matching the message.
 *
 * <p>HTTP mapping: 422 Unprocessable Entity — the request is well-formed
 * but cannot proceed because a publish prerequisite has not been met.
 */
public class PublishGateViolation extends RuntimeException {

    private final String gateName;

    /**
     * @param gateName       machine-readable gate identifier (e.g. {@code SCHEMA_VALIDATION_GATE})
     * @param message        human-readable explanation including what failed and how to fix it
     */
    public PublishGateViolation(String gateName, String message) {
        super(message);
        this.gateName = gateName;
    }

    /**
     * Returns the machine-readable name of the gate that failed.
     * Included in the API error response {@code failedGate} field.
     */
    public String getGateName() {
        return gateName;
    }
}

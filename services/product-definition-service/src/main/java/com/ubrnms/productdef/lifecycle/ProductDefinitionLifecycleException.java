package com.ubrnms.productdef.lifecycle;

/**
 * Thrown when a Product Definition lifecycle operation violates the state machine rules.
 *
 * <p>Carries a machine-readable {@link #errorCode} that callers can use to generate
 * deterministic API error responses without string-matching the message.
 *
 * <p>Error codes defined by {@link ProductDefinitionStateMachine}:
 * <ul>
 *   <li>{@link ProductDefinitionStateMachine#ERR_UNKNOWN_STATE}      — unrecognised state</li>
 *   <li>{@link ProductDefinitionStateMachine#ERR_INVALID_TRANSITION} — transition not in table</li>
 * </ul>
 *
 * <p>This is a {@link RuntimeException} because lifecycle violations are always the result
 * of a programming error or an unexpected API input — they are not recoverable within the
 * same call chain and must propagate up to a controller that converts them to HTTP 409.
 */
public class ProductDefinitionLifecycleException extends RuntimeException {

    private final String errorCode;

    /**
     * @param errorCode machine-readable error code (e.g. {@code INVALID_LIFECYCLE_TRANSITION})
     * @param message   human-readable explanation including which state/transition is invalid
     */
    public ProductDefinitionLifecycleException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    /**
     * @param errorCode machine-readable error code
     * @param message   human-readable explanation
     * @param cause     the underlying cause, if any
     */
    public ProductDefinitionLifecycleException(String errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    /**
     * Returns the machine-readable error code for this lifecycle violation.
     * Controllers should include this in the API error response body.
     */
    public String getErrorCode() {
        return errorCode;
    }
}

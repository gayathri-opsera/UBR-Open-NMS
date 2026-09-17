package com.ubrnms.productdef.lifecycle;

import java.util.*;

/**
 * Centralized lifecycle state machine for Product Definitions.
 *
 * <p>This is the <em>single authority</em> for valid lifecycle states and the transitions
 * between them.  No service, controller, or background worker may mutate a Product
 * Definition's {@code lifecycleStatus} without first calling
 * {@link #validateTransition(String, String)} or {@link #transition(String, String)}.
 *
 * <p><b>State descriptions:</b>
 * <ul>
 *   <li>{@code DRAFT}      — uploaded artifact, validation complete, no registry impact</li>
 *   <li>{@code STAGED}     — VALID definition held for admin review before activation</li>
 *   <li>{@code ACTIVE}     — live; fingerprint and parameter registries are built from this version</li>
 *   <li>{@code SUPERSEDED} — displaced by a newer activation; historical record preserved</li>
 *   <li>{@code ARCHIVED}   — manually retired; no longer in active registry</li>
 * </ul>
 *
 * <p><b>Transition prerequisites</b> — the state machine enforces structural rules (valid
 * {@code from → to} pairs) but not business-level prerequisites (e.g. validation status
 * must be VALID before staging).  Business prerequisites are enforced in the service layer
 * <em>before</em> calling the state machine, so the state machine remains purely structural.
 *
 * <p><b>Usage:</b>
 * <pre>{@code
 *   // Validate only:
 *   ProductDefinitionStateMachine.validateTransition("DRAFT", "STAGED");
 *
 *   // Validate and record metadata:
 *   TransitionResult result = ProductDefinitionStateMachine.transition("STAGED", "ACTIVE");
 *   String newState = result.toState();
 * }</pre>
 */
public final class ProductDefinitionStateMachine {

    private ProductDefinitionStateMachine() { /* utility class — no instances */ }

    // ── Canonical states ──────────────────────────────────────────────────────

    public static final String DRAFT      = "DRAFT";
    public static final String STAGED     = "STAGED";
    public static final String ACTIVE     = "ACTIVE";
    public static final String SUPERSEDED = "SUPERSEDED";
    public static final String ARCHIVED   = "ARCHIVED";

    /** Immutable set of all recognised lifecycle states. */
    public static final Set<String> ALL_STATES = Set.of(DRAFT, STAGED, ACTIVE, SUPERSEDED, ARCHIVED);

    // ── Transition table ──────────────────────────────────────────────────────

    /**
     * Allowed transitions.  The key is the {@code from} state; the value is the set of
     * states the definition may move to from that state.
     *
     * <p>Transition semantics:
     * <ul>
     *   <li>{@code DRAFT → STAGED}       — admin stages a VALID definition for review</li>
     *   <li>{@code STAGED → ACTIVE}      — admin activates; registries are rebuilt</li>
     *   <li>{@code STAGED → DRAFT}       — admin retracts a staged version for revision</li>
     *   <li>{@code ACTIVE → SUPERSEDED}  — system displaces on newer activation</li>
     *   <li>{@code ACTIVE → ARCHIVED}    — admin retires an active definition</li>
     *   <li>{@code DRAFT → ARCHIVED}     — admin discards an unwanted draft</li>
     *   <li>{@code STAGED → ARCHIVED}    — admin discards a staged version</li>
     *   <li>{@code SUPERSEDED → ACTIVE}  — system restores during rollback</li>
     *   <li>{@code SUPERSEDED → ARCHIVED}— admin archives a superseded version</li>
     * </ul>
     */
    private static final Map<String, Set<String>> ALLOWED = Map.of(
        DRAFT,      Set.of(STAGED, ARCHIVED),
        STAGED,     Set.of(ACTIVE, DRAFT, ARCHIVED),
        ACTIVE,     Set.of(SUPERSEDED, ARCHIVED),
        SUPERSEDED, Set.of(ACTIVE, ARCHIVED),
        ARCHIVED,   Set.of()   // terminal — no transitions out of ARCHIVED
    );

    // ── Machine-readable error codes ──────────────────────────────────────────

    /** Error code returned when the {@code from} state is not recognised. */
    public static final String ERR_UNKNOWN_STATE      = "UNKNOWN_LIFECYCLE_STATE";
    /** Error code returned when the transition is structurally invalid. */
    public static final String ERR_INVALID_TRANSITION = "INVALID_LIFECYCLE_TRANSITION";

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Validates that a transition from {@code fromState} to {@code toState} is structurally
     * allowed, throwing {@link ProductDefinitionLifecycleException} if not.
     *
     * <p>This method is <em>pure</em>: it has no side effects and does not consult any
     * repository.  Call it before any persistence operation to guard against invalid state
     * transitions.
     *
     * @param fromState current lifecycle state
     * @param toState   desired lifecycle state
     * @throws ProductDefinitionLifecycleException if the transition is not allowed
     */
    public static void validateTransition(String fromState, String toState) {
        Set<String> allowed = ALLOWED.get(fromState);
        if (allowed == null) {
            throw new ProductDefinitionLifecycleException(
                    ERR_UNKNOWN_STATE,
                    "'" + fromState + "' is not a recognised Product Definition lifecycle state. "
                  + "Known states: " + ALL_STATES);
        }
        if (!allowed.contains(toState)) {
            throw new ProductDefinitionLifecycleException(
                    ERR_INVALID_TRANSITION,
                    "Transition from '" + fromState + "' to '" + toState + "' is not allowed. "
                  + "Valid next states from '" + fromState + "': "
                  + (allowed.isEmpty() ? "none (terminal state)" : allowed));
        }
    }

    /**
     * Validates and returns a {@link TransitionResult} for the given state change.
     *
     * <p>Equivalent to calling {@link #validateTransition} and then constructing a
     * {@link TransitionResult} — use when the caller wants to capture transition metadata.
     *
     * @param fromState current lifecycle state
     * @param toState   desired lifecycle state
     * @return a {@link TransitionResult} confirming the transition is valid
     * @throws ProductDefinitionLifecycleException if the transition is not allowed
     */
    public static TransitionResult transition(String fromState, String toState) {
        validateTransition(fromState, toState);
        return new TransitionResult(fromState, toState);
    }

    /**
     * Returns the set of states that can be reached from the given state.
     * Returns an empty set for terminal states (e.g. {@code ARCHIVED}).
     *
     * @param fromState the current state
     * @return immutable set of reachable states; empty if none or state is unknown
     */
    public static Set<String> allowedTransitionsFrom(String fromState) {
        return ALLOWED.getOrDefault(fromState, Set.of());
    }

    /**
     * Returns {@code true} if the given state string is a recognised lifecycle state.
     * Null and blank inputs return {@code false}.
     */
    public static boolean isKnownState(String state) {
        return state != null && ALL_STATES.contains(state);
    }

    /**
     * Returns {@code true} if the given state is terminal (no outgoing transitions).
     */
    public static boolean isTerminal(String state) {
        Set<String> out = ALLOWED.get(state);
        return out != null && out.isEmpty();
    }

    // ── TransitionResult ──────────────────────────────────────────────────────

    /**
     * Immutable record of a validated lifecycle transition.
     *
     * <p>Returned by {@link #transition} to provide a type-safe confirmation that the
     * transition was validated by the state machine before any persistence occurs.
     */
    public record TransitionResult(String fromState, String toState) {
        public TransitionResult {
            Objects.requireNonNull(fromState, "fromState must not be null");
            Objects.requireNonNull(toState,   "toState must not be null");
        }
    }
}

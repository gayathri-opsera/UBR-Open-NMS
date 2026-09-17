package com.ubrnms.productdef;

import com.ubrnms.productdef.lifecycle.ProductDefinitionLifecycleException;
import com.ubrnms.productdef.lifecycle.ProductDefinitionStateMachine;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.api.Test;

import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.*;

/**
 * Table-driven tests for every allowed and disallowed lifecycle transition.
 * Covers AC-7: "Automated tests cover every allowed and disallowed transition."
 */
class ProductDefinitionStateMachineTest {

    // ── Allowed transitions ───────────────────────────────────────────────────

    static Stream<Arguments> allowedTransitions() {
        return Stream.of(
            // DRAFT can move to STAGED or ARCHIVED
            Arguments.of("DRAFT",      "STAGED",     "DRAFT → STAGED (admin stages valid definition)"),
            Arguments.of("DRAFT",      "ARCHIVED",   "DRAFT → ARCHIVED (admin discards unwanted draft)"),
            // STAGED can move to ACTIVE, DRAFT (retract), or ARCHIVED
            Arguments.of("STAGED",     "ACTIVE",     "STAGED → ACTIVE (admin activates; registries rebuilt)"),
            Arguments.of("STAGED",     "DRAFT",      "STAGED → DRAFT (admin retracts for revision)"),
            Arguments.of("STAGED",     "ARCHIVED",   "STAGED → ARCHIVED (admin discards staged version)"),
            // ACTIVE can move to SUPERSEDED or ARCHIVED
            Arguments.of("ACTIVE",     "SUPERSEDED", "ACTIVE → SUPERSEDED (displaced by newer activation)"),
            Arguments.of("ACTIVE",     "ARCHIVED",   "ACTIVE → ARCHIVED (admin retires active definition)"),
            // SUPERSEDED can be restored (rollback) or archived
            Arguments.of("SUPERSEDED", "ACTIVE",     "SUPERSEDED → ACTIVE (system restores during rollback)"),
            Arguments.of("SUPERSEDED", "ARCHIVED",   "SUPERSEDED → ARCHIVED (admin archives superseded version)")
        );
    }

    @ParameterizedTest(name = "{2}")
    @MethodSource("allowedTransitions")
    @DisplayName("Allowed transition: validateTransition does not throw")
    void allowedTransition_doesNotThrow(String from, String to, String description) {
        assertThatCode(() -> ProductDefinitionStateMachine.validateTransition(from, to))
                .doesNotThrowAnyException();
    }

    @ParameterizedTest(name = "{2}")
    @MethodSource("allowedTransitions")
    @DisplayName("Allowed transition: transition() returns correct states")
    void allowedTransition_transitionResultIsCorrect(String from, String to, String description) {
        ProductDefinitionStateMachine.TransitionResult result =
                ProductDefinitionStateMachine.transition(from, to);

        assertThat(result.fromState()).isEqualTo(from);
        assertThat(result.toState()).isEqualTo(to);
    }

    // ── Disallowed transitions ────────────────────────────────────────────────

    static Stream<Arguments> disallowedTransitions() {
        return Stream.of(
            // DRAFT cannot skip to ACTIVE or SUPERSEDED
            Arguments.of("DRAFT",      "ACTIVE",     "DRAFT → ACTIVE (must stage first)"),
            Arguments.of("DRAFT",      "SUPERSEDED", "DRAFT → SUPERSEDED (invalid)"),
            Arguments.of("DRAFT",      "DRAFT",      "DRAFT → DRAFT (self-transition not allowed)"),
            // STAGED cannot jump to SUPERSEDED
            Arguments.of("STAGED",     "SUPERSEDED", "STAGED → SUPERSEDED (not an allowed transition)"),
            Arguments.of("STAGED",     "STAGED",     "STAGED → STAGED (self-transition not allowed)"),
            // ACTIVE cannot go back to DRAFT or STAGED
            Arguments.of("ACTIVE",     "DRAFT",      "ACTIVE → DRAFT (cannot un-activate)"),
            Arguments.of("ACTIVE",     "STAGED",     "ACTIVE → STAGED (cannot un-activate)"),
            Arguments.of("ACTIVE",     "ACTIVE",     "ACTIVE → ACTIVE (self-transition not allowed)"),
            // SUPERSEDED cannot return to STAGED or DRAFT
            Arguments.of("SUPERSEDED", "DRAFT",      "SUPERSEDED → DRAFT (cannot revive as draft)"),
            Arguments.of("SUPERSEDED", "STAGED",     "SUPERSEDED → STAGED (cannot restage)"),
            Arguments.of("SUPERSEDED", "SUPERSEDED", "SUPERSEDED → SUPERSEDED (self-transition not allowed)"),
            // ARCHIVED is terminal — no transitions out
            Arguments.of("ARCHIVED",   "DRAFT",      "ARCHIVED → DRAFT (terminal state)"),
            Arguments.of("ARCHIVED",   "STAGED",     "ARCHIVED → STAGED (terminal state)"),
            Arguments.of("ARCHIVED",   "ACTIVE",     "ARCHIVED → ACTIVE (terminal state)"),
            Arguments.of("ARCHIVED",   "SUPERSEDED", "ARCHIVED → SUPERSEDED (terminal state)"),
            Arguments.of("ARCHIVED",   "ARCHIVED",   "ARCHIVED → ARCHIVED (terminal, self-transition)")
        );
    }

    @ParameterizedTest(name = "{2}")
    @MethodSource("disallowedTransitions")
    @DisplayName("Disallowed transition: validateTransition throws with INVALID_LIFECYCLE_TRANSITION")
    void disallowedTransition_throwsWithCorrectCode(String from, String to, String description) {
        assertThatThrownBy(() -> ProductDefinitionStateMachine.validateTransition(from, to))
                .isInstanceOf(ProductDefinitionLifecycleException.class)
                .satisfies(ex -> {
                    ProductDefinitionLifecycleException lce = (ProductDefinitionLifecycleException) ex;
                    assertThat(lce.getErrorCode())
                            .isEqualTo(ProductDefinitionStateMachine.ERR_INVALID_TRANSITION);
                    assertThat(lce.getMessage()).contains(from).contains(to);
                });
    }

    // ── Unknown state ─────────────────────────────────────────────────────────

    @Test
    void unknownFromState_throwsWithUnknownStateCode() {
        assertThatThrownBy(() -> ProductDefinitionStateMachine.validateTransition("BOGUS", "ACTIVE"))
                .isInstanceOf(ProductDefinitionLifecycleException.class)
                .satisfies(ex -> {
                    ProductDefinitionLifecycleException lce = (ProductDefinitionLifecycleException) ex;
                    assertThat(lce.getErrorCode()).isEqualTo(ProductDefinitionStateMachine.ERR_UNKNOWN_STATE);
                    assertThat(lce.getMessage()).contains("BOGUS");
                });
    }

    // ── Terminal state helper ─────────────────────────────────────────────────

    @Test
    void archived_isTerminalState() {
        assertThat(ProductDefinitionStateMachine.isTerminal("ARCHIVED")).isTrue();
        assertThat(ProductDefinitionStateMachine.isTerminal("ACTIVE")).isFalse();
        assertThat(ProductDefinitionStateMachine.isTerminal("DRAFT")).isFalse();
    }

    @Test
    void allowedTransitionsFrom_archived_isEmpty() {
        assertThat(ProductDefinitionStateMachine.allowedTransitionsFrom("ARCHIVED")).isEmpty();
    }

    @Test
    void allowedTransitionsFrom_draft_containsStagedAndArchived() {
        assertThat(ProductDefinitionStateMachine.allowedTransitionsFrom("DRAFT"))
                .containsExactlyInAnyOrder("STAGED", "ARCHIVED");
    }

    @Test
    void allowedTransitionsFrom_unknownState_returnsEmpty() {
        assertThat(ProductDefinitionStateMachine.allowedTransitionsFrom("UNKNOWN")).isEmpty();
    }

    // ── isKnownState ──────────────────────────────────────────────────────────

    @Test
    void isKnownState_recognisesAllCanonicalStates() {
        for (String state : ProductDefinitionStateMachine.ALL_STATES) {
            assertThat(ProductDefinitionStateMachine.isKnownState(state))
                    .as("Expected %s to be a known state", state)
                    .isTrue();
        }
    }

    @Test
    void isKnownState_rejectsBogusState() {
        assertThat(ProductDefinitionStateMachine.isKnownState("PUBLISHED")).isFalse();
        assertThat(ProductDefinitionStateMachine.isKnownState("")).isFalse();
        assertThat(ProductDefinitionStateMachine.isKnownState(null)).isFalse();
    }

    // ── Error message quality ─────────────────────────────────────────────────

    @Test
    void errorMessage_includesValidNextStates() {
        assertThatThrownBy(() -> ProductDefinitionStateMachine.validateTransition("DRAFT", "ACTIVE"))
                .isInstanceOf(ProductDefinitionLifecycleException.class)
                .hasMessageContaining("STAGED") // valid next state is included in the message
                .hasMessageContaining("ARCHIVED");
    }

    @Test
    void errorMessage_archivedShowsTerminalMessage() {
        assertThatThrownBy(() -> ProductDefinitionStateMachine.validateTransition("ARCHIVED", "ACTIVE"))
                .isInstanceOf(ProductDefinitionLifecycleException.class)
                .hasMessageContaining("terminal");
    }
}

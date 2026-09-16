package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.DiscoveryModePolicy;
import com.ubrnms.inventory.repository.DiscoveryModePolicyRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for DiscoveryModePolicyService (WO-001).
 * Covers: RBAC, validation, disabled-mode rejection, audit payload.
 */
@ExtendWith(MockitoExtension.class)
class DiscoveryModePolicyServiceTest {

    @Mock private DiscoveryModePolicyRepository policyRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;

    @InjectMocks
    private DiscoveryModePolicyService svc;

    @BeforeEach
    void injectMapper() throws Exception {
        var field = DiscoveryModePolicyService.class.getDeclaredField("objectMapper");
        field.setAccessible(true);
        field.set(svc, new ObjectMapper().findAndRegisterModules());

        var auditField = DiscoveryModePolicyService.class.getDeclaredField("auditTopic");
        auditField.setAccessible(true);
        auditField.set(svc, "audit-events");
    }

    // ── Admin can update mode ─────────────────────────────────────────────────

    @Test
    void adminUpdate_savesAllRequiredFields() {
        when(policyRepo.findByMode("UBR_CALL_HOME")).thenReturn(Optional.empty());
        when(policyRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DiscoveryModePolicy result = svc.updateMode(
            "UBR_CALL_HOME",
            Map.of("enabled", true, "rolloutLevel", "production", "reason", "initial enablement"),
            "admin", "admin-001"
        );

        assertThat(result.isEnabled()).isTrue();
        assertThat(result.getRolloutLevel()).isEqualTo("production");
        assertThat(result.getUpdatedBy()).isEqualTo("admin-001");
        assertThat(result.getReason()).isEqualTo("initial enablement");
        assertThat(result.getUpdatedAt()).isNotNull();
    }

    // ── Non-admin is rejected with 403 ───────────────────────────────────────

    @Test
    void nonAdminUpdate_throws403AndPublishDeniedAudit() {
        assertThatThrownBy(() -> svc.updateMode(
            "UBR_CALL_HOME",
            Map.of("enabled", true, "reason", "attempt"),
            "network_engineer", "user-002"
        )).isInstanceOf(DiscoveryModePolicyService.AccessDeniedException.class);

        // Denied audit event must be published
        verify(kafkaTemplate).send(eq("audit-events"), eq("UBR_CALL_HOME"), contains("discovery.mode.change.denied"));
    }

    // ── Disabled mode: isModeEnabled returns false ────────────────────────────

    @Test
    void disabledMode_isModeEnabled_returnsFalse() {
        DiscoveryModePolicy disabled = new DiscoveryModePolicy();
        disabled.setEnabled(false);
        disabled.setRolloutLevel("disabled");
        when(policyRepo.findByMode("UBR_CALL_HOME")).thenReturn(Optional.of(disabled));

        assertThat(svc.isModeEnabled("UBR_CALL_HOME")).isFalse();
    }

    @Test
    void noPolicy_isModeEnabled_returnsFalse() {
        when(policyRepo.findByMode("GENERIC_DISCOVERY")).thenReturn(Optional.empty());

        assertThat(svc.isModeEnabled("GENERIC_DISCOVERY")).isFalse();
    }

    @Test
    void enabledProductionMode_isModeEnabled_returnsTrue() {
        DiscoveryModePolicy enabled = new DiscoveryModePolicy();
        enabled.setEnabled(true);
        enabled.setRolloutLevel("production");
        when(policyRepo.findByMode("UBR_CALL_HOME")).thenReturn(Optional.of(enabled));

        assertThat(svc.isModeEnabled("UBR_CALL_HOME")).isTrue();
    }

    @Test
    void betaEnabled_isModeEnabled_returnsTrue() {
        DiscoveryModePolicy beta = new DiscoveryModePolicy();
        beta.setEnabled(true);
        beta.setRolloutLevel("beta");
        when(policyRepo.findByMode("UBR_CALL_HOME")).thenReturn(Optional.of(beta));

        // beta != production but should still be treated as enabled
        assertThat(svc.isModeEnabled("UBR_CALL_HOME")).isTrue();
    }

    // ── Validation: malformed rolloutLevel ────────────────────────────────────

    @Test
    void malformedRolloutLevel_throws400() {
        assertThatThrownBy(() -> svc.updateMode(
            "UBR_CALL_HOME",
            Map.of("enabled", true, "rolloutLevel", "INVALID_LEVEL", "reason", "test"),
            "admin", "admin-001"
        )).isInstanceOf(DiscoveryModePolicyService.ValidationException.class)
          .hasMessageContaining("Invalid rolloutLevel");
    }

    // ── Validation: reason required ───────────────────────────────────────────

    @Test
    void missingReason_throws400() {
        assertThatThrownBy(() -> svc.updateMode(
            "UBR_CALL_HOME",
            Map.of("enabled", true),
            "admin", "admin-001"
        )).isInstanceOf(DiscoveryModePolicyService.ValidationException.class)
          .hasMessageContaining("reason is required");
    }

    // ── getAllModes returns both modes ────────────────────────────────────────

    @Test
    void getAllModes_returnsBothModeKeys() {
        when(policyRepo.findByMode(anyString())).thenReturn(Optional.empty());

        var result = svc.getAllModes();

        assertThat(result).containsKey("ubrCallHome");
        assertThat(result).containsKey("genericDiscovery");
    }

    // ── Change audit event is published ──────────────────────────────────────

    @Test
    void adminUpdate_publishesChangeAuditEvent() {
        when(policyRepo.findByMode("UBR_CALL_HOME")).thenReturn(Optional.empty());
        when(policyRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        svc.updateMode(
            "UBR_CALL_HOME",
            Map.of("enabled", true, "rolloutLevel", "production", "reason", "audit test"),
            "admin", "admin-001"
        );

        verify(kafkaTemplate).send(eq("audit-events"), eq("UBR_CALL_HOME"),
                contains("discovery.mode.changed"));
    }

    // ── Invalid mode ──────────────────────────────────────────────────────────

    @Test
    void unknownMode_throwsModeNotFoundException() {
        assertThatThrownBy(() -> svc.getMode("UNKNOWN_MODE"))
                .isInstanceOf(DiscoveryModePolicyService.ModeNotFoundException.class);
    }
}

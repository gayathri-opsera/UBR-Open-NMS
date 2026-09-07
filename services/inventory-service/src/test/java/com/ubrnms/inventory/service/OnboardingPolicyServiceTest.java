package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
import com.ubrnms.inventory.repository.OnboardingAssignmentPolicyRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OnboardingPolicyServiceTest {

    @Mock
    private OnboardingAssignmentPolicyRepository policyRepo;

    @Mock
    private KafkaTemplate<String, String> kafkaTemplate;

    private OnboardingPolicyService service;

    @BeforeEach
    void setup() {
        service = new OnboardingPolicyService(policyRepo, kafkaTemplate, new ObjectMapper());
        // @Value field defaulted via reflection
        try {
            var field = OnboardingPolicyService.class.getDeclaredField("auditTopic");
            field.setAccessible(true);
            field.set(service, "audit-events");
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ── isGateEnabled ─────────────────────────────────────────────────────────

    @Test
    void isGateEnabled_returnsFalse_whenNoPolicyRecord() {
        when(policyRepo.findByPolicyKey("ONBOARDING_ASSIGNMENT_GATE")).thenReturn(Optional.empty());
        assertThat(service.isGateEnabled()).isFalse();
    }

    @Test
    void isGateEnabled_returnsFalse_whenPolicyIsDisabled() {
        OnboardingAssignmentPolicy p = new OnboardingAssignmentPolicy();
        p.setEnabled(false);
        when(policyRepo.findByPolicyKey("ONBOARDING_ASSIGNMENT_GATE")).thenReturn(Optional.of(p));
        assertThat(service.isGateEnabled()).isFalse();
    }

    @Test
    void isGateEnabled_returnsTrue_whenPolicyIsEnabled() {
        OnboardingAssignmentPolicy p = new OnboardingAssignmentPolicy();
        p.setEnabled(true);
        when(policyRepo.findByPolicyKey("ONBOARDING_ASSIGNMENT_GATE")).thenReturn(Optional.of(p));
        assertThat(service.isGateEnabled()).isTrue();
    }

    @Test
    void isGateEnabled_returnsFalse_onStorageException() {
        when(policyRepo.findByPolicyKey(any())).thenThrow(new RuntimeException("mongo unavailable"));
        // Fail-closed: gate disabled on storage error (auto-onboard)
        assertThat(service.isGateEnabled()).isFalse();
    }

    // ── getPolicyResponse ─────────────────────────────────────────────────────

    @Test
    void getPolicyResponse_includesAllRequiredFields() {
        when(policyRepo.findByPolicyKey(any())).thenReturn(Optional.empty());
        Map<String, Object> resp = service.getPolicyResponse();
        assertThat(resp).containsKeys("enabled", "defaultBehavior", "description", "updatedBy", "updatedAt");
    }

    @Test
    void getPolicyResponse_defaultBehaviorIsAutoManaged_whenGateDisabled() {
        when(policyRepo.findByPolicyKey(any())).thenReturn(Optional.empty());
        Map<String, Object> resp = service.getPolicyResponse();
        assertThat(resp.get("enabled")).isEqualTo(false);
        assertThat(resp.get("defaultBehavior")).isEqualTo("AUTO_MANAGED");
    }

    @Test
    void getPolicyResponse_defaultBehaviorIsPendingAssignment_whenGateEnabled() {
        OnboardingAssignmentPolicy p = new OnboardingAssignmentPolicy();
        p.setEnabled(true);
        p.setUpdatedAt(Instant.now());
        when(policyRepo.findByPolicyKey(any())).thenReturn(Optional.of(p));
        Map<String, Object> resp = service.getPolicyResponse();
        assertThat(resp.get("enabled")).isEqualTo(true);
        assertThat(resp.get("defaultBehavior")).isEqualTo("PENDING_ASSIGNMENT");
    }

    // ── updatePolicy ──────────────────────────────────────────────────────────

    @Test
    void updatePolicy_throwsAccessDenied_forNonAdminRole() {
        assertThatThrownBy(() ->
            service.updatePolicy(Map.of("enabled", true), "engineer", "user1"))
            .isInstanceOf(OnboardingPolicyService.AccessDeniedException.class);
    }

    @Test
    void updatePolicy_throwsAccessDenied_forNullRole() {
        assertThatThrownBy(() ->
            service.updatePolicy(Map.of("enabled", true), null, "user1"))
            .isInstanceOf(OnboardingPolicyService.AccessDeniedException.class);
    }

    @Test
    void updatePolicy_throwsValidation_whenEnabledFieldMissing() {
        assertThatThrownBy(() ->
            service.updatePolicy(Map.of(), "admin", "admin1"))
            .isInstanceOf(OnboardingPolicyService.ValidationException.class);
    }

    @Test
    void updatePolicy_savesPolicy_andPublishesAuditEvent() {
        when(policyRepo.findByPolicyKey("ONBOARDING_ASSIGNMENT_GATE")).thenReturn(Optional.empty());
        OnboardingAssignmentPolicy saved = new OnboardingAssignmentPolicy();
        saved.setEnabled(true);
        saved.setUpdatedAt(Instant.now());
        when(policyRepo.save(any())).thenReturn(saved);

        Map<String, Object> result = service.updatePolicy(
                Map.of("enabled", true, "reason", "NOC-1234 enabling gate"), "admin", "admin1");

        assertThat(result.get("enabled")).isEqualTo(true);
        verify(policyRepo).save(any());
        verify(kafkaTemplate, atLeastOnce()).send(eq("audit-events"), any(), any());
    }

    @Test
    void updatePolicy_publishesDeniedAuditEvent_forNonAdmin() {
        // Denied event published before exception
        try {
            service.updatePolicy(Map.of("enabled", false), "operator", "user2");
        } catch (OnboardingPolicyService.AccessDeniedException ignored) {}
        verify(kafkaTemplate, atLeastOnce()).send(eq("audit-events"), any(), any());
    }

    @Test
    void updatePolicy_updatesExistingRecord_ratherThanCreatingNew() {
        OnboardingAssignmentPolicy existing = new OnboardingAssignmentPolicy();
        existing.setId("existing-id");
        existing.setEnabled(false);
        when(policyRepo.findByPolicyKey("ONBOARDING_ASSIGNMENT_GATE")).thenReturn(Optional.of(existing));

        OnboardingAssignmentPolicy updated = new OnboardingAssignmentPolicy();
        updated.setEnabled(true);
        updated.setUpdatedAt(Instant.now());
        when(policyRepo.save(any())).thenReturn(updated);

        service.updatePolicy(Map.of("enabled", true), "admin", "admin1");

        ArgumentCaptor<OnboardingAssignmentPolicy> captor =
                ArgumentCaptor.forClass(OnboardingAssignmentPolicy.class);
        verify(policyRepo).save(captor.capture());
        assertThat(captor.getValue().isEnabled()).isTrue();
    }
}

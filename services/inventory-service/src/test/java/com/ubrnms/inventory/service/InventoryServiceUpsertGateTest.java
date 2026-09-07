package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.OnboardingAssignmentPolicy;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import com.ubrnms.inventory.repository.hierarchy.PreAssignmentRepository;
import com.ubrnms.inventory.model.hierarchy.DevicePreAssignment;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link InventoryService#upsertFromDiscovery(Map)} with WO-033 gate logic.
 */
@ExtendWith(MockitoExtension.class)
class InventoryServiceUpsertGateTest {

    @Mock DeviceRepository deviceRepo;
    @Mock BirthCertificateRepository bcRepo;
    @Mock KafkaTemplate<String, String> kafkaTemplate;
    @Mock PreAssignmentRepository preAssignRepo;
    @Mock OnboardingPolicyService onboardingPolicyService;

    private InventoryService service;

    @BeforeEach
    void setup() throws Exception {
        service = new InventoryService(deviceRepo, bcRepo, kafkaTemplate, new ObjectMapper());

        // inject optional dependencies via reflection
        setField(service, "preAssignRepo", preAssignRepo);
        setField(service, "onboardingPolicyService", onboardingPolicyService);
        setField(service, "discoveryModePolicyRepo", null);
        setField(service, "capabilityProfileRepo", null);
        setField(service, "inventorySyncTopic", "inventory-sync");
        setField(service, "auditTopic", "audit-events");
        setField(service, "defaultRadiusKm", 1.0);

        when(deviceRepo.findBySerialNumber(any())).thenReturn(Optional.empty());
        when(deviceRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    // ── Gate disabled ─────────────────────────────────────────────────────────

    @Test
    void upsertFromDiscovery_setsManaged_whenGateIsDisabled() {
        when(onboardingPolicyService.isGateEnabled()).thenReturn(false);
        when(preAssignRepo.findBySerialNumber("SN001")).thenReturn(Optional.empty());

        Device result = service.upsertFromDiscovery(Map.of(
            "serialNumber", "SN001", "discoveryParadigm", "UBR_CALL_HOME"
        ));

        assertThat(result.getOnboardingGateState()).isEqualTo("MANAGED");
        assertThat(result.getAssignmentRequired()).isNotEqualTo(Boolean.TRUE);
    }

    // ── Gate enabled + has pre-assignment ────────────────────────────────────

    @Test
    void upsertFromDiscovery_setsManaged_whenGateEnabledAndHasPreAssignment() {
        when(onboardingPolicyService.isGateEnabled()).thenReturn(true);
        DevicePreAssignment pa = new DevicePreAssignment();
        pa.setSerialNumber("SN002");
        when(preAssignRepo.findBySerialNumber("SN002")).thenReturn(Optional.of(pa));

        Device result = service.upsertFromDiscovery(Map.of(
            "serialNumber", "SN002", "discoveryParadigm", "UBR_CALL_HOME"
        ));

        assertThat(result.getOnboardingGateState()).isEqualTo("MANAGED");
        verify(preAssignRepo).save(pa);  // marked as onboarded
    }

    // ── Gate enabled + no pre-assignment ─────────────────────────────────────

    @Test
    void upsertFromDiscovery_setsPendingAssignment_whenGateEnabledAndNoPreAssignment() {
        when(onboardingPolicyService.isGateEnabled()).thenReturn(true);
        when(preAssignRepo.findBySerialNumber("SN003")).thenReturn(Optional.empty());

        Device result = service.upsertFromDiscovery(Map.of(
            "serialNumber", "SN003", "discoveryParadigm", "UBR_CALL_HOME"
        ));

        assertThat(result.getOnboardingGateState())
            .isEqualTo(OnboardingAssignmentPolicy.GateState.PENDING_ASSIGNMENT.name());
        assertThat(result.getAssignmentRequired()).isEqualTo(Boolean.TRUE);
    }

    @Test
    void upsertFromDiscovery_persistsDevice_whenPendingAssignment_notThrow() {
        when(onboardingPolicyService.isGateEnabled()).thenReturn(true);
        when(preAssignRepo.findBySerialNumber("SN004")).thenReturn(Optional.empty());

        // Must NOT throw NotPreAssignedException — device should be persisted in PENDING_ASSIGNMENT
        assertThatCode(() ->
            service.upsertFromDiscovery(Map.of(
                "serialNumber", "SN004", "discoveryParadigm", "UBR_CALL_HOME"
            ))
        ).doesNotThrowAnyException();

        verify(deviceRepo).save(argThat(d ->
            OnboardingAssignmentPolicy.GateState.PENDING_ASSIGNMENT.name()
                .equals(d.getOnboardingGateState())));
    }

    @Test
    void upsertFromDiscovery_publishesAuditEvent_whenPendingAssignment() {
        when(onboardingPolicyService.isGateEnabled()).thenReturn(true);
        when(preAssignRepo.findBySerialNumber("SN005")).thenReturn(Optional.empty());

        service.upsertFromDiscovery(Map.of(
            "serialNumber", "SN005",
            "discoveryParadigm", "UBR_CALL_HOME",
            "correlationId", "test-corr-id"
        ));

        // Should have published at least 2 Kafka messages: pending-assignment + onboarding-audit
        verify(kafkaTemplate, atLeast(2)).send(any(), any(), any());
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static void setField(Object target, String fieldName, Object value) throws Exception {
        // Search up the class hierarchy
        Class<?> cls = target.getClass();
        while (cls != null) {
            try {
                var field = cls.getDeclaredField(fieldName);
                field.setAccessible(true);
                field.set(target, value);
                return;
            } catch (NoSuchFieldException e) {
                cls = cls.getSuperclass();
            }
        }
        throw new NoSuchFieldException(fieldName + " not found in " + target.getClass());
    }
}

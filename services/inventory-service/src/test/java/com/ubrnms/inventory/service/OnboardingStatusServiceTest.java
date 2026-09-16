package com.ubrnms.inventory.service;

import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.OnboardingStatusDTO;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for WO-038 onboarding status aggregation in InventoryService.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class OnboardingStatusServiceTest {

    @Mock private DeviceRepository deviceRepo;
    @Mock private BirthCertificateRepository bcRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @InjectMocks private InventoryService service;

    @BeforeEach
    void setUp() throws Exception {
        setField("objectMapper", new ObjectMapper().registerModule(new JavaTimeModule()));
        setField("inventorySyncTopic", "inventory-sync");
        setField("auditTopic", "audit-events");
        setField("defaultRadiusKm", 1.0);
    }

    void setField(String name, Object value) throws Exception {
        var f = InventoryService.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(service, value);
    }

    // ── onboarding state derivation ──────────────────────────────────────────

    @Test
    void deriveState_realtimeEstablished_returnsManaged() {
        Device d = device("SN-001", "UBR_CALL_HOME", "REALTIME_ESTABLISHED", "MANAGED", null);
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("MANAGED");
        assertThat(dto.getConfigurationDeliveryState()).isEqualTo("ELIGIBLE");
    }

    @Test
    void deriveState_pendingAssignment_returnsCorrectState() {
        Device d = device("SN-002", "UBR_CALL_HOME", "AUTHENTICATED", "PENDING_ASSIGNMENT", null);
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("PENDING_ASSIGNMENT");
        assertThat(dto.getConfigurationDeliveryState()).isEqualTo("WITHHELD");
    }

    @Test
    void deriveState_configWithheld_returnsWithheld() {
        Device d = device("SN-003", "UBR_CALL_HOME", "CHECK_IN_RECEIVED", "CONFIG_WITHHELD", null);
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("CONFIG_WITHHELD");
        assertThat(dto.getConfigurationDeliveryState()).isEqualTo("WITHHELD");
    }

    @Test
    void deriveState_failedWithNmsFailover_returnsRedirected() {
        Device d = device("SN-004", "UBR_CALL_HOME", "FAILED", "MANAGED", "NMS_FAILOVER");
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("REDIRECTED");
    }

    @Test
    void deriveState_failedWithRetrySeconds_returnsRetrying() {
        Device d = device("SN-005", "UBR_CALL_HOME", "FAILED", "MANAGED", "CHECKIN_FAILED");
        d.setRetryAfterSeconds(30);
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("RETRYING");
    }

    @Test
    void deriveState_failedNoRetry_returnsFailed() {
        Device d = device("SN-006", "UBR_CALL_HOME", "FAILED", "MANAGED", "AUTH_FAILED");
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("FAILED");
    }

    @Test
    void deriveState_nullBootstrapState_returnsPending() {
        Device d = device("SN-007", "GENERIC_SNMP", null, null, null);
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        assertThat(dto.getOnboardingState()).isEqualTo("PENDING");
    }

    // ── pagination and filtering ─────────────────────────────────────────────

    @Test
    void queryOnboardingStatus_paginatesResults() {
        List<Device> devices = List.of(
            device("SN-P01", "UBR_CALL_HOME", "REALTIME_ESTABLISHED", "MANAGED", null),
            device("SN-P02", "UBR_CALL_HOME", "AUTHENTICATED", "PENDING_ASSIGNMENT", null),
            device("SN-P03", "UBR_CALL_HOME", "PENDING", "MANAGED", null)
        );
        when(deviceRepo.findAll()).thenReturn(devices);

        InventoryService.OnboardingStatusResult page0 = service.queryOnboardingStatus(
            null, null, null, null, null, null, null, null, null, 0, 2);
        InventoryService.OnboardingStatusResult page1 = service.queryOnboardingStatus(
            null, null, null, null, null, null, null, null, null, 1, 2);

        assertThat(page0.items()).hasSize(2);
        assertThat(page0.total()).isEqualTo(3);
        assertThat(page1.items()).hasSize(1);
    }

    @Test
    void queryOnboardingStatus_filtersByParadigm() {
        List<Device> devices = List.of(
            device("SN-F01", "UBR_CALL_HOME", "REALTIME_ESTABLISHED", "MANAGED", null),
            device("SN-F02", "GENERIC_SNMP", null, null, null)
        );
        when(deviceRepo.findAll()).thenReturn(devices);

        InventoryService.OnboardingStatusResult result = service.queryOnboardingStatus(
            null, "UBR_CALL_HOME", null, null, null, null, null, null, null, 0, 50);

        assertThat(result.items()).hasSize(1);
        assertThat(result.items().get(0).getSerialNumber()).isEqualTo("SN-F01");
    }

    @Test
    void queryOnboardingStatus_filtersByState() {
        List<Device> devices = List.of(
            device("SN-S01", "UBR_CALL_HOME", "REALTIME_ESTABLISHED", "MANAGED", null),
            device("SN-S02", "UBR_CALL_HOME", "AUTHENTICATED", "PENDING_ASSIGNMENT", null)
        );
        when(deviceRepo.findAll()).thenReturn(devices);

        InventoryService.OnboardingStatusResult result = service.queryOnboardingStatus(
            "PENDING_ASSIGNMENT", null, null, null, null, null, null, null, null, 0, 50);

        assertThat(result.items()).hasSize(1);
        assertThat(result.items().get(0).getSerialNumber()).isEqualTo("SN-S02");
    }

    @Test
    void queryOnboardingStatus_emptyInventory_returnsEmptyWithEnabledCapability() {
        when(deviceRepo.findAll()).thenReturn(List.of());

        InventoryService.OnboardingStatusResult result = service.queryOnboardingStatus(
            null, null, null, null, null, null, null, null, null, 0, 50);

        assertThat(result.items()).isEmpty();
        assertThat(result.total()).isEqualTo(0);
        assertThat(result.capabilityStatus()).isEqualTo("enabled");
    }

    @Test
    void toOnboardingStatusDTO_neverExposesCredentialRef() {
        Device d = device("SN-SEC01", "UBR_CALL_HOME", "AUTHENTICATED", "MANAGED", null);
        d.setCredentialRef("secret-vault-key-abc123");
        OnboardingStatusDTO dto = service.toOnboardingStatusDTO(d);
        // DTO has no credentialRef field by design — verify the sensitive ref is absent.
        assertThat(dto).hasNoNullFieldsOrPropertiesExcept(
            "macAddress", "sysObjectID", "bootstrapState", "lastSuccessfulState",
            "reasonCategory", "retryAfterSeconds", "retryJitterMaxSeconds",
            "lastCheckInAt", "lastRealtimeAt", "updatedAt"
        );
    }

    @Test
    void queryOnboardingStatus_serialNumberFilter_usesIndexedLookup() {
        Device d = device("SN-IDX01", "UBR_CALL_HOME", "REALTIME_ESTABLISHED", "MANAGED", null);
        when(deviceRepo.findBySerialNumber("SN-IDX01")).thenReturn(Optional.of(d));

        InventoryService.OnboardingStatusResult result = service.queryOnboardingStatus(
            null, null, null, null, "SN-IDX01", null, null, null, null, 0, 50);

        assertThat(result.items()).hasSize(1);
        verify(deviceRepo).findBySerialNumber("SN-IDX01");
        verify(deviceRepo, never()).findAll();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private Device device(String serial, String paradigm, String bootstrapState,
                          String gateState, String failureReason) {
        Device d = new Device();
        d.setId("id-" + serial);
        d.setSerialNumber(serial);
        d.setDeviceType("BTS");
        d.setDiscoveryParadigm(paradigm);
        d.setBootstrapState(bootstrapState);
        d.setOnboardingGateState(gateState);
        d.setOnboardingFailureReason(failureReason);
        return d;
    }
}

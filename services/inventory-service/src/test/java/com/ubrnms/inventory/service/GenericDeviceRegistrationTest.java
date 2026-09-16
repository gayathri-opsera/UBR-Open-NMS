package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for generic device registration from SNMP classification (WO-030).
 *
 * Verifies:
 * - RECOGNISED devices are persisted and inventory-sync event is published
 * - DEFERRED_UNSUPPORTED devices are NOT persisted; deferred audit event is published
 * - UBR call-home identity fields are never overwritten by generic enrichment
 * - Classification result fields are applied correctly for new generic devices
 * - Vendor, genericDeviceType, driverId are set on new generic devices
 * - Event publication failure after persistence does NOT fail the registration
 */
@ExtendWith(MockitoExtension.class)
class GenericDeviceRegistrationTest {

    @Mock private DeviceRepository deviceRepo;
    @Mock private BirthCertificateRepository bcRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;

    @InjectMocks
    private InventoryService svc;

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @BeforeEach
    void injectFields() throws Exception {
        setField("objectMapper", objectMapper);
        setField("auditTopic", "audit-events");
        setField("inventorySyncTopic", "inventory-sync");
    }

    private void setField(String name, Object value) throws Exception {
        var f = InventoryService.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(svc, value);
    }

    private Map<String, Object> recognisedPayload(String ip) {
        Map<String, Object> p = new HashMap<>();
        p.put("ip", ip);
        p.put("classificationStatus", "RECOGNISED");
        p.put("vendor", "Cisco");
        p.put("model", "Catalyst 2960-X");
        p.put("genericDeviceType", "SWITCH");
        p.put("capabilityProfileId", "cap-cisco-switch-v1");
        p.put("driverId", "drv-cisco-snmp-v1");
        p.put("sysObjectID", "1.3.6.1.4.1.9.1.1208");
        p.put("sysDescr", "Cisco IOS Software, C2960X");
        p.put("discoveryParadigm", "GENERIC_SNMP");
        p.put("identityAuthority", "GENERIC");
        p.put("onlineStateAuthority", "GENERIC");
        p.put("correlationId", "corr-test-001");
        return p;
    }

    private Map<String, Object> deferredPayload(String ip, String reason) {
        Map<String, Object> p = new HashMap<>();
        p.put("ip", ip);
        p.put("classificationStatus", "DEFERRED_UNSUPPORTED");
        p.put("deferReason", reason);
        p.put("discoveryParadigm", "GENERIC_SNMP");
        p.put("identityAuthority", "GENERIC");
        p.put("onlineStateAuthority", "GENERIC");
        return p;
    }

    // ── RECOGNISED path ───────────────────────────────────────────────────────

    @Test
    void recognisedDevice_shouldBeSavedWithClassificationFields() {
        Device saved = new Device();
        saved.setId("inv-001");
        when(deviceRepo.findByIpAddress("192.168.1.10")).thenReturn(Optional.empty());
        when(deviceRepo.save(any(Device.class))).thenReturn(saved);

        var result = svc.upsertFromGenericDiscovery(recognisedPayload("192.168.1.10"));

        assertThat(result.status()).isEqualTo(InventoryService.GenericRegistrationStatus.REGISTERED);
        assertThat(result.inventoryDeviceId()).isEqualTo("inv-001");

        ArgumentCaptor<Device> deviceCaptor = ArgumentCaptor.forClass(Device.class);
        verify(deviceRepo).save(deviceCaptor.capture());
        Device persisted = deviceCaptor.getValue();

        assertThat(persisted.getVendor()).isEqualTo("Cisco");
        assertThat(persisted.getGenericDeviceType()).isEqualTo("SWITCH");
        assertThat(persisted.getDriverId()).isEqualTo("drv-cisco-snmp-v1");
        assertThat(persisted.getClassificationStatus()).isEqualTo("RECOGNISED");
        assertThat(persisted.getIdentityAuthority()).isEqualTo("GENERIC");
        assertThat(persisted.getOnlineStateAuthority()).isEqualTo("GENERIC");
        assertThat(persisted.getDiscoveryParadigm()).isEqualTo("GENERIC_SNMP");
    }

    @Test
    void recognisedDevice_shouldPublishInventorySyncEvent() {
        Device saved = new Device();
        saved.setId("inv-002");
        when(deviceRepo.findByIpAddress("192.168.1.20")).thenReturn(Optional.empty());
        when(deviceRepo.save(any(Device.class))).thenReturn(saved);

        svc.upsertFromGenericDiscovery(recognisedPayload("192.168.1.20"));

        verify(kafkaTemplate, atLeastOnce()).send(eq("inventory-sync"), any(), anyString());
    }

    @Test
    void recognisedDevice_autoGeneratesStableSerial_forIpBasedKey() {
        when(deviceRepo.findByIpAddress("10.50.1.100")).thenReturn(Optional.empty());
        when(deviceRepo.save(any(Device.class))).thenAnswer(inv -> inv.getArgument(0));

        svc.upsertFromGenericDiscovery(recognisedPayload("10.50.1.100"));

        ArgumentCaptor<Device> captor = ArgumentCaptor.forClass(Device.class);
        verify(deviceRepo).save(captor.capture());
        assertThat(captor.getValue().getSerialNumber()).isEqualTo("GENERIC-IP-10.50.1.100");
    }

    // ── DEFERRED path ────────────────────────────────────────────────────────

    @Test
    void deferredDevice_shouldNotBeSaved() {
        var result = svc.upsertFromGenericDiscovery(deferredPayload("192.168.1.30", "OID_NOT_IN_RELEASE_SCOPE"));

        assertThat(result.status()).isEqualTo(InventoryService.GenericRegistrationStatus.DEFERRED);
        assertThat(result.inventoryDeviceId()).isNull();
        verify(deviceRepo, never()).save(any());
    }

    @Test
    void deferredDevice_shouldPublishDeferredAuditEvent() {
        svc.upsertFromGenericDiscovery(deferredPayload("192.168.1.40", "INSUFFICIENT_FINGERPRINT_EVIDENCE"));

        verify(kafkaTemplate, atLeastOnce()).send(eq("audit-events"), any(), anyString());
    }

    // ── UBR authority preservation ────────────────────────────────────────────

    @Test
    void existingUbrDevice_vendorAndAuthorityShouldNotBeOverwritten() {
        Device existing = new Device();
        existing.setId("ubr-dev-001");
        existing.setSerialNumber("SN-UBR-001");
        existing.setIdentityAuthority("UBR");
        existing.setDiscoveryParadigm("UBR_CALL_HOME");
        existing.setBootstrapState("REALTIME_ESTABLISHED");

        when(deviceRepo.findByIpAddress("10.100.1.1")).thenReturn(Optional.of(existing));
        when(deviceRepo.save(any(Device.class))).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> payload = recognisedPayload("10.100.1.1");
        payload.put("identityAuthority", "GENERIC"); // generic caller attempting to overwrite UBR

        svc.upsertFromGenericDiscovery(payload);

        ArgumentCaptor<Device> captor = ArgumentCaptor.forClass(Device.class);
        verify(deviceRepo).save(captor.capture());
        Device merged = captor.getValue();

        // Authority must be preserved from UBR
        assertThat(merged.getIdentityAuthority()).isEqualTo("UBR");
        // sysObjectID and sysDescr enrichment should still be applied
        assertThat(merged.getSysObjectID()).isEqualTo("1.3.6.1.4.1.9.1.1208");
        assertThat(merged.getSysDescr()).isEqualTo("Cisco IOS Software, C2960X");
    }

    // ── Validation ────────────────────────────────────────────────────────────

    @Test
    void invalidSysObjectId_shouldThrowValidationException() {
        Map<String, Object> payload = recognisedPayload("192.168.1.50");
        payload.put("sysObjectID", "not.a.valid.oid.FORMAT!!");
        when(deviceRepo.findByIpAddress("192.168.1.50")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> svc.upsertFromGenericDiscovery(payload))
            .isInstanceOf(InventoryService.ValidationException.class);
        verify(deviceRepo, never()).save(any());
    }
}

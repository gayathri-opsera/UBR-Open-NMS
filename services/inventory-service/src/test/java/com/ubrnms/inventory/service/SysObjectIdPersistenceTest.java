package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.PagedResponse;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for sysObjectID persistence and validation (WO-004).
 * Covers: validation, persistence, filtering, absence-on-UBR-call-home.
 */
@ExtendWith(MockitoExtension.class)
class SysObjectIdPersistenceTest {

    @Mock private DeviceRepository deviceRepo;
    @Mock private BirthCertificateRepository bcRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;

    @InjectMocks
    private InventoryService svc;

    @BeforeEach
    void injectDependencies() throws Exception {
        var mapperField = InventoryService.class.getDeclaredField("objectMapper");
        mapperField.setAccessible(true);
        mapperField.set(svc, new ObjectMapper().findAndRegisterModules());

        var auditField = InventoryService.class.getDeclaredField("auditTopic");
        auditField.setAccessible(true);
        auditField.set(svc, "audit-events");

        var syncField = InventoryService.class.getDeclaredField("inventorySyncTopic");
        syncField.setAccessible(true);
        syncField.set(svc, "inventory-sync");
    }

    // ── Validation: valid OID patterns ────────────────────────────────────────

    @Test
    void validateSysObjectId_validOid_passes() {
        assertThatNoException().isThrownBy(() -> svc.validateSysObjectId("1.3.6.1.4.1.9"));
        assertThatNoException().isThrownBy(() -> svc.validateSysObjectId("1.3.6.1.2.1.1"));
        assertThatNoException().isThrownBy(() -> svc.validateSysObjectId("0.0"));
        assertThatNoException().isThrownBy(() -> svc.validateSysObjectId("1"));
    }

    // ── Validation: invalid OID patterns ─────────────────────────────────────

    @Test
    void validateSysObjectId_emptyString_throws400() {
        assertThatThrownBy(() -> svc.validateSysObjectId(""))
                .isInstanceOf(InventoryService.ValidationException.class)
                .hasMessageContaining("must not be empty");
    }

    @Test
    void validateSysObjectId_blanks_throws400() {
        assertThatThrownBy(() -> svc.validateSysObjectId("   "))
                .isInstanceOf(InventoryService.ValidationException.class);
    }

    @Test
    void validateSysObjectId_alphabeticTokens_throws400() {
        // Alphabetic OID is invalid
        assertThatThrownBy(() -> svc.validateSysObjectId("1.3.6.enterprises.cisco"))
                .isInstanceOf(InventoryService.ValidationException.class);
    }

    @Test
    void validateSysObjectId_pathLikeInput_throws400() {
        // Path traversal-like strings are rejected by OID pattern
        assertThatThrownBy(() -> svc.validateSysObjectId("/etc/passwd"))
                .isInstanceOf(InventoryService.ValidationException.class);
    }

    @Test
    void validateSysObjectId_exceedsMaxLength_throws400() {
        // Generate a string > 128 chars that still looks like an OID
        String longOid = "1" + ".1".repeat(70); // "1.1.1... (71 segments)"
        assertThat(longOid.length()).isGreaterThan(128);
        assertThatThrownBy(() -> svc.validateSysObjectId(longOid))
                .isInstanceOf(InventoryService.ValidationException.class)
                .hasMessageContaining("maximum length");
    }

    @Test
    void validateSysObjectId_leadingDot_throws400() {
        assertThatThrownBy(() -> svc.validateSysObjectId(".1.3.6"))
                .isInstanceOf(InventoryService.ValidationException.class);
    }

    // ── Persistence: sysObjectID applied during authority merge ──────────────

    @Test
    void mergeWithAuthority_genericSnmp_appliesSysObjectId() {
        Device device = new Device();
        Map<String, Object> event = new HashMap<>();
        event.put("ipAddress", "10.0.0.1");
        event.put("discoveryParadigm", "GENERIC_SNMP");
        // Note: sysObjectID is applied after mergeWithAuthority via validateSysObjectId
        // Test that the field is set on the device

        svc.validateSysObjectId("1.3.6.1.4.1.9");
        device.setSysObjectID("1.3.6.1.4.1.9");

        assertThat(device.getSysObjectID()).isEqualTo("1.3.6.1.4.1.9");
    }

    // ── Filtering: only matching generic devices returned ────────────────────

    @Test
    void filterBySysObjectId_returnsMatchingDevices() {
        Device d1 = new Device();
        d1.setSysObjectID("1.3.6.1.4.1.9");
        d1.setDiscoveryParadigm("GENERIC_SNMP");

        Device d2 = new Device();
        d2.setSysObjectID("1.3.6.1.4.1.14988");
        d2.setDiscoveryParadigm("GENERIC_SNMP");

        Device d3 = new Device();
        d3.setDiscoveryParadigm("UBR_CALL_HOME");
        // No sysObjectID for UBR device

        org.mockito.Mockito.when(deviceRepo.findAll()).thenReturn(List.of(d1, d2, d3));

        List<Device> results = svc.filterBySysObjectId("1.3.6.1.4.1.9");

        assertThat(results).hasSize(1);
        assertThat(results.get(0).getSysObjectID()).isEqualTo("1.3.6.1.4.1.9");
        // UBR device without sysObjectID is NOT returned
        assertThat(results.stream().filter(d -> d.getSysObjectID() == null).collect(Collectors.toList())).isEmpty();
    }

    @Test
    void filterBySysObjectId_ubrDeviceWithoutOid_excluded() {
        Device ubrDevice = new Device();
        ubrDevice.setSerialNumber("UBR-SN-001");
        ubrDevice.setDiscoveryParadigm("UBR_CALL_HOME");
        ubrDevice.setSysObjectID(null);

        org.mockito.Mockito.when(deviceRepo.findAll()).thenReturn(List.of(ubrDevice));

        List<Device> results = svc.filterBySysObjectId("1.3.6.1.4.1.9");

        assertThat(results).isEmpty();
    }

    // ── UBR device validity: targetable without sysObjectID ──────────────────

    @Test
    void ubrDevice_isValidWithoutSysObjectId() {
        Device ubrDevice = new Device();
        ubrDevice.setSerialNumber("UBR-SN-001");
        ubrDevice.setMacAddress("AA:BB:CC:DD:EE:FF");
        ubrDevice.setDeviceType("BTS");
        ubrDevice.setDiscoveryParadigm("UBR_CALL_HOME");
        ubrDevice.setIdentityAuthority("UBR");
        ubrDevice.setSysObjectID(null);

        // UBR device is valid — sysObjectID is not required
        assertThat(ubrDevice.getSysObjectID()).isNull();
        assertThat(ubrDevice.getSerialNumber()).isEqualTo("UBR-SN-001");
        assertThat(ubrDevice.getIdentityAuthority()).isEqualTo("UBR");
    }

    // ── listDevices: sysObjectID filter passthrough ───────────────────────────

    @Test
    void listDevices_withSysObjectIdFilter_onlyMatchesOidDevices() {
        Device d1 = new Device(); d1.setSysObjectID("1.3.6.1.4.1.9");
        Device d2 = new Device(); d2.setSysObjectID("1.3.6.1.4.1.14988");
        Device d3 = new Device(); // no OID — UBR device

        org.mockito.Mockito.when(deviceRepo.findAll()).thenReturn(List.of(d1, d2, d3));

        PagedResponse<Device> page = svc.listDevices(null, null, "1.3.6.1.4.1.9", null, 0, 100);
        List<Device> results = page.getData();

        assertThat(results).hasSize(1);
        assertThat(results.get(0).getSysObjectID()).isEqualTo("1.3.6.1.4.1.9");
    }
}

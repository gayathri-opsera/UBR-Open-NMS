package com.ubrnms.inventory.service;

import com.ubrnms.inventory.model.Device;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.repository.DeviceRepository;
import com.ubrnms.inventory.repository.BirthCertificateRepository;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;

/**
 * Unit tests for the authority-aware merge logic introduced in WO-002.
 * Verifies that UBR-protected fields cannot be overwritten by generic discovery,
 * and that enrichment fields are correctly applied by either paradigm.
 */
@ExtendWith(MockitoExtension.class)
class DeviceAuthorityMergeTest {

    @Mock private DeviceRepository deviceRepo;
    @Mock private BirthCertificateRepository bcRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;

    @InjectMocks
    private InventoryService svc;

    private final ObjectMapper objectMapper = new ObjectMapper()
            .findAndRegisterModules();

    @BeforeEach
    void injectMapper() throws Exception {
        // Inject ObjectMapper via reflection since Mockito doesn't handle @Value
        var field = InventoryService.class.getDeclaredField("objectMapper");
        field.setAccessible(true);
        field.set(svc, objectMapper);

        var auditField = InventoryService.class.getDeclaredField("auditTopic");
        auditField.setAccessible(true);
        auditField.set(svc, "audit-events");

        var syncField = InventoryService.class.getDeclaredField("inventorySyncTopic");
        syncField.setAccessible(true);
        syncField.set(svc, "inventory-sync");
    }

    // ── Happy path: UBR sets all authority fields ────────────────────────────

    @Test
    void ubrCallHome_setsAllAuthorityFields() {
        Device device = new Device();
        Map<String, Object> event = ubrEvent("SN-001");

        Device result = svc.mergeWithAuthority(device, event, "UBR_CALL_HOME");

        assertThat(result.getSerialNumber()).isEqualTo("SN-001");
        assertThat(result.getMacAddress()).isEqualTo("AA:BB:CC:DD:EE:FF");
        assertThat(result.getIdentityAuthority()).isEqualTo("UBR");
        assertThat(result.getOnlineStateAuthority()).isEqualTo("UBR");
        assertThat(result.getBootstrapState()).isEqualTo("CHECK_IN_RECEIVED");
        assertThat(result.getDiscoveryParadigm()).isEqualTo("UBR_CALL_HOME");
        assertThat(result.getSchemaVersion()).isEqualTo("1.0");
    }

    // ── UBR defaults ─────────────────────────────────────────────────────────

    @Test
    void newDevice_getsDefaultSchemaVersion() {
        Device device = new Device();
        Map<String, Object> event = Map.of("serialNumber", "SN-NEW");

        Device result = svc.mergeWithAuthority(device, event, "GENERIC_SNMP");

        assertThat(result.getSchemaVersion()).isEqualTo("1.0");
    }

    // ── Generic cannot overwrite UBR-protected fields ────────────────────────

    @Test
    void genericUpdate_cannotOverwriteUbrProtectedFields() {
        // Existing device already claimed by UBR
        Device existing = new Device();
        existing.setSerialNumber("SN-001");
        existing.setMacAddress("AA:BB:CC:DD:EE:FF");
        existing.setDeviceType("BTS");
        existing.setIdentityAuthority("UBR");
        existing.setOnlineStateAuthority("UBR");
        existing.setBootstrapState("REALTIME_ESTABLISHED");

        Map<String, Object> genericUpdate = new HashMap<>();
        genericUpdate.put("serialNumber", "SPOOFED-SERIAL");
        genericUpdate.put("macAddress", "00:11:22:33:44:55");
        genericUpdate.put("deviceType", "CPE");
        genericUpdate.put("identityAuthority", "GENERIC");
        genericUpdate.put("bootstrapState", "FAILED");
        // Enrichment fields — these should apply
        genericUpdate.put("model", "Generic-Model-X");
        genericUpdate.put("ipAddress", "10.0.0.50");
        genericUpdate.put("firmwareVersion", "2.0.0");

        Device result = svc.mergeWithAuthority(existing, genericUpdate, "GENERIC_SNMP");

        // Protected fields must remain unchanged
        assertThat(result.getSerialNumber()).isEqualTo("SN-001");
        assertThat(result.getMacAddress()).isEqualTo("AA:BB:CC:DD:EE:FF");
        assertThat(result.getDeviceType()).isEqualTo("BTS");
        assertThat(result.getIdentityAuthority()).isEqualTo("UBR");
        assertThat(result.getBootstrapState()).isEqualTo("REALTIME_ESTABLISHED");

        // Enrichment fields must be applied
        assertThat(result.getModel()).isEqualTo("Generic-Model-X");
        assertThat(result.getIpAddress()).isEqualTo("10.0.0.50");
        assertThat(result.getFirmwareVersion()).isEqualTo("2.0.0");
    }

    // ── Generic device without UBR authority ─────────────────────────────────

    @Test
    void genericDevice_setsEnrichmentFieldsWhenNoUbrAuthority() {
        Device device = new Device();
        Map<String, Object> event = genericEvent("10.0.0.1");

        Device result = svc.mergeWithAuthority(device, event, "GENERIC_SNMP");

        assertThat(result.getIpAddress()).isEqualTo("10.0.0.1");
        assertThat(result.getModel()).isEqualTo("Cisco-2960X");
        assertThat(result.getFirmwareVersion()).isEqualTo("15.2");
        assertThat(result.getDiscoveryParadigm()).isEqualTo("GENERIC_SNMP");
    }

    // ── Credential ref: set by UBR, not exposed in logs ──────────────────────

    @Test
    void ubrCallHome_setsCredentialRefOpaquely() {
        Device device = new Device();
        Map<String, Object> event = new HashMap<>(ubrEvent("SN-CRED"));
        event.put("credentialRef", "vault://ubr-devices/SN-CRED");

        Device result = svc.mergeWithAuthority(device, event, "UBR_CALL_HOME");

        // credentialRef stored, not null
        assertThat(result.getCredentialRef()).isEqualTo("vault://ubr-devices/SN-CRED");
    }

    @Test
    void genericCannotSetCredentialRef_whenUbrIsAuthority() {
        Device existing = new Device();
        existing.setIdentityAuthority("UBR");
        existing.setCredentialRef("vault://ubr-devices/SN-001");

        Map<String, Object> genericAttempt = Map.of(
            "credentialRef", "malicious-ref"
        );

        Device result = svc.mergeWithAuthority(existing, genericAttempt, "GENERIC_SNMP");

        assertThat(result.getCredentialRef()).isEqualTo("vault://ubr-devices/SN-001");
    }

    // ── Serialization: new fields appear in output ────────────────────────────

    @Test
    void ubrDevice_serialisesNewFieldsCorrectly() throws Exception {
        Device device = new Device();
        svc.mergeWithAuthority(device, ubrEvent("SN-SER"), "UBR_CALL_HOME");

        String json = objectMapper.writeValueAsString(device);

        assertThat(json).contains("discoveryParadigm");
        assertThat(json).contains("identityAuthority");
        assertThat(json).contains("bootstrapState");
        assertThat(json).contains("schemaVersion");
    }

    // ── Default values ────────────────────────────────────────────────────────

    @Test
    void mergeWith_nullValues_areIgnored() {
        Device device = new Device();
        device.setSerialNumber("SN-EXISTING");

        Map<String, Object> update = new HashMap<>();
        update.put("serialNumber", null);
        update.put("model", "NewModel");

        Device result = svc.mergeWithAuthority(device, update, "GENERIC_SNMP");

        assertThat(result.getSerialNumber()).isEqualTo("SN-EXISTING");
        assertThat(result.getModel()).isEqualTo("NewModel");
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private Map<String, Object> ubrEvent(String serial) {
        Map<String, Object> m = new HashMap<>();
        m.put("serialNumber", serial);
        m.put("macAddress", "AA:BB:CC:DD:EE:FF");
        m.put("deviceType", "BTS");
        m.put("identityAuthority", "UBR");
        m.put("onlineStateAuthority", "UBR");
        m.put("bootstrapState", "CHECK_IN_RECEIVED");
        m.put("discoveryParadigm", "UBR_CALL_HOME");
        m.put("lastCheckInAt", Instant.now().toString());
        return m;
    }

    private Map<String, Object> genericEvent(String ip) {
        Map<String, Object> m = new HashMap<>();
        m.put("ipAddress", ip);
        m.put("model", "Cisco-2960X");
        m.put("firmwareVersion", "15.2");
        m.put("discoveryParadigm", "GENERIC_SNMP");
        return m;
    }
}

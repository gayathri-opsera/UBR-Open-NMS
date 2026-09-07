package com.ubrnms.inventory.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.inventory.model.Device;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link InventoryMergePolicyService} (WO-032).
 *
 * <p>Validates:
 * <ul>
 *   <li>UBR identity and online-state fields are rejected from generic callers when authority is UBR.</li>
 *   <li>UBR callers may always write all fields.</li>
 *   <li>Untrusted (malformed) paradigm gets only the enrichment allow-list.</li>
 *   <li>Rejected fields are removed from the update map and a structured Kafka audit event is published.</li>
 *   <li>Audit event does not expose secret values (credentialRef, HMAC keys).</li>
 *   <li>buildInventorySyncPayload includes all WO-032 authority metadata fields.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class InventoryMergePolicyServiceTest {

    @Mock
    private KafkaTemplate<String, String> kafkaTemplate;

    private InventoryMergePolicyService service;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @BeforeEach
    void setUp() throws Exception {
        service = new InventoryMergePolicyService(kafkaTemplate, objectMapper);
        // Inject @Value fields via reflection
        setField(service, "auditTopic", "audit-events");
    }

    // ── AC1: UBR call-home updates are always applied ─────────────────────────

    @Test
    void ubrCaller_canOverwriteAnyField() {
        Device existing = ubrDevice("SN-001");
        Map<String, Object> update = new HashMap<>();
        update.put("serialNumber", "SN-001-NEW");
        update.put("macAddress", "00:11:22:33:44:55");
        update.put("bootstrapState", "REALTIME_ESTABLISHED");
        update.put("identityAuthority", "UBR");

        InventoryMergePolicyService.MergePolicyResult result =
            service.evaluateAndFilter(existing, update, "UBR_CALL_HOME", "corr-001");

        assertThat(result.rejectedFields()).isEmpty();
        assertThat(result.hasRejections()).isFalse();
        // All fields remain in the update map
        assertThat(update).containsKey("serialNumber");
        assertThat(update).containsKey("macAddress");
        assertThat(update).containsKey("bootstrapState");
        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    // ── AC2: Generic caller blocked from overwriting UBR-authoritative identity ──

    @Test
    void genericCaller_blockedFromOverwritingUbrIdentityFields() {
        Device existing = ubrDevice("SN-001");
        Map<String, Object> update = new HashMap<>();
        update.put("serialNumber", "SPOOFED");
        update.put("macAddress", "00:00:00:00:00:01");
        update.put("identityAuthority", "GENERIC");
        update.put("bootstrapState", "FAILED");
        update.put("model", "EnrichedModel");  // enrichment — allowed

        InventoryMergePolicyService.MergePolicyResult result =
            service.evaluateAndFilter(existing, update, "GENERIC_SNMP", "corr-002");

        assertThat(result.hasRejections()).isTrue();
        assertThat(result.rejectedFields()).containsExactlyInAnyOrder(
            "serialNumber", "macAddress", "identityAuthority", "bootstrapState"
        );
        // Protected fields removed; enrichment fields remain
        assertThat(update).doesNotContainKey("serialNumber");
        assertThat(update).doesNotContainKey("macAddress");
        assertThat(update).doesNotContainKey("bootstrapState");
        assertThat(update).containsKey("model");
    }

    // ── AC3: Generic caller blocked from overwriting UBR online-state fields ──

    @Test
    void genericCaller_blockedFromOverwritingUbrOnlineStateFields() {
        Device existing = ubrDevice("SN-001");
        Map<String, Object> update = new HashMap<>();
        update.put("lastCheckInAt",  Instant.now().toString());
        update.put("lastRealtimeAt", Instant.now().toString());
        update.put("realtimeConnectionId", "ws-hijack");
        update.put("vendor", "EnrichedVendor");  // allowed

        InventoryMergePolicyService.MergePolicyResult result =
            service.evaluateAndFilter(existing, update, "GENERIC_SNMP", "corr-003");

        assertThat(result.rejectedFields()).contains("lastCheckInAt", "lastRealtimeAt");
        assertThat(update).doesNotContainKey("lastCheckInAt");
        assertThat(update).doesNotContainKey("lastRealtimeAt");
        assertThat(update).containsKey("vendor");
    }

    // ── AC4: Conflicting MAC — rejected with audit event ─────────────────────

    @Test
    void genericCaller_conflictingMac_emitsRejectionAuditEvent() throws Exception {
        Device existing = ubrDevice("SN-001");
        Map<String, Object> update = new HashMap<>();
        update.put("macAddress", "99:88:77:66:55:44");

        service.evaluateAndFilter(existing, update, "GENERIC_SNMP", "corr-mac");

        ArgumentCaptor<String> payloadCaptor = ArgumentCaptor.forClass(String.class);
        verify(kafkaTemplate).send(eq("audit-events"), anyString(), payloadCaptor.capture());

        String payload = payloadCaptor.getValue();
        assertThat(payload).contains("inventory.convergence.overwrite.rejected");
        assertThat(payload).contains("macAddress");
        // Must not expose credential material
        assertThat(payload).doesNotContain("hmacKey");
        assertThat(payload).doesNotContain("credentialRef");
        assertThat(payload).doesNotContain("vault://");
    }

    // ── AC5: No rejection when generic device has no existing UBR authority ───

    @Test
    void genericCaller_noUbrAuthority_allFieldsAllowed() {
        Device existing = new Device(); // no identity authority set
        existing.setIdentityAuthority("GENERIC");
        Map<String, Object> update = new HashMap<>();
        update.put("macAddress", "AA:BB:CC:DD:EE:FF");
        update.put("serialNumber", "SN-GENERIC");
        update.put("vendor", "Cisco");

        InventoryMergePolicyService.MergePolicyResult result =
            service.evaluateAndFilter(existing, update, "GENERIC_SNMP", "corr-004");

        // No UBR authority — nothing should be blocked
        assertThat(result.hasRejections()).isFalse();
        assertThat(update).containsKey("macAddress");
        assertThat(update).containsKey("serialNumber");
        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    // ── AC6: Malformed/untrusted paradigm gets only enrichment allow-list ─────

    @Test
    void untrustedParadigm_limitedToEnrichmentAllowList() {
        Device existing = new Device();
        existing.setIdentityAuthority("GENERIC"); // no UBR protection
        Map<String, Object> update = new HashMap<>();
        update.put("sysObjectID", "1.3.6.1.4.1.9");  // allowed
        update.put("vendor", "Cisco");                 // allowed
        update.put("someArbitraryField", "bad-value"); // not in allow-list

        service.evaluateAndFilter(existing, update, "UNKNOWN_MALFORMED", "corr-005");

        assertThat(update).containsKey("sysObjectID");
        assertThat(update).containsKey("vendor");
        assertThat(update).doesNotContainKey("someArbitraryField");
    }

    // ── AC7: Call-home followed by generic — final state is deterministic ─────

    @Test
    void callHomeFollowedByGeneric_identityFieldsUnchanged() {
        Device device = new Device();
        Map<String, Object> ubrUpdate = Map.of(
            "serialNumber", "SN-DET", "macAddress", "AA:BB:CC:DD:EE:FF",
            "identityAuthority", "UBR", "onlineStateAuthority", "UBR",
            "bootstrapState", "REALTIME_ESTABLISHED"
        );
        // Simulate UBR call-home (no restrictions)
        Map<String, Object> mutable = new HashMap<>(ubrUpdate);
        service.evaluateAndFilter(device, mutable, "UBR_CALL_HOME", "corr-ubr");
        device.setSerialNumber("SN-DET");
        device.setMacAddress("AA:BB:CC:DD:EE:FF");
        device.setIdentityAuthority("UBR");
        device.setOnlineStateAuthority("UBR");

        // Now generic discovery arrives with conflicting identity
        Map<String, Object> genericUpdate = new HashMap<>();
        genericUpdate.put("serialNumber", "SN-DET-GENERIC");
        genericUpdate.put("macAddress", "00:00:00:00:00:99");
        genericUpdate.put("vendor", "Vendor-A");
        genericUpdate.put("sysObjectID", "1.3.6.1.4.1.9");

        service.evaluateAndFilter(device, genericUpdate, "GENERIC_SNMP", "corr-generic");

        // Generic cannot overwrite serial/mac
        assertThat(genericUpdate).doesNotContainKey("serialNumber");
        assertThat(genericUpdate).doesNotContainKey("macAddress");
        // But enrichment fields remain
        assertThat(genericUpdate).containsKey("vendor");
        assertThat(genericUpdate).containsKey("sysObjectID");
    }

    // ── AC8: buildInventorySyncPayload includes all required authority fields ──

    @Test
    void buildInventorySyncPayload_includesAllAuthorityMetadata() {
        Device device = new Device();
        device.setId("dev-001");
        device.setSerialNumber("SN-SYNC");
        device.setDiscoveryParadigm("UBR_CALL_HOME");
        device.setIdentityAuthority("UBR");
        device.setOnlineStateAuthority("UBR");
        device.setBootstrapState("REALTIME_ESTABLISHED");
        device.setLastCheckInAt(Instant.parse("2026-01-01T00:00:00Z"));
        device.setLastRealtimeAt(Instant.parse("2026-01-01T00:05:00Z"));
        device.setSysObjectID("1.3.6.1.4.1.9");
        device.setSchemaVersion("1.0");

        Map<String, Object> payload = service.buildInventorySyncPayload(device);

        // WO-032 required fields
        assertThat(payload).containsKey("discoveryParadigm");
        assertThat(payload).containsKey("identityAuthority");
        assertThat(payload).containsKey("onlineStateAuthority");
        assertThat(payload).containsKey("bootstrapState");
        assertThat(payload).containsKey("lastCheckInAt");
        assertThat(payload).containsKey("lastRealtimeAt");
        assertThat(payload).containsKey("sysObjectID");
        assertThat(payload.get("discoveryParadigm")).isEqualTo("UBR_CALL_HOME");
        assertThat(payload.get("identityAuthority")).isEqualTo("UBR");
        assertThat(payload.get("onlineStateAuthority")).isEqualTo("UBR");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Device ubrDevice(String serial) {
        Device d = new Device();
        d.setId("id-" + serial);
        d.setSerialNumber(serial);
        d.setMacAddress("AA:BB:CC:DD:EE:FF");
        d.setDeviceType("BTS");
        d.setIdentityAuthority("UBR");
        d.setOnlineStateAuthority("UBR");
        d.setBootstrapState("REALTIME_ESTABLISHED");
        d.setDiscoveryParadigm("UBR_CALL_HOME");
        return d;
    }

    private static void setField(Object target, String fieldName, Object value) throws Exception {
        var field = target.getClass().getDeclaredField(fieldName);
        field.setAccessible(true);
        field.set(target, value);
    }
}
